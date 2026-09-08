# OfficePulseAidaIntegration

Layer Aida onto OfficePulse without forking or modifying Asterisk source.

A TypeScript/Node.js service for the office platform. The first combined deployment target is **dockerappvm01-dev**. For the POC it is both
the **call orchestrator** and the Asterisk adapter — there is no
AidaControl service (issue #9). It provides:

1. **Inbound call orchestration** — FastAGI resolves the DID route and
   assistant profile directly from the shared PlatformConfig NocoDB base, pins the
   configuration it used onto a local call session, creates the LiveKit
   room, dispatches the predefined `aida-prime` agent, and hands Asterisk
   the routing variables.
2. **ARI takeover control** — asynchronous multi-channel control: bridge
   the caller with the LiveKit/Aida leg, ring a human on command, connect
   the human instantly on answer, and drain Aida within a bounded window.
3. **PBX inventory API** — AidaAdmin reads native endpoint and queue configuration
   from Asterisk through the private OfficePulse API. Asterisk is the PBX source
   of truth; AidaAdmin does not maintain extension/queue copies or sync status.
   Historical provisioning writers are disabled by default.

The [PBX source-of-truth decision and API contract](docs/PBX_SOURCE_OF_TRUTH.md)
defines the POC reads, tenant authorization references, queue semantics and
remaining supported command/routing and operations UI work. It supersedes the
historical ring-group provisioning architecture below.

## Data ownership

Applications may read shared databases, but each data set has exactly one
writer:

| Data set | Writer | This service |
|---|---|---|
| NocoDB `PlatformConfig` business/AI settings and PBX references | AidaAdmin | **reads only** |
| Asterisk endpoint, queue and dialplan configuration | OfficePulse PBX operations | **reads** through an explicit tenant scope; legacy writes require rollback opt-in |
| `aidacalls_db` runtime MySQL | this service | **writes** |
| `aidacalls_db` (AidaAdmin's view) | — | AidaAdmin reads via a read-only account; commands stay HTTP actions |

The [platform API and cutover contract](docs/PLATFORM_API.md) defines canonical
Identity tenant IDs, device authentication, startup migrations and the separate
public/private HTTP listeners. It supersedes conflicting legacy interface text.

## Project invariant

**No Aida failure or cleanup operation may tear down an established
caller-human bridge.** The takeover manager only ever removes the
LiveKit/Aida leg; if the human disappears during the drain window, the
drain is aborted and the caller stays with Aida.

## Historical call flow (queue-native cutover pending)

```
inbound DID (Realtime rows, written by this service's provisioning API)
  -> recording disclosure (always, before FastAGI/LiveKit)
  -> AGI(agi://LSAidaOffice01:4573/bootstrap)
       -> read DID route + assistant profile from the NocoDB PlatformConfig base
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

## Network

Private HTTP `8085` serves PBX inventory and AidaAdmin administration. Public
HTTP `8086` serves device bearer APIs and signed LiveKit webhooks through HTTPS
at NPM. FastAGI `4573`, ARI and MySQL stay private. See the
[firewall matrix](deploy/firewall-matrix.md) and [API contract](docs/PLATFORM_API.md).

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

## Configuration

`NOCODB_BASE_URL` and `NOCODB_API_TOKEN` bootstrap PlatformConfig. Runtime settings
resolve nonblank environment overrides, then `officepulse`, `aida` and `*` scopes.
Restart after changing settings. The inventory can run with voice disabled.

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
| `PBX_INVENTORY_ENABLED` | false | enable private PBX configuration reads, independently of LiveKit voice connectors |
| `PBX_INVENTORY_MYSQL_USER` / `PBX_INVENTORY_MYSQL_PASSWORD` | — | dedicated SELECT-only account on the same PBX host/database |
| `PBX_INVENTORY_TENANTS_JSON` | no scopes | operator-owned tenant-to-context/queue-name allowlist; see the PBX contract |
| `LEGACY_PBX_PROVISIONING_ENABLED` | false | explicit rollback opt-in for historical provisioning writes |
| `RUNTIME_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | Asterisk host / 3306 / — / — / aidacalls_db | runtime DB this service owns |
| `NOCODB_BASE_URL` / `NOCODB_API_TOKEN` / `NOCODB_BASE_NAME` / `NOCODB_TIMEOUT_MS` | — / — / PlatformConfig / 4000 | read-only configuration base |
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
- `deploy/sql/runtime-schema.sql` — historical baseline consumed by the startup migration runner, which targets configured `aidacalls_db`; do not execute it directly
  (call sessions/events, control commands, LiveKit participants, webhook
  deliveries, provisioning operations, dependency status, DID fallback
  projection). No transcript table exists by design.
- `deploy/sql/grants.sql` — least-privilege MySQL account.
- `deploy/sql/pbx-inventory-grants.sql` — separate read-only PBX inventory account; manually apply only after verifying the installed realtime mapping.
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


### Administration preview before voice provisioning

Set `VOICE_ENABLED=false` on a new preview deployment to run the database-backed
administration and device APIs before configuring PBX and LiveKit. Runtime MySQL,
Identity and PlatformConfig remain required, including an explicit
`RUNTIME_MYSQL_HOST`. ARI, FastAGI, voice dependency probes and room monitoring do
not start; PBX changes, call commands and LiveKit webhooks return 503, and device
responses omit room tokens. `/healthz` returns 200 while `/readyz` reports the
disabled dependencies with 503. Use health for container liveness; readiness still
means the full voice service is available. The default is `VOICE_ENABLED=true`.

This setting is for initial setup on an isolated deployment. Do not toggle it on
a server with active calls or connected handset viewers, because room revocation
monitoring stops. Supply the real voice configuration and restart with
`VOICE_ENABLED=true` when the PBX and LiveKit project are ready.
