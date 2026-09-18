# Native Agent bootstrap v2 (issues #18, #19, #22, #23)

Issue #19 completes the POC call path on top of #18: Asterisk's own context,
DID and CID bootstrap the Agent, and business configuration is loaded and
cached outside the call path. Admission, Agent credential consumption and
active-call monitoring make no Identity or NocoDB request at all. Issues #22
and #23 make the Asterisk context the routing scope: every call, admission and
snapshot is pinned to `{pbxInstanceId, context}` (this service's
`OFFICEPULSE_INSTANCE_ID` and the extension context owning the routed queue),
and the tenant is carried only as customer identity for authorization.

This implementation follows the cross-repository bootstrap v2 contract shared
with AidaAgent #12 and AidaAdmin #42, and the identical
`test/fixtures/bootstrap-v2.json` (byte-for-byte the AidaAgent fixture). It does
not close #18's ordinary-telephone acceptance or AidaAdmin #37. Unit tests,
isolated MariaDB and isolated Asterisk are not live PBX/Agent/observer
acceptance, and live PBX/LiveKit acceptance of the context migration has not
been exercised.

## Configuration and authorization

Admission is opt-in with `NATIVE_ADMISSION_ENABLED=true`, `VOICE_ENABLED=true`,
`PBX_INVENTORY_ENABLED=true`, `FASTAGI_BIND=127.0.0.1`, an HTTPS `ID_BASE_URL`,
a configured `LIVEKIT_TRUNK_ENDPOINT`, and an explicit `LIVEKIT_AGENT_NAME`
(such as `aida-prime-bootstrap-dev`). The legacy `aida-prime` name is rejected.
Use the same dispatch name in the repository-owned Agent worker. Its deployment
owns STT, LLM, TTS and voice settings; inline provider settings are never sent.

Route ownership is derived from Asterisk's own rows; there is no tenant map
(`PBX_INVENTORY_TENANTS_JSON` is retired and fails startup when set). For a
call arriving as `{didE164, ingressContext, fallbackQueue}` admission reads the
exact managed DID rows for that DID in the ingress context, requires the route's
queue to equal the PBX's fallback queue, resolves the queue's owning extension
context through its single ownership marker (`queueOwnership.ts`), and requires
the queue row to exist. Ambiguous ownership (a marker in more than one
context), an absent or foreign marker, unmanaged/manual DID rows, queue IDs
exceeding the runtime destination column limit of 60 characters, missing or
disabled assignments/profiles, a profile owned by another customer, and disabled
Identity tenants fail closed. This adds no routing projection or PBX writer.

