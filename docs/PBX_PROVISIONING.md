# Native PBX provisioning and managed DID routing

OfficePulse writes the six installed Asterisk Realtime tables transactionally. Asterisk remains authoritative. There is no NocoDB desired-state graph, runtime configuration-file writer, operation/retry ledger, or per-call Node dependency. AidaAdmin uses this contract from its authenticated backend.

## Enablement and ownership

Set `PBX_PROVISIONING_ENABLED=true` plus dedicated `PBX_PROVISIONING_MYSQL_USER` and `PBX_PROVISIONING_MYSQL_PASSWORD`. Database coordinates use `MYSQL_HOST`, `MYSQL_PORT`, and `MYSQL_DATABASE`. The writer account must differ from runtime and inventory accounts. Without the flag and credentials, mutation routes are absent. Enable `PBX_INVENTORY_ENABLED=true` with its separate SELECT account for the administration UI.

Apply `deploy/sql/pbx-provisioning-grants.sql` manually after reviewing the installed schema. It allows only SELECT/INSERT/DELETE on the required tables, with SELECT limited to `id` on auth/AOR tables; even the writer cannot retrieve existing SIP passwords. There are no application startup PBX migrations, UPDATE, DDL or unrelated-table grants. Inventory also needs SELECT on `extensions` to list contexts, derive dialable numbers from managed routes and recognize queue ownership markers, including when writes are disabled for rollback.

All six tables must use InnoDB. Require primary/unique endpoint, auth and AOR IDs, unique queue names, and unique `(context,exten,priority)` dialplan rows. The representative schema in `test/mysqlPbxProvisioning.test.ts` uses the installed shapes, including 40-character dialplan extensions, contexts and endpoint caller IDs, plus endpoint `outbound_auth` and member `state_interface` for safe deletion checks. Generated ownership markers are exactly 40 characters, and formatted caller IDs are rejected before they exceed 40. No Asterisk vendor schema change is required or permitted by the application. Large installations exceeding 1,000 inventory rows require pagination before adoption.

The routing scope is `{pbxInstanceId, context}`. Every route names one Asterisk extension context; DID routes also name the carrier ingress context (`didContext`, e.g. `from-bandwidth`), which is shared by many businesses and must differ from the extension context. AidaAdmin stores each tenant's extension context(s) and DID ingress context in its TenantProfile and authorizes browser requests against them; OfficePulse keeps no tenant map (`PBX_INVENTORY_TENANTS_JSON` is retired; see [Migrating from tenant maps](PBX_SOURCE_OF_TRUTH.md#migrating-from-tenant-maps)). Identity owns the globally unique E.164 assignment and AidaAdmin supplies its freshly authorized Numbers as repeatable `authorizedDid` query parameters. Adding a Number therefore requires no OfficePulse configuration change. Never use a shared/default endpoint context, a trunk context or the ingress context as an extension context.

Created endpoint/auth/AOR IDs are `<extension>-<context>` (422 when longer than the installed 40 characters); dialable numbers stay in that context as managed `Dial(PJSIP/<id>,20)`/`Hangup` rows. Created queue IDs are `<context>.<slug>` (friendly slug at most 60 characters, whole ID at most 80), except the exact name of a legacy queue the context already owns through its marker (`concierge`). Prefixes alone never authorize a pre-existing queue. Creation stores an exact versioned ownership marker in the requested context: extension `__aida_queue_` plus the first 27 hex characters of SHA-256(native queue ID), priority 1, `NoOp(OfficePulse:queue:v1:<native queue ID>)`. The complete marker is 40 characters and contains ownership only, not a copied queue configuration.

Imported endpoints remain visible with `managed:false`. Extension deletion and queue membership resolve the endpoint from the context's managed Dial route for that extension number, so legacy `<extension>-t<N>` bundles keep working and an extension without a managed route in the context is 404 `Extension was not found in this context`; AidaAdmin marks imported endpoints and other member interfaces as operator managed. Deletion refuses altered/manual dialplan or shared auth/AOR bundles and remaining external dialplan/state-interface references. It removes owned saved memberships atomically.

## Private contract

Every route requires exactly one `context` query value (422 `context must be exactly one Asterisk context name`); a supplied `iTenantId` is 422 `iTenantId is retired; supply context`. DID routes additionally require exactly one `didContext` that differs from `context` (422 `didContext must be the inbound ingress context, not the extension context`). A body `context`, when present, must equal the query. Private CIDR admission remains mandatory. Extension and queue routes are also available through the authenticated Operations gateway (Super Admin) with context grammar validation and CSRF. DID routes accept a trusted Identity assertion from the AidaAdmin backend and are not exposed through that browser gateway. No route is exposed by the public health/webhook listener. Use the published `/openapi.json` for the full schema.

