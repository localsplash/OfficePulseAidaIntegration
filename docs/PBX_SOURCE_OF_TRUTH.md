# PBX source of truth and POC inventory

Asterisk/OfficePulse owns extension endpoint configuration, queues and their members, trunks, registrations, and the effective PBX dialplan. AidaAdmin owns business administration and may read inventory or invoke the opt-in POC writer through this service; it must not copy desired extension or queue records into NocoDB. The routing scope of every PBX object and call is `{pbxInstanceId, context}`: the serving PBX instance (`OFFICEPULSE_INSTANCE_ID`) and the Asterisk extension context. The same context name on another PBX instance is a different scope. Tenant identity stays in Identity/AidaAdmin for authorization; it is not a routing key, and OfficePulse keeps no tenant-to-PBX map.

OfficePulseAidaIntegration owns the PBX integration API and the authenticated operations UI. A separate AidaOfficePbxAdmin application is unnecessary. The Operations gateway revalidates Identity Super Admin sessions, context grammar, tenant-based call authorization and mutation CSRF. The existing private API CIDR boundary authenticates a service location, not a human. AidaHandset/AidaAgent changes are deferred. Deprecated AidaControl and the infrastructure-instructions repository are not implementation dependencies.

## What the current API reads

Private `GET /v1/admin/pbx/contexts` returns the distinct Asterisk contexts present in `ps_endpoints` and `extensions` (sorted, case-sensitive, at most 1,000):

```json
{"source":"asterisk","pbxInstanceId":"officepulse-dev","contexts":["business-one","from-bandwidth"]}
```

Listing a context grants nothing; it feeds AidaAdmin's tenant form and the Operations context selector.

Private `GET /v1/admin/pbx/extensions?context=business-one` returns:

```json
{"source":"asterisk","pbxInstanceId":"officepulse-dev","context":"business-one","provisioningEnabled":false,"contexts":["business-one"],"extensions":[{"id":"101-business-one","extension":"101","context":"business-one","callerId":"Alice","transport":"transport-udp","aors":"101-business-one","managed":true,"applyState":"unknown"}]}
```

These are the PJSIP endpoint configuration records whose `context` is exactly the requested one (`ps_endpoints WHERE BINARY context = ?`). `id` is the native endpoint ID. `extension` is the dialable number derived from the managed route in that context (`extensions(context, exten, priority 1 Dial(PJSIP/<id>,20); priority 2 Hangup)`), and `managed` is true only when that route exists. An imported endpoint without a managed route is `managed:false`; its `extension` falls back to the digits of a legacy `<digits>-t<N>` or pure-digit ID, otherwise `null`. Nullable text fields are returned as `null`; no credentials, `ps_auths` or credential references are selected.

Private `GET /v1/admin/pbx/queues?context=business-one` returns:

```json
{"source":"asterisk","pbxInstanceId":"officepulse-dev","context":"business-one","provisioningEnabled":false,"queues":[{"id":"support-one","name":"support-one","strategy":"rrmemory","applyState":"unknown","members":[{"interface":"Local/101@business-one","memberName":"Alice","penalty":0,"paused":false}]}]}
```

A queue is owned by the context holding its exact versioned ownership marker (`extensions(context, exten=__aida_queue_<sha256(name)[0:27]>, priority 1, NoOp(OfficePulse:queue:v1:<name>))`). Exactly one marker row may exist per queue: the same marker in more than one context is ambiguous and the queue is then owned by nobody, so it is omitted here and refused by every mutation. There is no queue allowlist; legacy queues are adopted with `npm run pbx:adopt-queue` (below). Queue IDs are native queue names. Members keep their native interface strings, including `Local/` channels. `strategy` and `memberName` are nullable; `penalty` is numeric and `paused` is the persisted Boolean setting. These are real queues, not the old simultaneous `Dial(PJSIP/a&PJSIP/b)` ring-group implementation.

Every `/v1/admin/pbx/*` route except `/contexts` requires exactly one `context` query value matching `^[a-zA-Z0-9_.-]{1,40}$` (otherwise 422 `context must be exactly one Asterisk context name`). The retired `iTenantId` parameter is refused with 422 `iTenantId is retired; supply context`. Private service network admission remains mandatory. AidaAdmin must authorize the logged-in actor for the tenant and resolve that tenant's contexts before calling; neither the query parameter nor a browser-forwarded header is authentication. Managed-DID requests also carry `didContext` (the carrier ingress context, distinct from the extension context) and the current globally unique Identity assignments as repeatable `authorizedDid` values from the trusted AidaAdmin backend. Disabled inventory, missing tables/grants, database failures and over-limit reads return 503 with `error: "pbx_inventory_unavailable"`. A queue whose marker exists but whose row has not yet been created (or was deleted) is omitted normally. Results are bounded to 1,000 endpoints or members; larger deployments need pagination before enabling this POC API.

## Configuration and database access

Settings follow the implemented environment → `officepulse` → `aida` → `*` precedence in `PlatformConfig.cfg_tbl_Setting`. Inventory is disabled by default. Set:

```text
PBX_INVENTORY_ENABLED=true
MYSQL_HOST=<OfficePulse MySQL host>
MYSQL_PORT=3306
MYSQL_DATABASE=asterisk
PBX_INVENTORY_MYSQL_USER=aida_pbx_inventory_ro
PBX_INVENTORY_MYSQL_PASSWORD=<read-only account password>
OFFICEPULSE_INSTANCE_ID=<PBX instance name, e.g. officepulse-dev>
```

`PBX_INVENTORY_TENANTS_JSON` is retired: a nonblank value fails startup with `PBX_INVENTORY_TENANTS_JSON is retired: PBX scope is the Asterisk context. See docs/PBX_SOURCE_OF_TRUTH.md (Migrating from tenant maps)`.