Assistant profiles are assigned per routing scope in PlatformConfig's
`aida_tbl_ProfileAssignment`, managed through AidaAdmin (never by editing
environment JSON; `AGENT_PROFILE_IDS_JSON` is retired and fails startup when set,
even while admission is disabled). A row carries `pbx_instance_id` (this
service's `OFFICEPULSE_INSTANCE_ID`), `context` (the owning extension context),
`did` (E.164 for a DID-specific assignment; empty for the context default),
`profile_id`, `enabled` and the owning `iTenantId`. A call resolves the enabled
row with its exact DID, else the enabled context default; with neither the
caller stays on the PBX queue. Two enabled rows with the same
`(pbx_instance_id, context, did)` are ambiguous: neither is trusted and the key
is logged. Profile data is read from `aida_tbl_AssistantProfile`, must belong to
the assignment's tenant, and is validated with the Agent's strict allowlist.
Migration of former `AGENT_PROFILE_IDS_JSON` entries is described in
[PBX_SOURCE_OF_TRUTH.md](PBX_SOURCE_OF_TRUTH.md#migrating-from-tenant-maps).

## Cached configuration, not call-path lookups (#19)

Required application settings load at startup through the existing
PlatformConfig settings reader, and every enabled profile assignment of this
PBX instance, with its profile, loads into an in-memory cache keyed by
`(context, did)` at the same time.
`AGENT_CONFIG_REFRESH_SECONDS` (default 300, range 30–3600) refreshes that cache
on its own timer. The cache lookup used by a call is synchronous by type, so
admission, Agent credential consumption and active-call monitoring cannot
perform an HTTP request even by accident.

A refresh that fails keeps the last good values: after a successful load, a
PlatformConfig or Identity outage does not interrupt calls. An authoritative
negative answer — the assignment removed or disabled, its profile disabled,
deleted or owned by another tenant, a duplicate assignment key, an invalid row,
or a disabled tenant — removes that assignment from the cache instead, so a
revocation still fails closed, at the next refresh rather than mid-call. A scope
with no cached assignment is not admitted and the caller stays on the native
queue. The optional Identity check runs once per distinct tenant among the
assignments, never per key. `readyz` reports `agent-config-cache` with
loaded/configured assignment counts, and `native-pbx-admission` is ready only
once at least one assignment is cached; neither depends on NocoDB liveness.

The Identity runtime tenant check is not a POC prerequisite and is off by
default. Set `AGENT_IDENTITY_TENANT_CHECK=true` to have the background refresh
(never a call) consult the service's existing `GET /api/runtime/tenants/:id`.
Set `ID_CLIENT_SECRET` to an admitted Identity application secret;
`OPS_IDENTITY_CLIENT_SECRET` is reused when both features run as the same
application. CIDR admission remains supported when Identity is configured for
trusted application networks. No staff session is used for calls. Rejected or
unavailable checks log a sanitized warning containing only the tenant ID and
HTTP status; no credential or response body is logged.

`AGENT_STARTUP_TIMEOUT_SECONDS` defaults to 30 (range 1–60). Both independently
generated 256-bit credentials expire after 120 seconds; startup has its own
shorter deadline. `AIDA_ROUTE_TOKEN_ATTRIBUTE` defaults to `sip.aidaRouteToken`
and must match the Agent and LiveKit trunk mapping. Revoking an assignment or
profile, or removing the native DID/queue ownership of the pinned scope, is
checked at bootstrap and during active monitoring. Mutable profile text is never
re-resolved for the response.

## Profile snapshot and dispatch metadata v2

`profileSnapshot` has exactly the keys `schemaVersion: 2`, `callSessionId`,
`pbxInstanceId`, `context`, optional `tenantId`, `businessName`, `prompt`,
`locale: 'en-US'`, `didE164`, and optional `tone`, `objective`,
`openingStatement`, `transferStatement`, `failedTransferStatement`. `tenantId`
is a positive canonical decimal string (never a number): non-routing customer
identity. Size caps are unchanged. A v1 snapshot (`schemaVersion: 1`, no scope)
is accepted nowhere, including when read back from `agent_admission`; credential
consumption rejects it without writing. Dispatch metadata is exactly
`{callSessionId, bootstrapToken, pbxInstanceId, context}`, and the Agent must
refuse a snapshot whose `pbxInstanceId`/`context` differ from its dispatch
("bootstrap scope mismatch"). The `aida.event.agent_ready` event stays at
`schemaVersion: 1`.

## Call flow and runtime evidence

1. A managed DID row Gosubs into `aida-managed-did-v1` with its existing queue
   timing. Before that `s` subroutine overwrites `${CONTEXT}`/`${EXTEN}`, the
   include recovers the caller-side context and DID from the Gosub stack
   (`STACK_PEEK`), so an API-created DID needs no DID-specific static edit; a
   reviewed ingress wrapper may still pin `AIDA_AGENT_DID`/`AIDA_AGENT_CONTEXT`.
   Only the AI branch invokes `aida-agent-inbound-v1`, and only when
   `AIDA_NATIVE_ADMISSION=1` and both derived values pass validation — otherwise
   managed DID v1's trunk behavior is unchanged. PBX sets the local queue
   fallback before any network operation and plays disclosure before AI.
   CallerID is never rewritten on this path and arrives as FastAGI
   `agi_callerid`; `unknown`/`anonymous`/`restricted` becomes an absent caller
   number rather than literal text.
2. OfficePulse matches the DID against its own Asterisk Realtime rows in the
   ingress context, derives the owning extension context from the queue's
   ownership marker, reads the cached assignment for `(context, DID)` or the
   context default, creates a call record pinned to `{pbxInstanceId, context}`
   plus the ingress context (`call-arrived`), and captures the immutable
   profile, scope and hashes in `agent_admission`. The call record pins the DID
   and caller number; the `call-arrived` payload records the ingress context,
   owning context, resolved queue and whether a caller number was present —
   never the digits themselves. A repeated
   linked ID never dispatches or issues credentials again; ambiguity falls back.
3. It creates `aida-<call UUID>`, connects a monitor without media subscription,
   and dispatches exactly `{callSessionId, bootstrapToken, pbxInstanceId, context}`
   (`agent-dispatched`).
   The FastAGI SCREEN response carries the separate route token to the PBX.
4. ARI originates the SIP leg through a Local channel. Its PJSIP pre-dial handler
   injects `X-Aida-Route-Token` on the outgoing SIP channel. A callee dispatch rule
   routes that leg into the pre-created room. SIP routing precedes waiting for
   readiness, avoiding the Agent/SIP circular wait.
5. `POST /v1/agent/calls/{callSessionId}/bootstrap` verifies the credential pair,
   call/room/tenant/instance/linked ID, the pinned routing scope (snapshot,
   admission and call record must agree, and ownership is re-derived from the
   call's pinned ingress context), exactly one SIP participant, its route
   attribute and identity/SID, and the actual AgentDispatch job's participant
   identity. A transaction consumes both credentials, binds the verified Agent
   SID for Admin observers, and records `agent-admitted` together. Concurrent
   submissions have at most one success, including across processes/restarts.
6. Reliable `aida.event.agent_ready` from the bound sender is independently
   checked against current LiveKit participants and the intended dispatch before
   `agent-ready` is recorded. A signed join or an `agent-` name cannot grant this
   binding. The first valid transcript envelope from that sender records only
   `conversation-observed`, without text or payload. This proves text publication,
   not audible speech. Admin observes subsequent transcripts directly in LiveKit.
7. Startup deadline, room connection loss, lost/replaced participants, changed
   SIP route attributes, or revoked authorization trigger `agent-fallback` and
   return the caller to `aida-agent-queue-fallback` (`pbx-fallback`). Storage errors
   do not suppress the telephony fallback. An established caller-human bridge is
   preserved. ARI phone hangup records completion; room closure alone does not.

ARI remains subscribed to channel events after returning to dialplan, so the
fallback call's eventual hangup can be recorded. On ARI reconnect/process restart,
unfinished AI calls return to native fallback rather than replaying one-time
credentials or assuming readiness. TAKEOVER still requires a native destination
resolver; this issue does not enable its separate Admin command.

## Deployment prerequisites

1. Build matching Agent and OfficePulse revisions. Apply the additive runtime
   migrations `005_agent_admission.sql` and `006_call_scope.sql` (adds nullable
   `call_session.pbx_context`/`ingress_context`; historical rows stay NULL)
   through the normal migration runner. Do not edit released migrations,
   including `runtime-schema.sql`, whose ledger checksum is verified. `005`
   creates one integration-owned table only.
   Restrict access to this table to the runtime service; it contains pinned
   business prompts and credential hashes, never plaintext credentials or transcripts.
2. Install the reviewed `asterisk/extensions_aida.conf` include (version 3) and
   reload the dialplan. Managed DID v1's default behavior is unchanged while
   `AIDA_NATIVE_ADMISSION` is unset. Enable the AI branch for authorized
   development traffic with one deployment-wide global in extensions.conf
   `[globals]`: `AIDA_NATIVE_ADMISSION=1`. The include then derives the DID and
   its context from the DID's own Realtime row, so adding a Number through the
   API needs no dialplan change; an ingress wrapper that already sets
   `AIDA_AGENT_DID`/`AIDA_AGENT_CONTEXT` still wins. The include uses ARG1 from
   the actual DID row for the queue; do not copy DID/queue routes into another
   database or add DID-specific static routes. Existing native recording and
   hours/ring behavior run before the AI branch. The service and FastAGI
   listener must be on this PBX host; the provided wrapper uses loopback.
3. Configure an authenticated LiveKit inbound SIP trunk and one **callee** rule
   with `randomize=false`, no room prefix, and no automatic Agent dispatch.
   It must accept the generated `aida-<UUID>` destination username and route into
   that exact room. Map `X-Aida-Route-Token` to the configured route attribute.
   Legacy DID/individual-room rules cannot satisfy this contract. See
   [LiveKit room routing](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/)
   and [SIP header mapping](https://docs.livekit.io/reference/telephony/sip-api/).
4. Route the public HTTPS bootstrap path to the public listener (8086), alongside
   signed callbacks. A generic `/v1/` proxy to the private listener will also
   reach this explicitly bearer-authenticated route, but must not expose other
   private handlers. All bootstrap responses use `Cache-Control: no-store`.
5. Configure Agent `AIDA_BOOTSTRAP_URL` to that HTTPS origin, its route attribute,
   and matching worker name. Permit outbound LiveKit signaling/data connectivity
   from OfficePulse for the monitor. The container uses Debian/glibc for the
   pinned `@livekit/rtc-node` native runtime and connects with autoSubscribe=false.
   A sandboxed service unit must allow **`AF_NETLINK`** in
   `RestrictAddressFamilies` alongside `AF_INET`/`AF_INET6`/`AF_UNIX`: libwebrtc
   enumerates network interfaces over netlink while gathering ICE candidates.
   Without it the first room connection in the process succeeds and every later
   one hangs until the monitor's bound expires, so exactly one call per restart
   reaches the Agent and the rest fall back at `monitor-connect`.
   `deploy/systemd/officepulse-aida-integration.service` is a byte-identical
   copy of the unit installed on the OfficePulse PBX host, so
   `diff` against `/etc/systemd/system/` detects drift; the older generic
   `deploy/systemd/aida-integration.service` carries the same setting for
   deployments that use its name, user and paths.
6. Exclude bootstrap request/response bodies, authorization headers, SIP route
   attributes and dispatch metadata from proxy/tracing logs. Disable Asterisk
   AGI debug, SIP packet logging, and verbose dialplan logging for this path:
   expanded Set/header commands contain the route credential. Do not collect
   transcript topics or profile bodies. Service errors on this endpoint are
   sanitized before logging and return generic 400/401/503 responses.

No deployment settings, PBX tables, trunks, production calls or running service
are changed by compiling, testing, committing or merging this implementation.

## Verification and acceptance runbook

Run `npm run verify` and `npm run build`. `TEST_AGENT_MYSQL_URL` must target the
explicit disposable `aida_agent_bootstrap_test` schema. Its tests verify parallel
consumption, process-independent replay rejection, rollback after an injected
event failure, call/tenant/room/scope/expiry checks, fallback races, and SID protection.
`TEST_ASTERISK_BINARY` runs a separate Asterisk process with isolated directories,
no SIP listener and an isolated failed FastAGI endpoint. It dials an API-shaped
managed DID row that sets no `AIDA_AGENT_*` variable and asserts the derived
context/DID/queue reach `aida-agent-inbound-v1` and that a failed bootstrap
returns the caller to the native queue.

A fallback is attributable without reproducing the call. Admission records the
setup stage it fell back at (`resolve`, `create-session`, `livekit-create-room`,
`monitor-connect`, `livekit-dispatch`, ...), the monitor records the underlying
room connection failure, each distinct room data topic it observes once per call,
and the reason any readiness claim was refused (`payload-shape`,
`payload-mismatch`, `not-bound`, `deadline-expired`). None of these log payloads,
upstream message text, transcripts or profile text.

Unit tests cover the #19 instrumented checks: one test loads the cache, then
forces PlatformConfig to fail and replaces `fetch` with a recorder that throws,
and drives admission, bootstrap credential consumption and a monitoring
watchdog pass to completion with zero recorded requests. Others cover outage
tolerance, authoritative revocation (including duplicate assignment keys and
tenant-mismatched profiles), v1 snapshot rejection, scope mismatches at
consumption, absent/foreign/ambiguous queue markers, and the caller
number/ingress evidence.

For live acceptance, record deployed Git revisions and sanitized call IDs:

- Dial the configured development number from an ordinary telephone, using a DID
  created through the API with no dialplan hand edit. Confirm the expected native
  queue timing/disclosure, admission, exactly one ready event, English greeting,
  relevant spoken response, and caller/assistant text in Admin.
- Confirm the call record shows the caller's number and the DID actually dialled,
  and that the `call-arrived` event carries the original ingress context. Repeat
  from a caller-ID-withheld handset and confirm an absent caller number rather
  than literal `anonymous` text, with the call still admitted.
- Confirm the profile that spoke is the cached one: check `agent-config-cache` in
  `readyz` and the pinned `config_profile_id`/`config_profile_rev` on the call.
- Interrupt the assistant and confirm audible barge-in. Hang up and verify actual
  call completion (`call-completed`, `ended_at` set). Repeat across two tenants
  and reject cross-tenant observers, staff/anonymous observers, and Super Admin
  without explicit tenant selection using AidaAdmin's
  `docs/LIVE_TRANSCRIPT_TESTING.md`.
- With a call cached and in progress, make PlatformConfig and Identity
  unreachable, then place further calls in the same context and confirm they are
  still admitted and answered. Restore the services and confirm the next refresh
  logs a cached configuration without a restart.
- Verify two routes that share one ingress context resolve to their own
  extension context, queue and profile, that a DID-specific assignment overrides
  the context default, that a changed assignment takes effect after the next
  refresh without a restart while in-progress calls keep their snapshot, and
  that a queue answered by a human never reaches the AI branch.
- Verify observer reconnect/late join without historical replay. Test absent,
  wrong, expired and reused credentials, unavailable bootstrap, Agent startup
  failure, worker loss, and SIP participant replacement. Each supported failure
  must reach the configured PBX queue, with no extra Agent speech or stranded call.
- Verify the human-bridge invariant during failures. Record actual arrival,
  admission, readiness, conversation and completion separately; process health
  and fixture success cannot substitute for any of them.

Keep #18 open until this live evidence and AidaAdmin #37 acceptance are recorded.
