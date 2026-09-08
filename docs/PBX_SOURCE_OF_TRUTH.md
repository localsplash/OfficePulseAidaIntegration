# PBX source of truth and POC inventory

Asterisk/OfficePulse owns extension endpoint configuration, queues and their members, trunks, registrations, and the effective PBX dialplan. AidaAdmin owns business administration: Identity users/tenants/roles, business numbers, AI profiles and business associations to PBX objects. AidaAdmin reads PBX inventory through this service; it must not copy desired extension or queue records into NocoDB and track their movement to MySQL. A tenant-to-PBX reference is authorization metadata, not another PBX configuration store.

OfficePulseAidaIntegration owns the PBX integration API and the future small operations UI. A separate AidaOfficePbxAdmin application is unnecessary. The operations UI still needs authenticated operator sessions and role checks before health/registrations, trunks, diagnostic logs and restricted maintenance are exposed to a browser. The existing private API CIDR boundary authenticates a service location, not a human. AidaHandset/AidaAgent changes are deferred. Deprecated AidaControl and the infrastructure-instructions repository are not implementation dependencies.

## What the current API reads

Private `GET /v1/admin/pbx/extensions?iTenantId=1` returns:

```json
{"source":"asterisk","iTenantId":1,"extensions":[{"id":"sip-101","context":"business-one","callerId":"Alice","transport":"transport-udp","aors":"aor-101"}]}
```

These are PJSIP endpoint configuration records. `id` is the native endpoint ID; it is not necessarily a dialable extension number. Context is the endpoint's dialplan context, not proof that an arbitrary destination is dialable. Nullable text fields are returned as `null`; no credentials, `ps_auths` or credential references are selected.

Private `GET /v1/admin/pbx/queues?iTenantId=1` returns:

```json
{"source":"asterisk","iTenantId":1,"queues":[{"id":"support-one","name":"support-one","strategy":"rrmemory","members":[{"interface":"Local/101@business-one","memberName":"Alice","penalty":0,"paused":false}]}]}
```

Queue IDs are native queue names. Members keep their native interface strings, including `Local/` channels. `strategy` and `memberName` are nullable; `penalty` is numeric and `paused` is the persisted Boolean setting. These are real queues, not the old simultaneous `Dial(PJSIP/a&PJSIP/b)` ring-group implementation.

Both routes require a single positive safe integer `iTenantId`, private service network admission and an explicit server-side scope. AidaAdmin must authorize the logged-in actor for that tenant before calling; neither the query parameter nor a browser-forwarded header is authentication. Invalid IDs return 422. Disabled/unmapped inventory, missing configured queues, missing tables/grants, database failures and over-limit reads return 503 with `error: "pbx_inventory_unavailable"`. The API never fabricates empty success for these failures. An explicitly configured empty slice returns an empty list. Results are bounded to 1,000 endpoints or members; larger deployments need pagination before enabling this POC API.

## Configuration and database access

Settings follow the implemented environment → `officepulse` → `aida` → `*` precedence in `PlatformConfig.cfg_tbl_Setting`. Inventory is disabled by default. Set:

```text
PBX_INVENTORY_ENABLED=true
MYSQL_HOST=<OfficePulse MySQL host>
MYSQL_PORT=3306
MYSQL_DATABASE=asterisk
PBX_INVENTORY_MYSQL_USER=aida_pbx_inventory_ro
PBX_INVENTORY_MYSQL_PASSWORD=<read-only account password>
PBX_INVENTORY_TENANTS_JSON={"1":{"contexts":["business-one"],"queueNames":["support-one"]}}
```

Inventory does not require LiveKit or Agent setup. The canonical development service uses `VOICE_ENABLED=false`; inventory is independent of voice connectors. The separate account needs SELECT on `ps_endpoints`, `queues`, and `queue_members` only; see `deploy/sql/pbx-inventory-grants.sql`. There are no application-owned changes to those vendor tables. Startup never creates queue tables or changes Asterisk mappings.

An operator must verify each context contains only endpoint records belonging to that business, and each queue belongs to that business. Do not map a shared default context or a trunk context. Names are bound SQL parameters with exact binary matching. Startup rejects contexts or queue names assigned to multiple tenants, including case variants. Ownership must not be inferred from a number prefix, a queue's exit context, or the presence of one tenant's member. If the installed PBX cannot be separated by these verified references, leave inventory disabled until a suitable adapter is implemented.

## Asterisk-specific limits