Inventory does not require LiveKit or Agent setup. The canonical development service uses `VOICE_ENABLED=false`; inventory is independent of voice connectors. The separate account needs SELECT on `ps_endpoints`, `queues`, and `queue_members`, plus `extensions` for the context listing, managed extension routes and exact queue ownership markers, including when writes are disabled; see `deploy/sql/pbx-inventory-grants.sql`. Inventory itself never writes. The separately enabled POC writer follows [PBX_PROVISIONING.md](PBX_PROVISIONING.md). Startup never creates queue tables or changes Asterisk mappings.

Ownership is derived from Asterisk's own records, never from a copied map: an endpoint belongs to the context of its `ps_endpoints` row, a dialable extension to the context holding its managed Dial route, a queue to the single context holding its ownership marker, and a managed DID to the context owning the queue its route names. An operator must still verify each extension context contains only endpoint records belonging to one business before AidaAdmin assigns that context to a tenant. Do not assign a shared default context, a trunk context or the carrier ingress context as an extension context. Names are bound SQL parameters with exact binary matching; AidaAdmin refuses one extension context on two tenants. Ownership must not be inferred from a number prefix, a queue's exit context, or the presence of one business's member. If the installed PBX cannot be separated by these references, leave inventory disabled until a suitable adapter is implemented.

## Asterisk-specific limits

The supplied OfficePulse host runbook confirms Asterisk 22.10.1 with MariaDB
realtime endpoint, queue and queue-member tables in `asterisk`, accessed on the
PBX host by local socket/localhost. The context scopes above fit that layout once
AidaAdmin's TenantProfile names each business's extension context(s) and DID
ingress context.
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

Managed DID destinations belong in the mapped `asterisk.extensions` table. Identity owns the unique number-to-tenant assignment; OfficePulse does not copy that registry into environment settings or NocoDB. The carrier ingress context needs one operator-owned generic Realtime lookup so Asterisk consults those rows, but it must not contain DID-specific `Goto` rules or dedicated per-DID contexts. OfficePulse constrains values to the installed 40-character columns and never migrates the vendor schema.

## Migrating from tenant maps

`PBX_INVENTORY_TENANTS_JSON` and `AGENT_PROFILE_IDS_JSON` are retired (#22/#23). OfficePulse refuses to start while either is set, so migrate each entry first:

1. For every `PBX_INVENTORY_TENANTS_JSON` entry `"<iTenantId>": {"contexts": [...], "queueNames": [...], "didContext": "..."}`, open that tenant in AidaAdmin's Tenants screen and set its primary Asterisk context to `contexts[0]`, any further entries as additional contexts, and `didContext` as the tenant's DID ingress context. AidaAdmin authorizes browser requests against those contexts; OfficePulse itself no longer stores the tenant.
2. For every former `queueNames` entry, adopt the legacy queue into the extension context that owns it: `npm run pbx:adopt-queue -- <context> <queue>` prints a review query and the exact `INSERT INTO extensions (...)` ownership-marker statement. It performs no database access and exits 2 on bad input. Confirm the review query returns no rows, then apply the statement with an operator account. A marker that ends up in two contexts makes the queue ambiguous and owned by nobody. Queues created through the API already carry their marker.
3. For every `AGENT_PROFILE_IDS_JSON` entry `"<iTenantId>": "<profileId>"`, create a context-default assignment through AidaAdmin (Profiles screen, "Default profile for context") for each of that tenant's extension contexts. This writes a `aida_tbl_ProfileAssignment` row with `pbx_instance_id` = this service's `OFFICEPULSE_INSTANCE_ID`, `context`, an empty `did`, the `profile_id` and `enabled`. DID-specific assignments (Numbers screen) override the context default for one E.164. Tenants that previously relied on "exactly one enabled profile" also need an explicit assignment: without one, callers stay on the PBX queue.
4. Remove both settings from the process environment and from every `*`/`aida`/`officepulse` PlatformConfig row, then restart. Existing endpoint IDs (`<extension>-t<N>`), legacy queue names and managed DID rows are preserved; nothing is renamed. New endpoints are `<extension>-<context>` and new queues `<context>.<slug>`.

Assignments take effect at the next background refresh (`AGENT_CONFIG_REFRESH_SECONDS`), without a restart; calls already admitted keep their snapshot. Live PBX/LiveKit acceptance of this migration has not been exercised; unit, HTTP and shared-fixture tests are the only evidence.

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
graph remains. Inventory GET routes do not create extensions, queues or phone files.
The opt-in `/v1/admin/pbx` writer provides only the smaller POC surface documented separately.

Issue [#2](https://github.com/localsplash/OfficePulseAidaIntegration/issues/2) tracks remaining native command/routing work. Issue [#7](https://github.com/localsplash/OfficePulseAidaIntegration/issues/7) tracks installed schema/mapping/read-grant validation, two-tenant API checks, runtime/queue observations and real-call acceptance alongside [AidaAdmin #29](https://github.com/localsplash/AidaAdmin/issues/29). PlatformConfig implementation completion in [#10](https://github.com/localsplash/OfficePulseAidaIntegration/issues/10) is independent of that deployment evidence.

Run `npm run verify` and `npm run build` under Node 22. `TEST_PBX_MYSQL_URL` enables the disposable inventory/grant test and requires an `aida_pbx_inventory_*_test` database name. It creates synthetic tables and a test-only SELECT account, verifies case-sensitive context isolation, marker-derived queue ownership and forbidden secret reads/writes, then removes its fixtures. Never run it against the installed PBX.
