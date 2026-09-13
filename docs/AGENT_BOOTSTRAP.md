# Native Agent bootstrap v1 (issue #18)

This implementation matches AidaAgent `dev` commit
`0c023e224272c610ccb13be5cfb805d50ecabbc5`, its
[bootstrap contract](https://github.com/localsplash/AidaAgent/blob/0c023e224272c610ccb13be5cfb805d50ecabbc5/docs/BOOTSTRAP_CONTRACT.md),
and the identical `test/fixtures/bootstrap-v1.json`. It does not close #18's
ordinary-telephone acceptance or AidaAdmin #37. Unit tests, isolated MariaDB and
isolated Asterisk are not live PBX/Agent/observer acceptance.

## Configuration and authorization

Admission is opt-in with `NATIVE_ADMISSION_ENABLED=true`, `VOICE_ENABLED=true`,
`PBX_INVENTORY_ENABLED=true`, `FASTAGI_BIND=127.0.0.1`, an HTTPS `ID_BASE_URL`,
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
The Identity service's existing, CIDR-protected `GET /api/runtime/tenants/:id`
checks current tenant enablement. Admit this OfficePulse server in Identity's
trusted application network configuration. No staff session is used for calls.

`AGENT_STARTUP_TIMEOUT_SECONDS` defaults to 30 (range 1–60). Both independently
generated 256-bit credentials expire after 120 seconds; startup has its own
shorter deadline. `AIDA_ROUTE_TOKEN_ATTRIBUTE` defaults to `sip.aidaRouteToken`
and must match the Agent and LiveKit trunk mapping. Revoking a tenant/profile or
removing its native DID/queue authorization is checked at bootstrap and during
active monitoring. Mutable profile text is never re-resolved for the response.

## Call flow and runtime evidence

1. A reviewed ingress opts a call into the existing managed DID's native queue
   timing. Only the AI branch invokes `aida-agent-inbound-v1`. PBX sets the local
   queue fallback before any network operation and plays disclosure before AI.
2. OfficePulse resolves ownership, creates a call record (`call-arrived`), and
   captures the immutable profile and hashes in `agent_admission`. A repeated
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
2. Install the reviewed `asterisk/extensions_aida.conf` include. Managed DID v1's
   default behavior is unchanged. In the operator's generic ingress, set
   `AIDA_AGENT_DID` to the current E.164 extension, `AIDA_AGENT_CONTEXT` to the
   native Realtime DID context, and `AIDA_NATIVE_ADMISSION=1` only for authorized
   development traffic before entering that native context. The include uses
   ARG1 from the actual DID row for the queue; do not copy DID/queue routes into
   another database or add DID-specific static routes. Existing native recording
   and hours/ring behavior run before the AI branch. The service and FastAGI
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
no SIP listener and an isolated failed FastAGI endpoint to exercise local fallback.

For live acceptance, record deployed Git revisions and sanitized call IDs:

- Dial the configured development number from an ordinary telephone. Confirm
  the expected native queue timing/disclosure, admission, exactly one ready event,
  English greeting, relevant spoken response, and caller/assistant text in Admin.
- Interrupt the assistant and confirm audible barge-in. Hang up and verify actual
  call completion. Repeat across two tenants and reject cross-tenant observers,
  staff/anonymous observers, and Super Admin without explicit tenant selection
  using AidaAdmin's `docs/LIVE_TRANSCRIPT_TESTING.md`.
- Verify observer reconnect/late join without historical replay. Test absent,
  wrong, expired and reused credentials, unavailable bootstrap, Agent startup
  failure, worker loss, and SIP participant replacement. Each supported failure
  must reach the configured PBX queue, with no extra Agent speech or stranded call.
- Verify the human-bridge invariant during failures. Record actual arrival,
  admission, readiness, conversation and completion separately; process health
  and fixture success cannot substitute for any of them.

Keep #18 open until this live evidence and AidaAdmin #37 acceptance are recorded.
