# Database account provisioning

OfficePulse owns the accounts for its `aidacalls_db` schema. Run
`scripts/db-users.sh` as an operator with MySQL admin credentials before starting
the integration. Startup runs `migrateRuntime`; it never creates database users.
This script replaces `deploy/sql/grants.sql` and its host/password placeholders.

| Account | Password/configuration home | Grants on the runtime database |
| --- | --- | --- |
| `aida_runtime` | PlatformConfig, `officepulse` scope: `RUNTIME_MYSQL_USER`, `RUNTIME_MYSQL_PASSWORD`, and the other `RUNTIME_MYSQL_*` connection values | `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER` |
| `aidaadmin_ro` | AidaAdmin's existing `OFFICEPULSE_RUNTIME_DATABASE_URL` (its resolved service configuration) | `SELECT` |

The reader user/password come from that URL; do not create a second reader
password setting. Usernames and passwords are environment inputs, not embedded
secrets. Defaults are `aida_runtime`, `aidacalls_db`, and port 3306; explicit
runtime settings take precedence. The reader's database must match the runtime
database, and both users must differ from each other and the admin account.
Its URL host can differ because applications may use different network paths.
Database names follow the migration guard: `aidacalls_db` or a disposable
`aida_*_test` schema only.

Runtime grants cover DML, table creation/removal and migration 006's `ALTER
TABLE`. Indexes in the released migrations are created inside `CREATE TABLE`,
which needs `CREATE`, not the separate `INDEX` privilege. No migration uses
standalone index DDL, foreign keys, views, routines or triggers. Accordingly,
the runtime receives neither those privileges nor `ALL PRIVILEGES`, global
access or `GRANT OPTION`. Reassess this list when adding migrations.

Export the resolved settings from their existing configuration homes into the
operator's environment, without printing them or putting passwords in shell
history. Supply `MYSQL_ADMIN_USER` (default `root`) and `MYSQL_ADMIN_PASSWORD`
from the environment's administrator secret. For example, use a disposable
client on the database network:

```sh
docker run --rm --network <database-network> \
  -v "$PWD/scripts:/scripts:ro" \
  -e RUNTIME_MYSQL_HOST -e RUNTIME_MYSQL_PORT -e RUNTIME_MYSQL_DATABASE \
  -e RUNTIME_MYSQL_USER -e RUNTIME_MYSQL_PASSWORD \
  -e OFFICEPULSE_RUNTIME_DATABASE_URL -e MYSQL_ADMIN_USER -e MYSQL_ADMIN_PASSWORD \
  mysql:8.4 bash /scripts/db-users.sh
```

`DB_HOST` and `DB_PORT`, when supplied, override only the admin client's network
destination (pass `-e DB_HOST -e DB_PORT` as well). This lets an operator reach
the same server through a tunnel/container-network name without modifying the
application's settings. The script needs Bash and the `mysql` client, not Node.

Every run creates the database/users if missing, applies the supplied passwords
with `ALTER USER`, revokes previous direct privileges/GRANT OPTION, then grants
exactly the list above. Repeating with unchanged secrets is idempotent; changing
the authoritative secret and rerunning rotates the account password. Restart
the consuming application after a rotation. SQL account changes are not
transactional; a failed run exits nonzero and can be rerun after correction.

Both accounts are created at host `%`. Network/firewall/tunnel admission is
environment-owned; PlatformConfig's `trustedCIDR` controls platform trust.
Database grants escape wildcard characters so access cannot spread to similarly
named databases. Passwords go through SQL stdin and the admin password through
`MYSQL_PWD`. Do not run with shell tracing or log the environment/SQL.

## Asterisk PBX accounts

The PBX operator creates `aida_pbx_inventory_ro` and `aida_pbx_provisioner` on
the **Asterisk database server**, using the reviewed table-specific templates
`deploy/sql/pbx-inventory-grants.sql` and
`deploy/sql/pbx-provisioning-grants.sql`. Those templates still require actual
source-host/password substitution and verification of the installed Realtime
schema; they are separate from the platform provisioning script.

Their password homes are PlatformConfig's `officepulse` settings
`PBX_INVENTORY_MYSQL_PASSWORD` and `PBX_PROVISIONING_MYSQL_PASSWORD`, alongside
the corresponding `_USER` settings. Inventory gets only the listed SELECTs;
the writer gets the listed SELECT/INSERT/DELETE grants, with SELECT limited to
`id` on auth/AOR tables. Neither runtime nor reader accounts receive PBX grants.
The script does not alter these PBX accounts or the vendor schema.

## Dev follow-up

The September 22 account migration is already complete: runtime uses
`aida_runtime`, reader uses `aidaadmin_ro`, and `aida_runtime_preview` is removed.
Keep those names. The runtime tunnel is managed by
`officepulse-runtime-tunnel.service`; its network endpoints are deployment
configuration and are not pinned in the script. Re-running provisioning
converges the former runtime `ALL PRIVILEGES` to the narrower migration grants.

## Validation

`npm test` checks input rejection, URL decoding, password escaping and client
failure handling without a database. Set `TEST_DB_USERS_MYSQL_URL` to an admin
URL on a disposable MySQL 8.4 server with an `aida_*_test` path to also verify
fresh/repeated provisioning, all released migrations under the restricted
runtime account, reader write/DDL rejection, wildcard isolation, excess grant
removal and both password rotations. The test creates randomized schemas/users
and cleans them up. CI runs this check against its own MySQL service.