The supplied OfficePulse host runbook confirms Asterisk 22.10.1 with MariaDB
realtime endpoint, queue and queue-member tables in `asterisk`, accessed on the
PBX host by local socket/localhost. The context and queue-name scopes above fit
that layout once an operator maps them to actual canonical Identity tenant IDs.
Queue membership is read exactly as stored; an endpoint intentionally omitted
from a queue must stay omitted.

That host also uses file-owned `extensions.conf` routing and PJSIP wizard trunks.
The inventory is not an inventory of every trunk or DID route. Keep those files
under PBX ownership; do not overwrite them with legacy generated realtime rows.
Apache currently serves authenticated phone provisioning over TLS on TCP 80,
while TCP 443 is SIP TLS. Neither is a ready-made browser/API ingress. Deploy
this service beside the PBX database or use an explicitly reviewed private path;
do not open MariaDB publicly or replace the existing listeners.

Native call records are written to `asterisk.cdr` in UTC by adaptive ODBC, while
`aidacalls_db` records this integration's own call orchestration. They are distinct
data sets. Recording basenames are associated through CDR `userfield`. The
runbook contains both `calldate` and `start` examples, so verify the installed
CDR columns and a reliable tenant/call association before adding a CDR API or
view. A filename prefix or phone number alone is not authorization. A future
recording endpoint must validate the CDR-to-tenant association and controlled
basename, then serve media through authenticated access; never expose the raw
recording directory or phone-provisioning files. No native CDR or recording API
is included in this inventory change.

[PJSIP Realtime and Sorcery](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Setting-up-PJSIP-Realtime/) permit database and static sources. The POC adapter reads the vendor [queue schema](https://github.com/asterisk/asterisk/blob/22/contrib/ast-db-manage/config/versions/28887f25a46f_create_queue_tables.py): `queues(name,strategy)` and `queue_members(queue_name,interface,membername,penalty,paused)`. The deployed `extconfig.conf` may map another table, or queues may be static; verify the installed mapping first using the [Asterisk mapping reference](https://github.com/asterisk/asterisk/blob/22/configs/samples/extconfig.conf.sample). This adapter only supports those verified realtime tables, and does not claim to inventory static/dynamically added members.

SQL configuration is not running Asterisk state. Runtime registrations, device status, dynamic membership and queue statistics require Asterisk interfaces such as [PJSIPShowEndpoints](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/PJSIPShowEndpoints/) and [QueueStatus](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/QueueStatus/). [Sorcery caching](https://docs.asterisk.org/Fundamentals/Asterisk-Configuration/Sorcery/Sorcery-Caching/) also means a database write is not proof that a change is active. Future supported OfficePulse commands must validate effective state without creating an AidaAdmin synchronization workflow.

## Canonical development cleanup and remaining work

The historical extension/ring-group/DID/handset provisioning routes are removed.
There is no compatibility flag. Their concrete NocoDB desired-state repository
and runtime projection/fallback accessors are deleted; only `provisioning_operation`
and `did_fallback` are dropped by the canonical Dev migration. Device tables and
reusable device/runtime modules remain. See [DEV_CLEANUP.md](DEV_CLEANUP.md).

ARI reconciliation, signed LiveKit callbacks, FastAGI protocol and call commands
remain. Native queue admission needs verified PBX destinations: canonical bootstrap
preserves the PBX's fallback, TAKEOVER returns 503 before claiming a command, and
DRAIN_ACK remains supported with voice enabled. Canonical device routes are unwired
until native PBX authorization exists. No runtime reader of the deleted NocoDB
graph remains. Current inventory does not create extensions, queues or phone files.

Issue [#2](https://github.com/localsplash/OfficePulseAidaIntegration/issues/2) tracks that remaining command/routing work and the authenticated operations UI. Issue [#7](https://github.com/localsplash/OfficePulseAidaIntegration/issues/7) tracks installed schema/mapping/read-grant validation, two-tenant API checks, runtime/queue observations and real-call acceptance alongside [AidaAdmin #29](https://github.com/localsplash/AidaAdmin/issues/29). PlatformConfig implementation completion in [#10](https://github.com/localsplash/OfficePulseAidaIntegration/issues/10) is independent of that deployment evidence.

Run `npm run verify` and `npm run build` under Node 22. `TEST_PBX_MYSQL_URL` enables the disposable inventory/grant test and requires an `aida_pbx_inventory_*_test` database name. It creates synthetic tables and a test-only SELECT account, verifies case-sensitive tenant isolation and forbidden secret reads/writes, then removes its fixtures. Never run it against the installed PBX.
