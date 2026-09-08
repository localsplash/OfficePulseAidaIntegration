# Platform runtime contract v1

OfficePulse owns the voice runtime and PBX integration API. Asterisk is the source of truth for PBX configuration; AidaAdmin reads endpoint and queue inventory through OfficePulse. Identity owns people, businesses, memberships and staff sessions. AidaControl is deprecated. The [PBX source-of-truth contract](PBX_SOURCE_OF_TRUTH.md) supersedes the historical desired-state and ring-group provisioning requirements below. Deploy with Identity's platform contract v2 and AidaAdmin's PlatformConfig/MySQL branch; this is a coordinated development release.

## Stores and cutover

`aidacalls_db` contains the existing call/event/command projections plus new `aida_tbl_DeviceEnrollment`, `aida_tbl_DeviceSession`, `aida_tbl_EventReceipt` and `aida_tbl_SchemaMigration` tables. Existing call table names and UUIDs are retained. Startup runs checksummed, locked, additive migrations only on `RUNTIME_MYSQL_DATABASE`; the legacy baseline's CREATE DATABASE/USE statements are deliberately excluded. The database must already exist. Do not manually execute the historical baseline against a live server expecting it to honor the new database setting.

Identity `iTenantId` is a positive safe integer. Existing provisioning wire fields named `tenantId` now use its decimal string; domain IDs (extension, ring group, route, call) remain UUIDs. Explicitly map legacy tenant UUIDs before importing desired configuration or runtime projections. Updating an already-provisioned extension keeps its existing endpoint ID, SIP username and secret; renumbering a tenant must never recreate SIP accounts implicitly. Preserve source stores and backups until acceptance. Existing `aida_object` bookkeeping is integration-owned customization adjacent to the PBX; no vendor table DDL is introduced by these migrations.

NocoDB reads resolve `PlatformConfig` and the same `aida_tbl_*` tables that AidaAdmin owns. TenantProfile is looked up by `iTenantId`; it contains voice settings, not an independent business directory. Every device API request and every new screening admission checks central business enablement with the private `GET /api/runtime/tenants/:id` API. Server admission uses the configured CIDR policy and optional `IDENTITY_CLIENT_SECRET` in `X-Id-Client-Secret`.

Settings resolve nonblank environment override → `officepulse` → `aida` → `*`. `NOCODB_BASE_URL` and `NOCODB_API_TOKEN` bootstrap discovery. `trustedCIDR` maps to `TRUSTED_SERVER_CIDRS`; reverse-proxy trust is separate. Duplicate scopes/keys, tables and business voice profiles fail explicitly. Startup retries a failed settings read once after five seconds. Connection/provider settings are a startup snapshot and require restart after a change. Desired voice configuration is read per operation; metadata IDs expire after 30 seconds. Explicit `PLATFORM_CONFIG_MODE=environment` is available for isolated operator-managed deployments; it does not disable NocoDB voice configuration reads.

## HTTP listeners

| Listener | Exposure | Routes |
| --- | --- | --- |
| `HTTP_PORT=8085` | Docker/private service network only | Admin `/v1/admin/pbx/extensions`, `/v1/admin/pbx/queues`, `/v1/admin/calls/:id`, events and commands; historical `/v1/provisioning/*` writers require explicit rollback opt-in |
| `PUBLIC_HTTP_PORT=8086` | HTTPS through NPM | Device `/v1/devices/*`, `/v1/calls*`, signed `/v1/integrations/livekit/webhooks` |
| `FASTAGI_PORT=4573` | PBX-only private network | AGI bootstrap |

Public and private listeners are distinct: private routes are absent from the public listener even when the proxy is on a trusted subnet. Rate limits and body caps apply to public routes. Forwarded IPs are honored only from configured proxies. Health/readiness are exposed on both listeners. Never forward the private listener, ARI or SQL ports through NPM.

## Device APIs

Existing compatibility contract; AidaHandset/AidaAgent changes are deferred while
native PBX references and API access are established. The historical PBX writers
and private enrollment/revocation routes are disabled unless
`LEGACY_PBX_PROVISIONING_ENABLED=true`. Existing device capabilities retain their
authenticated access/logout paths; no new handset work is introduced.

A device credential is a scoped hardware capability, not a second staff session authority. Its tenant and extension come from a trusted provisioning grant; a MAC address or client-supplied tenant is never authentication.

