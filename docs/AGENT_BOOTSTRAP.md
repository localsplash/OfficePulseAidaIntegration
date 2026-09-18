# Native Agent bootstrap v1 (issues #18, #19)

Issue #19 completes the POC call path on top of #18: Asterisk's own context,
DID and CID bootstrap the Agent, and business configuration is loaded and
cached outside the call path. Admission, Agent credential consumption and
active-call monitoring make no Identity or NocoDB request at all.

This implementation matches AidaAgent `dev` commit
`0c023e224272c610ccb13be5cfb805d50ecabbc5`, its
[bootstrap contract](https://github.com/localsplash/AidaAgent/blob/0c023e224272c610ccb13be5cfb805d50ecabbc5/docs/BOOTSTRAP_CONTRACT.md),
and the identical `test/fixtures/bootstrap-v1.json`. It does not close #18's
ordinary-telephone acceptance or AidaAdmin #37. Unit tests, isolated MariaDB and
isolated Asterisk are not live PBX/Agent/observer acceptance.

## Configuration and authorization

Admission is opt-in with `NATIVE_ADMISSION_ENABLED=true`, `VOICE_ENABLED=true`,
`PBX_INVENTORY_ENABLED=true`, `FASTAGI_BIND=127.0.0.1`, an HTTPS Identity origin (see [Identity base URL](#identity-base-url)),
a configured `LIVEKIT_TRUNK_ENDPOINT`, and an explicit `LIVEKIT_AGENT_NAME`
(such as `aida-prime-bootstrap-dev`). The legacy `aida-prime` name is rejected.
Use the same dispatch name in the repository-owned Agent worker. Its deployment
owns STT, LLM, TTS and voice settings; inline provider settings are never sent.

`PBX_INVENTORY_TENANTS_JSON` retains the reviewed native contexts/queues and
`didContext`. Admission reads the exact managed DID rows in Asterisk Realtime
and validates the destination queue against tenant ownership. Ambiguous ownership,
unmanaged/manual DID rows, queue IDs exceeding the runtime destination column
limit of 60 characters, missing or disabled profiles, and disabled Identity
tenants fail closed. This adds no routing projection or PBX writer.

Select a profile with `AGENT_PROFILE_IDS_JSON`, for example
`{"42":"example-profile-id"}`. Without a selection exactly one enabled profile
must exist for the tenant. Profile data is read from PlatformConfig's
`aida_tbl_AssistantProfile` and validated with the Agent's strict allowlist.

## Cached configuration, not call-path lookups (#19)

Required application settings load at startup through the existing
PlatformConfig settings reader, and one effective enabled profile per mapped
tenant loads into an in-memory cache at the same time.
`AGENT_CONFIG_REFRESH_SECONDS` (default 300, range 30–3600) refreshes that cache
on its own timer. The cache lookup used by a call is synchronous by type, so
admission, Agent credential consumption and active-call monitoring cannot
perform an HTTP request even by accident.

A refresh that fails keeps the last good values: after a successful load, a
PlatformConfig or Identity outage does not interrupt calls. An authoritative
negative answer — the profile disabled or deleted, two enabled profiles with no
selection, or a disabled tenant — removes the tenant from the cache instead, so
a revocation still fails closed, at the next refresh rather than mid-call. A
tenant with no cached configuration is not admitted and the caller stays on the
native queue. `readyz` reports `agent-config-cache`, and `native-pbx-admission`
no longer depends on NocoDB liveness.

The Identity runtime tenant check is not a POC prerequisite and is off by
default. Set `AGENT_IDENTITY_TENANT_CHECK=true` to have the background refresh
(never a call) consult the service's existing `GET /api/runtime/tenants/:id`.
Set `ID_CLIENT_SECRET` to an admitted Identity application secret;
`OPS_IDENTITY_CLIENT_SECRET` is reused when both features run as the same
application. CIDR admission remains supported when Identity is configured for
trusted application networks. No staff session is used for calls. Rejected or
unavailable checks log a sanitized warning containing only the tenant ID and
HTTP status; no credential or response body is logged.

### Identity base URL

The origin that check calls is not configured separately (#20). In PlatformConfig
mode the startup settings reader resolves it from the Identity application's own
`cfg_tbl_Setting` record (`app = identity`, `settingKey = APP_BASE_URL`), validates
it as an HTTPS origin and passes it to the agent configuration as `ID_BASE_URL`.
Never set `ID_BASE_URL` by hand in that mode: a nonblank value in the environment
or in any `*`/`aida`/`officepulse` scope row fails startup as a retired override,
so a stale copy cannot point the tenant check at another environment. A missing
or blank record means admission does not start and the error names
`identity/APP_BASE_URL`; duplicate or malformed records and a NocoDB failure
during the lookup fail startup explicitly instead of falling back to a hostname or
another application's URL. `PLATFORM_CONFIG_MODE=environment` is the retained
environment-only mode in which `ID_BASE_URL` is read from the environment. The
record is read once at startup, so a central change takes effect at the next
restart; there is no hot reload. Diagnostics never print the value.

`AGENT_STARTUP_TIMEOUT_SECONDS` defaults to 30 (range 1–60). Both independently
generated 256-bit credentials expire after 120 seconds; startup has its own
shorter deadline. `AIDA_ROUTE_TOKEN_ATTRIBUTE` defaults to `sip.aidaRouteToken`
and must match the Agent and LiveKit trunk mapping. Revoking a tenant/profile or
removing its native DID/queue authorization is checked at bootstrap and during
active monitoring. Mutable profile text is never re-resolved for the response.

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
2. OfficePulse matches the ingress context and DID against the tenant's own
   Asterisk Realtime rows, reads the cached profile, creates a call record
   (`call-arrived`), and captures the immutable profile and hashes in
   `agent_admission`. The call record pins the DID and caller number; the
   `call-arrived` payload records the ingress context, resolved queue and
   whether a caller number was present — never the digits themselves. A repeated
   linked ID never dispatches or issues credentials again; ambiguity falls back.
3. It creates `aida-<call UUID>`, connects a monitor without media subscription,
   and dispatches exactly `{callSessionId, bootstrapToken}` (`agent-dispatched`).
   The FastAGI SCREEN response carries the separate route token to the PBX.
4. ARI originates the SIP leg through a Local channel. Its PJSIP pre-dial handler
   injects `X-Aida-Route-Token` on the outgoing SIP channel. A callee dispatch rule
   routes that leg into the pre-created room. SIP routing precedes waiting for
   readiness, avoiding the Agent/SIP circular wait.
5. `POST /v1/agent/calls/{callSessionId}/bootstrap` verifies the credential pair,
   call/room/tenant/instance/linked ID, exactly one SIP participant, its route
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
   migration `005_agent_admission.sql` through the normal migration runner. Do not
   edit released migrations. It creates one integration-owned table only.
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
event failure, call/tenant/room/expiry checks, fallback races, and SID protection.
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
tolerance, authoritative revocation and the caller number/ingress evidence.

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
  unreachable, then place further calls on the same tenant and confirm they are
  still admitted and answered. Restore the services and confirm the next refresh
  logs a cached configuration without a restart.
- Verify two routes that share one ingress context resolve to their own tenant,
  queue and profile, and that a queue answered by a human never reaches the AI
  branch.
- Verify observer reconnect/late join without historical replay. Test absent,
  wrong, expired and reused credentials, unavailable bootstrap, Agent startup
  failure, worker loss, and SIP participant replacement. Each supported failure
  must reach the configured PBX queue, with no extra Agent speech or stranded call.
- Verify the human-bridge invariant during failures. Record actual arrival,
  admission, readiness, conversation and completion separately; process health
  and fixture success cannot substitute for any of them.

Keep #18 open until this live evidence and AidaAdmin #37 acceptance are recorded.
