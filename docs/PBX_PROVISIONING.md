# Native PBX provisioning and managed DID routing

OfficePulse writes the six installed Asterisk Realtime tables transactionally. Asterisk remains authoritative. There is no NocoDB desired-state graph, runtime configuration-file writer, operation/retry ledger, or per-call Node dependency. AidaAdmin uses this contract from its authenticated backend.

## Enablement and ownership

Set `PBX_PROVISIONING_ENABLED=true` plus dedicated `PBX_PROVISIONING_MYSQL_USER` and `PBX_PROVISIONING_MYSQL_PASSWORD`. Database coordinates use `MYSQL_HOST`, `MYSQL_PORT`, and `MYSQL_DATABASE`. The writer account must differ from runtime and inventory accounts. Without the flag and credentials, mutation routes are absent. Enable `PBX_INVENTORY_ENABLED=true` with its separate SELECT account for the administration UI.

For the verified `officepulse-dev` schema, apply the reviewed operator migration in `deploy/sql/pbx-provisioning-schema.sql` before creating accounts. It widens only `asterisk.extensions.exten` and `asterisk.ps_endpoints.callerid` from 40 to 80 characters while preserving their installed nullability, UTF-8 collation, data and indexes. It is never run by application startup. Review its preflight output, take the normal schema backup, schedule the two ALTER statements through the database change procedure, and verify both columns and unique keys afterward. Do not narrow the columns during application rollback; narrowing can reject or truncate records created after enablement.

Apply `deploy/sql/pbx-provisioning-grants.sql` manually after the schema migration. It allows only SELECT/INSERT/DELETE on the required tables, with SELECT limited to `id` on auth/AOR tables; even the writer cannot retrieve existing SIP passwords. There are no application startup PBX migrations, UPDATE, DDL or unrelated-table grants. Inventory also needs SELECT on `extensions` to recognize queue ownership markers, including when writes are disabled for rollback.

All six tables must use InnoDB. Require primary/unique endpoint, auth and AOR IDs, unique queue names, and unique `(context,exten,priority)` dialplan rows. The representative schema in `test/mysqlPbxProvisioning.test.ts` includes the fields used, including endpoint `outbound_auth` and member `state_interface` for safe deletion checks. Verify these before enablement. Queue names are at most 80 characters, `extensions.exten` at least 80, `appdata` at least 256, and endpoint `callerid` at least 80. Large installations exceeding 1,000 inventory rows require pagination before adoption.

Authorization metadata is configured by an operator:

```json
{
  "2": {"contexts":["localsplash"],"queueNames":["localsplash"],"didContext":"managed-localsplash","didNumbers":["+17145550100"]},
  "3": {"contexts":["concierge"],"queueNames":["concierge"],"didContext":"managed-concierge","didNumbers":["+19496501147"]}
}
```

Save the reviewed map in `PBX_INVENTORY_TENANTS_JSON`. These example numbers do not assign carrier service. Exact DID ownership cannot be duplicated across tenants; contexts and legacy queue names cannot overlap even by case. Imported objects require explicit mapping. Never use a shared/default endpoint context as a tenant boundary.

Created endpoint/auth/AOR IDs are `<extension>-t<iTenantId>`; dialable numbers stay in the approved tenant context. Created queue IDs are `t<iTenantId>.<slug>` (friendly slug at most 60 characters), except exact mapped legacy names such as `concierge`. Prefixes alone never authorize a pre-existing queue. Creation stores an exact versioned ownership marker in the first tenant context: extension `__aida_queue_` plus the first 40 hex characters of SHA-256(native queue ID), priority 1, `NoOp(OfficePulse:queue:v1:<native queue ID>)`. This native marker fits vendor column limits and contains ownership only, not a copied queue configuration.

Imported endpoints remain visible. Extension mutations and mapping edits operate on the generated endpoint bundle for this POC; AidaAdmin marks imported endpoints and other member interfaces as operator managed. Deletion refuses altered/manual dialplan or shared auth/AOR bundles and remaining external dialplan/state-interface references. It removes owned saved memberships atomically.

## Private contract

Every route requires exactly one positive safe-integer `iTenantId`. Private CIDR admission remains mandatory; the authenticated Operations gateway also applies Identity tenant authorization and CSRF. No route is exposed by the public health/webhook listener. Use the published `/openapi.json` or authenticated `/ops/openapi.json` for full schemas.

| Method | Path under `/v1/admin/pbx` | Result |
| --- | --- | --- |
| GET | `/extensions`, `/queues` | Native scoped inventory, `provisioningEnabled`; extensions also include approved `contexts` |
| POST | `/extensions` | `{extension,displayName?,callerIdNumber?,context?}` → one-time `sipUsername`, `sipSecret`, `applyState` |
| DELETE | `/extensions/:extension` | Delete owned bundle and saved memberships; 204 |
| POST | `/queues` | `{name,strategy?}` → native `name`, `strategy`, `applyState` |
| DELETE | `/queues/:queue` | Delete queue/members; 409 while referenced by a DID |
| PUT | `/queues/:queue/extensions/:extension` | Idempotent `{penalty?:0..100,paused?:boolean,context?}` |
| DELETE | `/queues/:queue/extensions/:extension` | Delete owned saved membership; absent returns 404 |
| GET | `/dids` | Recognized managed settings or explicit `manual` / `unconfigured` entries for allowed DIDs |
| PUT | `/dids/:did` | Set managed route or create an unconfigured allowed route; refuse manual adoption |
| DELETE | `/dids/:did` | Delete recognized managed rows only; retain Identity/carrier number |