1. AidaAdmin calls private `POST /v1/provisioning/device-enrollments {iTenantId,extensionId}` after authorizing its current staff actor. Response: `{enrollmentToken,expiresIn:600}`. Only a hash is persisted.
2. Android calls public `POST /v1/devices/enroll {enrollmentToken,deviceId}`. Response: `{token,device:{id,iTenantId,extensionId}}`. `deviceId` here is installation/hardware lookup data. Enrollment consumes once under transaction locking; the response's ID is allocated by the runtime. Re-enrollment revokes the prior capability for the same hardware/business/extension. Lost responses require fresh enrollment.
3. Subsequent calls send `Authorization: Bearer <token>`. The token is random 32-byte base64url and stored as SHA-256. `POST /v1/devices/logout` revokes it. Private `DELETE /v1/provisioning/devices/:id` supports administration.
4. `GET /v1/calls` returns `{calls:[{id,status,version,caller?,startedAt?,extensionId?}]}` for active calls to the device's extension and enabled ring groups containing that extension. `GET /v1/calls/:id` returns `{call,livekit?:{url,token}}`. Wrong-business and unassigned calls return 404.
5. `POST /v1/calls/:id/commands {commandType:"TAKEOVER",idempotencyKey,expectedCallVersion}` accepts only TAKEOVER. Keys are scoped to the authenticated device. The runtime selects the pinned destination; device-supplied PBX options are ignored. Identical retries return the recorded outcome even after the version changes; a reused key with different intent or a new stale-version command conflicts.

Room tokens expire after 120 seconds and grant data reception only: no microphone, camera, media subscription or data publishing. Transcript history is not returned by the HTTP API. A ten-second server sweep revalidates actual connected handset participants against current device, business and destination access and removes invalid viewers without touching SIP or agent participants. Android also disconnects and clears its transcript after 401/403. Removal depends on reachable LiveKit and configuration services. LiveKit Cloud revokes removed participants' tokens; self-hosted LiveKit may permit a cached/refreshed token to rejoin, so sweeps continue. Validate that bound before using self-hosted rooms for sensitive transcripts. [LiveKit token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

## Agent and call lifecycle

Room names are `aida-<call UUID>`. Dispatch metadata is the existing allowlist `{callSessionId,tenantId,businessName,prompt,tone?,objective?,openingStatement?,transferStatement?,failedTransferStatement?,locale,didE164}`. Model/provider choices and credentials are deployment settings. Select a distinct agent name for development; do not compete with a separate cloud worker using the same dispatch name.

Reliable LiveKit `transcript` packets use `{type:"transcript",callId,eventId,streamId,sequence,segmentId,text,isFinal,timestamp,speaker?}`. They are transient. Reliable server-origin `aida.control` packets use `{type:"control",callId,commandId,action:"human_answered"|"transfer_failed",deadlineMs}`. The worker deduplicates and validates call ownership and sender. Human bridging remains ARI-owned; agent cleanup removes only its own participation. Closing a LiveKit room must never end a caller-human telephone bridge.

MySQL command claiming locks the call row and atomically stores intent, version and ordered acceptance event before network effects. Lifecycle receipts, events and state changes commit together; duplicate events cannot resurrect an ended call. LiveKit delivery receipts and their participant/event effects also commit together and failed delivery processing returns an error for retry. No transaction can make PBX network effects exactly-once. An interrupted command can remain pending and must be reconciled with ARI; this release does not claim a general durable command executor.

Provisioned DID fallback context/extension are resolved from an enabled destination in the same business and written into the dialplan before FastAGI. Re-provision DIDs after moving their fallback destination. This allows the local dialplan to use that destination when the runtime is down. Central administrative disablement cannot remotely erase a pre-existing PBX fallback during a total network outage; the operational disable procedure must also disable/re-provision that DID on the PBX.

## Validation and release limits

Run `npm run verify` and `npm run build` under Node 22. `TEST_MYSQL_URL` enables disposable-database tests; test schema names must match `aida_*_test`. The suite exercises concurrent one-time enrollment, hashed token revocation, stale commands, duplicate outcomes, ordered events, lifecycle idempotency and migration reruns with preserved data. Real database tests are not a substitute for actual PBX/LiveKit/Android acceptance.

Before release: rehearse configuration/tenant import and backups, verify two-business isolation plus SUPER_ADMIN administration, place a real screening call, receive Android live transcription, take over, hang up both directions, revoke a connected handset, interrupt dependencies and verify the PBX fallback. The existing caller-human bridge must survive agent/runtime failure. No external carrier, PBX or LiveKit deployment is altered by this source PR.