| Method | Path under `/v1/admin/pbx` | Result |
| --- | --- | --- |
| GET | `/contexts` | `{source, pbxInstanceId, contexts}`: distinct native contexts; no `context` parameter |
| GET | `/extensions`, `/queues` | Native inventory of one context: `source`, `pbxInstanceId`, `context`, `provisioningEnabled`; extensions include `contexts:[context]` and per-item `managed` |
| POST | `/extensions` | `{extension,displayName?,callerIdNumber?,context?}` → one-time `sipUsername`, `sipSecret`, `applyState` |
| DELETE | `/extensions/:extension` | Delete the bundle dialed by this context's managed route, with saved memberships; 204 |
| POST | `/queues` | `{name,strategy?}` → native `name`, `strategy`, `applyState` |
| DELETE | `/queues/:queue` | Delete queue/members; 409 while referenced by a DID |
| PUT | `/queues/:queue/extensions/:extension` | Idempotent `{penalty?:0..100,paused?:boolean,context?}` |
| DELETE | `/queues/:queue/extensions/:extension` | Delete owned saved membership; absent returns 404 |
| GET | `/dids` | Adds `didContext`; managed settings for routes whose queue this context owns, else explicit `manual` (unrecognized rows, or a route owned by another context) / `unconfigured` entries for Identity-authorized DIDs |
| PUT | `/dids/:did` | Set a route in `didContext` to a queue this context owns (404 otherwise); 409 for manual rows or a route owned by another context |
| DELETE | `/dids/:did` | Delete recognized managed rows owned by this context only (409 manual/foreign, 404 absent); retain Identity/carrier number |

Encode all path components, especially `+19496501147` as `%2B19496501147`. Bodies reject unknown fields. Extension numbers are 2–12 digits; caller-ID numbers must be E.164. Contexts fit the installed 40-character columns. Display names are at most 33 characters without controls, quotes, angle brackets or backslashes, and the complete formatted caller ID must fit the installed 40-character column. Transport/codec POC defaults are `transport-udp` and `ulaw,alaw`. SIP secrets are generated with 32 random bytes and returned only after commit. Duplicate requests return conflict and cannot retrieve a previous secret. Responses are `Cache-Control: no-store`.

Queue strategies: `ringall` (default), `leastrecent`, `fewestcalls`, `random`, `rrmemory`, `linear`, `wrandom`. Destructive absent and other-context object lookups return the same 404. Invalid/out-of-scope input (including a missing or duplicate `context`, the retired `iTenantId`, `didContext` equal to `context`, and IDs over the installed limits) returns 422, duplicates/reference/manual-route/foreign-route conflicts 409, and database/schema/grant errors a redacted 503. Clients must refresh after ambiguous failures; there is no secret replay or retry ledger.

```json
{
  "queue": "concierge",
  "ringsBeforeAi": 6,
  "schedule": {"timeRange":"09:00-17:00","weekdays":"mon-fri","timezone":"America/Los_Angeles"},
  "livekitDestination": "+19496501147"
}
```

`ringsBeforeAi` is an integer 1–12. The response returns `ringTimeoutSeconds = ringsBeforeAi * 5`, an explicit POC approximation. Omit/null `schedule` for an always-open queue. Otherwise supply valid `HH:MM-HH:MM`, Asterisk day names/ranges joined with `&`, and an IANA timezone (including `UTC`). Weekdays normalize to an ordered unique day list. The LiveKit destination defaults to the DID. Provider fields are unsupported; the installed endpoint is always `livekit`.

Managed DIDs consist of exactly three deterministic rows: versioned `NoOp` marker, validated six-argument `Gosub(aida-managed-did-v1,s,1(...))`, and `Hangup`. GET recognizes the whole canonical sequence; it never parses arbitrary operator dialplan into settings. Unknown/modified rows are reported as manual and cannot be overwritten or deleted through this API. The queue row lock serializes DID reference creation against queue deletion.

## One-time operator installation

The application does not perform this installation or claim it was completed:

1. Review and merge `asterisk/extconfig.conf.template`: map `ps_endpoints`, `ps_auths`, `ps_aors`, `extensions`, `queues`, and `queue_members` through the installed driver. Configure PJSIP Sorcery Realtime sources as required by the installed Asterisk version. Verify all tables and grants using separate least-privilege Asterisk and integration accounts.
2. Install versioned `asterisk/extensions_aida.conf` once and include it once from operator-owned `extensions.conf`. Confirm the `aida-managed-did-v1` context and `GotoIfTime`, `Queue`, `Dial`, `Gosub`, `REGEX`, `DIALPLAN_EXISTS`, `STAT`, and CDR functions are available. Keep timezone data installed under `/usr/share/zoneinfo`.
3. Configure the existing `[from-bandwidth]` ingress context to consult the mapped `extensions` Realtime family once. This generic Realtime switch is transport plumbing; it must contain no DID-specific destinations. Move managed DID routes out of static configuration so each DID's exact destination, queue, schedule and fallback live only in `asterisk.extensions`. Do not add a dedicated context or `Goto` exception for an individual DID.
4. Set the tenant's DID ingress context to `from-bandwidth` in AidaAdmin's Tenants screen, alongside its extension context(s); adopt any legacy queue with `npm run pbx:adopt-queue -- <context> <queue>`. Create the globally unique Number assignment in Identity through AidaAdmin; AidaAdmin authorizes it dynamically when reading or writing the route. Remove the old DID-specific static route only after its equivalent managed rows exist in `asterisk.extensions`; the database rows then remain the sole source for that DID's handling.
5. Preserve recording through an operator-owned `officepulse-recording` subroutine. The managed include passes purpose as `ARG1` and the validated owned queue as `ARG2`; adapt existing tenant recording routines using an exact reviewed queue mapping, set `__OFFICEPULSE_RECORDING_STARTED=1`, and return. The managed include skips this hook when that flag, `MIXMONITOR_FILENAME`, or `CDR(userfield)` already identifies a recording. Existing Concierge/LocalSplash hooks differ; verify recording start and CDR association for each tenant before cutover.
6. Use the operator's scoped validation/reload/cache-expiry procedure. The API does not issue reload commands. After reload, `dialplan show +19496501147@from-bandwidth` must resolve from Realtime without any DID-specific static `Goto` or destination. Inspect that DID's three managed rows, `queue show concierge`, and `pjsip show endpoint livekit`. Trace a controlled call through the versioned subroutine; configuration listings alone cannot prove the winning route or a successful call.

The shared subroutine evaluates schedules locally. Inside the window (or without a schedule), it queues for the ring budget. A queue answer ends the call flow without AI continuation. Timeout, missing/unavailable/empty/full queue falls through once to `Dial(PJSIP/<destination>@livekit,60)`. Outside the schedule it goes straight to LiveKit. A missing/unavailable LiveKit endpoint ends the call; malformed arguments hang up with cause 21. There is no loop or external AGI requirement.

References: [Realtime families and switch](https://docs.asterisk.org/Fundamentals/Asterisk-Configuration/Database-Support-Configuration/Realtime-Database-Configuration/), [Queue semantics](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/Queue/), [GotoIfTime](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/GotoIfTime/).

## Apply state, rollout and rollback

Mutations report `committed`, never `active`. Native endpoint/queue inventory reports `unknown` activation. Readiness distinguishes `pbx-provisioning` disabled/database unavailable/available from `pbx-apply` delegation and effective-state unknown. Healthy SQL does not make the latter ready. An effective-state adapter is needed before this implementation can assert `active`.

Deploy OfficePulse and operator delegation first, AidaAdmin backend second, UI last. To stop administration, set `PBX_PROVISIONING_ENABLED=false` and restart the integration, or hide its administration UI. This preserves PBX objects and existing calls. Before intentional PBX rollback, export the affected six tables and reviewed static files, remove/change managed DID references before queues/extensions, and restore only reviewed routes through an operator change. Never restore the removed synchronization ledger or delete Identity number assignments as rollback.

## Verification and external evidence

`npm run verify` and `npm run build` cover unit/HTTP/contract behavior. Shared JSON fixtures in `test/fixtures` are copied verbatim to AidaAdmin's server tests.

`TEST_PBX_PROVISIONING_MYSQL_URL=mysql://.../aida_pbx_provisioning_<name>_test` enables a disposable database test. It refuses other names and existing schemas, applies the shipped restricted grants, proves rollback and forbidden accesses, two-tenant overlap, idempotent members, reference conflicts/concurrency, manual-route preservation and cleanup, then removes only its created database/user. Never point it at an installed PBX.

`TEST_ASTERISK_BINARY=/usr/sbin/asterisk` enables a separate Asterisk process with temporary configuration/socket/data and no SIP/network modules. It tests schedule branches, an answered queue, five-second timeout, missing queue/provider and malformed arguments. Override test module/data directories if needed. It does not reload the installed PBX.

External release acceptance remains required: two real tenants with overlapping numbers, effective PJSIP endpoints, native queue membership, during/outside-schedule DID calls, unanswered timeout to LiveKit, answered queue without AI, forbidden cross-context requests, a trace proving the old static `+19496501147` route no longer wins, recording preservation, and orphan-free deletion. These must be recorded against a reviewed PBX installation before calling the POC operationally complete.
