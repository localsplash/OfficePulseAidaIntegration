# Database account provisioning

OfficePulse owns the accounts for its `aidacalls_db` schema. Run
`scripts/db-users.sh` as an operator with MySQL admin credentials before starting
the integration. Startup runs `migrateRuntime`; it never creates database users.
This script replaces `deploy/sql/grants.sql` and its host/password placeholders.

| Account | Password/configuration home | Grants on the runtime database |
| --- | --- | --- |
| `aida_runtime` | PlatformConfig, `app=officepulse`: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER` |
| `aidaadmin_ro` | PlatformConfig, `app=aida-admin-runtime`: the same `DB_*` setting keys, with a distinct reader user/password | `SELECT` |

AidaPlatformDB's database/app setup seeds both scopes and invokes this script
with those exact values. No database URL setting is read. Passwords are literal,
not URL-encoded; the optional `DB_PORT` defaults to 3306. Production requires
`DB_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` in the `officepulse` scope.
Shared `aida` / `*` credentials cannot supply runtime database settings.

The script receives the writer's `DB_*` values directly. The second connection's
`DB_NAME`, `DB_USER` and `DB_PASSWORD` are passed as `READER_DB_NAME`,
`READER_DB_USER`, and `READER_DB_PASSWORD` to distinguish the two accounts during
one invocation. These are **operator-script adapter inputs**, not additional
PlatformConfig setting keys. Reader and writer database names must match; their
users must differ from one another and the operator. Reader host/port may differ
from the writer's because the applications can use separate network paths.
Database names remain `aidacalls_db` or disposable `aida_*_test` schemas only.

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
docker run --rm --network <network> -v "$PWD/scripts:/scripts:ro" \
  -e DB_HOST -e DB_PORT -e DB_NAME -e DB_USER -e DB_PASSWORD \
  -e READER_DB_NAME -e READER_DB_USER -e READER_DB_PASSWORD \
  -e MYSQL_ADMIN_USER -e MYSQL_ADMIN_PASSWORD \
  mysql:8.4 bash /scripts/db-users.sh
```

`MYSQL_ADMIN_HOST` and `MYSQL_ADMIN_PORT`, when supplied, override only the admin
client's destination (pass those environment variables to the container too).
This permits a tunnel/container-network name without changing app settings.
The script needs Bash and the `mysql` client, not Node.

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

`npm test` checks input rejection, literal password preservation, password escaping and client
failure handling without a database. Set `TEST_DB_USERS_MYSQL_URL` to an admin
URL on a disposable MySQL 8.4 server with an `aida_*_test` path to also verify
fresh/repeated provisioning, all released migrations under the restricted
runtime account, reader write/DDL rejection, wildcard isolation, excess grant
removal and both password rotations. The test creates randomized schemas/users
and cleans them up. CI runs this check against its own MySQL service.