Encode all path components, especially `+19496501147` as `%2B19496501147`. Bodies reject unknown fields. Extension numbers are 2–12 digits; caller-ID numbers must be E.164. Display names are at most 60 characters without controls, quotes, angle brackets or backslashes; the complete caller ID must fit 80 characters. Transport/codec POC defaults are `transport-udp` and `ulaw,alaw`. SIP secrets are generated with 32 random bytes and returned only after commit. Duplicate requests return conflict and cannot retrieve a previous secret. Responses are `Cache-Control: no-store`.

Queue strategies: `ringall` (default), `leastrecent`, `fewestcalls`, `random`, `rrmemory`, `linear`, `wrandom`. Destructive absent and cross-tenant object lookups return the same 404. Invalid/out-of-scope input returns 422, duplicates/reference/manual-route conflicts 409, and database/schema/grant errors a redacted 503. Clients must refresh after ambiguous failures; there is no secret replay or retry ledger.

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
3. Apply `asterisk/extensions.conf.managed-did.patch` from `/etc/asterisk` with `patch --dry-run -p0` first. It changes only the existing `+19496501147` route in `[from-bandwidth]` to `Goto(managed-concierge,${EXTEN},1)` and adds `[managed-concierge]` with `switch => Realtime`. The patch fails if the reviewed source lines have changed. Inspect the resulting diff before reload. Do not install a catch-all Realtime switch in `[from-bandwidth]`, `[default]`, or any other trunk/shared context.
4. Extend tenant 3 in `PBX_INVENTORY_TENANTS_JSON` with `"didContext":"managed-concierge","didNumbers":["+19496501147"]`, preserving its existing `contexts` and `queueNames`. Exact DID ownership must be present before enabling writes. The replaced static route must no longer send this DID directly to `concierge,inbound,1`; a matching static route can shadow Realtime even when SQL writes succeed. No automatic adoption or static-file editing occurs in the API.
5. Preserve recording through an operator-owned `officepulse-recording` subroutine. Adapt the existing tenant recording routines using a reviewed exact DID mapping, set `__OFFICEPULSE_RECORDING_STARTED=1`, and return. The managed include skips this hook when that flag, `MIXMONITOR_FILENAME`, or `CDR(userfield)` already identifies a recording. Existing Concierge/LocalSplash hooks differ; verify recording start and CDR association for each tenant before cutover.
6. Use the operator's scoped validation/reload/cache-expiry procedure. The API does not issue reload commands. After reload, `dialplan show +19496501147@from-bandwidth` must show the exact `managed-concierge` delegation, and `dialplan show managed-concierge` must show the Realtime switch. Inspect only that DID's Realtime rows, `queue show concierge`, and `pjsip show endpoint livekit`. Trace a controlled call through the versioned subroutine; configuration listings alone cannot prove the winning route or a successful call.

The shared subroutine evaluates schedules locally. Inside the window (or without a schedule), it queues for the ring budget. A queue answer ends the call flow without AI continuation. Timeout, missing/unavailable/empty/full queue falls through once to `Dial(PJSIP/<destination>@livekit,60)`. Outside the schedule it goes straight to LiveKit. A missing/unavailable LiveKit endpoint ends the call; malformed arguments hang up with cause 21. There is no loop or external AGI requirement.

References: [Realtime families and switch](https://docs.asterisk.org/Fundamentals/Asterisk-Configuration/Database-Support-Configuration/Realtime-Database-Configuration/), [Queue semantics](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/Queue/), [GotoIfTime](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/GotoIfTime/).

## Apply state, rollout and rollback

Mutations report `committed`, never `active`. Native endpoint/queue inventory reports `unknown` activation. Readiness distinguishes `pbx-provisioning` disabled/database unavailable/available from `pbx-apply` delegation and effective-state unknown. Healthy SQL does not make the latter ready. An effective-state adapter is needed before this implementation can assert `active`.

Deploy OfficePulse and operator delegation first, AidaAdmin backend second, UI last. To stop administration, set `PBX_PROVISIONING_ENABLED=false` and restart the integration, or hide its administration UI. This preserves PBX objects and existing calls. Before intentional PBX rollback, export the affected six tables and reviewed static files, remove/change managed DID references before queues/extensions, and restore only reviewed routes through an operator change. Never restore the removed synchronization ledger or delete Identity number assignments as rollback.

## Verification and external evidence

`npm run verify` and `npm run build` cover unit/HTTP/contract behavior. Shared JSON fixtures in `test/fixtures` are copied verbatim to AidaAdmin's server tests.

`TEST_PBX_PROVISIONING_MYSQL_URL=mysql://.../aida_pbx_provisioning_<name>_test` enables a disposable database test. It refuses other names and existing schemas, applies the shipped restricted grants, proves rollback and forbidden accesses, two-tenant overlap, idempotent members, reference conflicts/concurrency, manual-route preservation and cleanup, then removes only its created database/user. Never point it at an installed PBX.

`TEST_ASTERISK_BINARY=/usr/sbin/asterisk` enables a separate Asterisk process with temporary configuration/socket/data and no SIP/network modules. It tests schedule branches, an answered queue, five-second timeout, missing queue/provider and malformed arguments. Override test module/data directories if needed. It does not reload the installed PBX.

External release acceptance remains required: two real tenants with overlapping numbers, effective PJSIP endpoints, native queue membership, during/outside-schedule DID calls, unanswered timeout to LiveKit, answered queue without AI, forbidden cross-tenant requests, a trace proving the old static `+19496501147` route no longer wins, recording preservation, and orphan-free deletion. These must be recorded against a reviewed PBX installation before calling the POC operationally complete.
