# OfficePulseAidaIntegration

Layer Aida onto OfficePulse without forking or modifying Asterisk source.

A TypeScript/Node.js service on **LSAidaOffice01**. For the POC it is both
the **call orchestrator** and the Asterisk adapter — there is no
AidaControl service (issue #9). It provides:

1. **Inbound call orchestration** — FastAGI resolves the DID route and
   assistant profile directly from AidaAdmin's NocoDB base, pins the
   configuration it used onto a local call session, creates the LiveKit
   room, dispatches the predefined `aida-prime` agent, and hands Asterisk
   the routing variables.
2. **ARI takeover control** — asynchronous multi-channel control: bridge
   the caller with the LiveKit/Aida leg, ring a human on command, connect
   the human instantly on answer, and drain Aida within a bounded window.
3. **Realtime provisioning API** — private, typed HTTP API through which
   AidaAdmin's server provisions extensions, ring groups, DIDs, and
   MAC-based handsets into the Asterisk Realtime MySQL tables.

## Data ownership

Applications may read shared databases, but each data set has exactly one
writer:

| Data set | Writer | This service |
|---|---|---|
| NocoDB `AidaAdmin` base | AidaAdmin | **reads only** |
| Asterisk Realtime MySQL | this service | **writes** |
| `aida_officepulse` runtime MySQL | this service | **writes** |
| `aida_officepulse` (AidaAdmin's view) | — | AidaAdmin reads via a read-only account; commands stay HTTP actions |

Normative contract: the
[Aida Office POC — Database and Input Interface Specification](https://github.com/localsplash/AidaInfrastructureSetupInstructions/blob/main/docs/AIDA_POC_DATABASE_AND_INTERFACE_SPECIFICATION.md),
as superseded for the POC by
[issue #9](https://github.com/localsplash/OfficePulseAidaIntegration/issues/9)
wherever the two differ on AidaControl.

## Project invariant

**No Aida failure or cleanup operation may tear down an established
caller-human bridge.** The takeover manager only ever removes the
LiveKit/Aida leg; if the human disappears during the drain window, the
drain is aborted and the caller stays with Aida.

## Call flow

```
inbound DID (Realtime rows, written by this service's provisioning API)
  -> recording disclosure (always, before FastAGI/LiveKit)
  -> AGI(agi://LSAidaOffice01:4573/bootstrap)
       -> read DID route + assistant profile from the NocoDB AidaAdmin base
       -> persist call_session with the configuration ids AND revisions pinned
       -> create LiveKit room, dispatch `aida-prime`, notify the handset
       -> sets AIDA_DISPOSITION + routing channel variables
  -> [aida-post-bootstrap] static include
       SCREEN   -> Stasis(aida) -> ARI originates the LiveKit SIP-trunk leg
                   with the X-Aida-Call-Session header, bridges
                   caller <-> Aida  (media stays Asterisk<->LiveKit)
       FALLBACK -> failure prompt -> direct Dial to destination, with the
                   extension-side incident prompt on answer
       REJECT   -> hangup
  takeover command (AidaAdmin/AidaHandset -> this service)
       -> single idempotent originate to extension/ring group
       -> MOH while ringing; on answer: human joins bridge immediately,
          Aida drains (<= 10 s or on drain-ack), only the Aida leg is removed
```

**Local fail-safe.** If NocoDB, LiveKit, or the runtime database is
unavailable, the caller is still routed to *this DID's own* destination,
resolved from a projection written at provisioning time — never to another
tenant's destination. A deployment-wide default exists only as a final
operator emergency fallback. If this service or ARI is down entirely, the
dialplan alone still routes: disclosure → failure prompt → destination.
Media never traverses this service.

## Network (private LAN only — see `deploy/firewall-matrix.md`)

| Port | Direction | Peer | Purpose |
|------|-----------|------|---------|
| 4573/tcp | inbound | OfficePulse | FastAGI bootstrap |
| 8085/tcp | inbound | AidaAdmin backend, AidaHandset | provisioning + call-control API (CIDR-gated) |
| 8088/tcp | outbound | OfficePulse | ARI REST + events WebSocket |
| 3306/tcp | outbound | OfficePulse | Asterisk Realtime MySQL + `aida_officepulse` |
| 443/tcp | outbound | NocoDB, LiveKit Cloud, Pusher, provisioning server | configuration reads, room/agent control, notifications, handset provisioning |
| 8085/tcp | inbound | LiveKit Cloud | signed webhooks — the one route not CIDR-gated |

No ARI, MySQL, or FastAGI exposure beyond the private LAN — ever. The
LiveKit webhook is the single inbound exception and is authenticated by
signature over the raw request body rather than by network position.

## Development

```bash
npm ci
npm run verify      # typecheck + all unit tests (no external credentials needed)
npm run dev         # run against a configured environment
npm run simulate:ari   # fake ARI server (WS + REST) for local runs
npm run simulate:agi   # place a fake FastAGI call against a running service
```

A clean checkout runs the entire test suite with fakes for Asterisk
(FastAGI + ARI), both MySQL databases, NocoDB, LiveKit, Pusher, and the
provisioning server — no OfficePulse, NocoDB, or LiveKit credentials are
required.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | production requires all credentials + non-empty CIDRs |
| `OFFICEPULSE_INSTANCE_ID` | — (required in prod) | instance identifier recorded on every call session |
| `FASTAGI_PORT` / `FASTAGI_BIND` | 4573 / 0.0.0.0 | FastAGI listener |
| `FASTAGI_ADVERTISED_HOST` | aida-integration.internal | host written into provisioned AGI() rows |
| `FASTAGI_MAX_CONNECTIONS` / `FASTAGI_SESSION_TIMEOUT_MS` | 50 / 10000 | FastAGI hardening |
| `HTTP_PORT` / `HTTP_BIND` | 8085 / 0.0.0.0 | private HTTP API |
| `TRUSTED_SERVER_CIDRS` | — (required in prod) | callers allowed on `/v1/*` |
| `TRUSTED_PROXY_CIDRS` | empty | peers whose X-Forwarded-For is honored |
| `HTTP_RATE_LIMIT_PER_MINUTE` / `HTTP_MAX_BODY_BYTES` | 300 / 65536 | API rate/body limits |
| `ARI_URL` / `ARI_USERNAME` / `ARI_PASSWORD` / `ARI_APP` | — / — / — / aida | ARI connection |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | — | Asterisk Realtime DB |
| `RUNTIME_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | Asterisk host / 3306 / — / — / aida_officepulse | runtime DB this service owns |
| `NOCODB_BASE_URL` / `NOCODB_API_TOKEN` / `NOCODB_BASE_NAME` / `NOCODB_TIMEOUT_MS` | — / — / AidaAdmin / 4000 | read-only configuration base |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_SIP_HOST` | — (required in prod) | room control, agent dispatch, webhook verification, SIP destination |
| `LIVEKIT_AGENT_NAME` / `LIVEKIT_TIMEOUT_MS` | aida-prime / 5000 | predefined agent to dispatch |
| `PUSHER_APP_ID` / `PUSHER_KEY` / `PUSHER_SECRET` / `PUSHER_CLUSTER` | unset | call-arrival notification (notification only) |
| `CALL_DEFAULT_LOCALE` | en-US | locale passed in per-call agent metadata |
| `OPERATOR_FALLBACK_CONTEXT` / `OPERATOR_FALLBACK_EXTENSION` | unset | emergency fallback; both or neither |
| `PROVISIONING_SERVER_BASE_URL` / `_AUTH_TOKEN` / `_TIMEOUT_MS` | unset | existing HTTPS provisioning server |
| `HANDSET_API_URL` | derived | URL AidaHandset enrols against |
| `LIVEKIT_TRUNK_ENDPOINT` | unset | PJSIP endpoint name of the existing LiveKit SIP trunk |
| `TAKEOVER_RING_TIMEOUT_SECONDS` / `TAKEOVER_DRAIN_TIMEOUT_MS` | 20 / 10000 | takeover behavior |
| `TAKEOVER_DEFAULT_MOH_CLASS` | default | hold treatment while the destination rings |
| `DIALPLAN_*`, `DEFAULT_SIP_TRANSPORT`, `DEFAULT_SIP_ALLOW` | see `src/config.ts` | dialplan/codec defaults |

## Deployment

- `deploy/sql/schema.sql` — bookkeeping tables (in the Realtime DB).
- `deploy/sql/runtime-schema.sql` — the `aida_officepulse` runtime database
  (call sessions/events, control commands, LiveKit participants, webhook
  deliveries, provisioning operations, dependency status, DID fallback
  projection). No transcript table exists by design.
- `deploy/sql/grants.sql` — least-privilege MySQL account.
- `asterisk/` — dialplan include, ARI/HTTP/extconfig/MOH templates for
  the OfficePulse host.
- `deploy/systemd/aida-integration.service` + `scripts/install.sh` /
  `scripts/validate.sh` / `scripts/rollback.sh` — host install with kept
  previous release; or `Dockerfile` (non-root) for containers.
- `prompts/` + `scripts/generate-prompts.sh` / `scripts/deploy-prompts.sh`
  — checksum-pinned prompt pipeline; corrupt or missing audio fails
  deployment before any reload.

## Security model (POC)

- Private-LAN CIDR trust on the HTTP API, enforced in the firewall *and*
  in-process (`TRUSTED_SERVER_CIDRS`); production refuses to start with
  an empty allowlist. `X-Forwarded-For` is trusted only from
  `TRUSTED_PROXY_CIDRS`.
- SIP secrets exist **only** in `ps_auths`, returned exactly once on
  create/rotation. Enrollment tokens pass through a single provisioning
  transaction. Log redaction is structural (key-name based) and applies
  to every log line; the route token is never logged.
- Idempotency: linkedid for bootstrap (one call session and one LiveKit
  room per call), requestId for provisioning, idempotency keys for control
  commands, delivery ids for webhooks — all enforced by unique constraints
  rather than by convention.
- A create or rotation **replay never re-serves an existing SIP secret**;
  it reports the operation as already applied, and recovering a lost
  response requires an explicit, auditable rotation.
- Per-call agent metadata is a strict allowlist: prompt/business context,
  identifiers and locale only. Model, STT, TTS and voice are inherited from
  the predefined `aida-prime` agent and are never sent.
- MAC addresses are lookup data only — never an authentication factor.
- Logs and metrics correlate by `callSessionId`/`linkedid` only.
- A fallback destination is always tenant-checked: routing one tenant's
  caller into another tenant's extension is refused outright, even when
  that leaves only congestion.
