# Renaming the runtime database to `aida_pbx_db`

Environments created before October 2026 keep AidaPbx's runtime state in
`aidacalls_db`, written by the account `aida_runtime`. The current names are
`aida_pbx_db` and `aida_pbx_app`. This release accepts both names, so an
environment keeps working until it is renamed; renaming is a one-time step per
environment.

MySQL cannot rename a database, so [`scripts/rename-database.sh`](../scripts/rename-database.sh)
creates `aida_pbx_db`, moves every table with a single `RENAME TABLE` (metadata
only, no data copied, all tables or none), drops the empty `aidacalls_db`,
renames the account with `RENAME USER` (the password is kept) and re-grants it
on the new database. It refuses to start while anything is connected to the old
database or as the old account, when both databases hold tables, or when the old
database has views, triggers, routines or events. Rerunning after success
changes nothing.

## Per-environment runbook

Run in this order. Calls through AidaPbx stop between steps 2 and 4, which take
a minute or two; pick a quiet time.

1. **Deploy this release** (code that accepts both names). On the PBX host, from
   the AidaPlatformDB folder on `main`: `./install.sh officepulse`. (The
   installer updates its own checkout first, so the DB host's copy picks up the
   `rename-pbx-database` phase by itself in step 3.)
2. **Stop AidaPbx** on the PBX host: `sudo systemctl stop aida-integration`.
3. **Rename** on the DB host, from the AidaPlatformDB folder:
   `./install.sh rename-pbx-database`. It reads the MySQL root password and the
   NocoDB installer token from that folder's `.env` (or asks), runs the script
   above against `platform-mysql-local`, then sets PlatformConfig `aida-pbx`
   `DB_NAME=aida_pbx_db` and `DB_USER=aida_pbx_app`. `DB_PASSWORD` is unchanged.
4. **Start AidaPbx**: `sudo systemctl start aida-integration`, then check
   `journalctl -u aida-integration -n 50` shows it connected and migrated, and
   that AidaAdmin's Calls, Dependencies and Issues screens load.

If step 3 stops with "connection(s) still use", something still holds the old
login (the service, a tunnel session, an operator's client): stop it and rerun.
If it fails after the tables moved, rerun it; each part is skipped once done.

Expected result in MySQL: database `aida_pbx_db`, no `aidacalls_db`; logins
`aida_admin_app` and `aida_pbx_app` (no `aida_runtime`).

## Rollback

Stop AidaPbx, then run the script with the names swapped and restore the
settings:

```sh
./install.sh rename-pbx-database --rollback
```

and start AidaPbx again. Rolling back is only needed if this release itself is
rolled back, since older releases accept only `aidacalls_db`.

## Running the script by hand

Without the installer, from an AidaPbx checkout on the database network
(`MYSQL_ADMIN_PASSWORD` from the environment's admin secret; never print it):

```sh
docker run --rm --network <network> -v "$PWD/scripts:/scripts:ro" \
  -e MYSQL_ADMIN_HOST=<mysql host> -e MYSQL_ADMIN_PASSWORD \
  mysql:8.4 bash /scripts/rename-database.sh
```

`FROM_DB`, `TO_DB`, `FROM_USER` and `TO_USER` override the defaults
(`aidacalls_db`, `aida_pbx_db`, `aida_runtime`, `aida_pbx_app`). Then set the
`aida-pbx` `DB_NAME` and `DB_USER` settings in PlatformConfig before starting
AidaPbx.
