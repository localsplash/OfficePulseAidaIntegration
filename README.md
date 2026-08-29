# OfficePulseAidaIntegration

Layer Aida onto OfficePulse without forking or modifying Asterisk source.

A TypeScript/Node.js service on **LSAidaOffice01** that gives the Aida
platform three capabilities against the OfficePulse Asterisk 22.10.1
Realtime PBX:

1. **FastAGI inbound bootstrap** — the synchronous routing decision for
   every inbound DID call (disclosure first, then AidaControl decides
   SCREEN / FALLBACK / REJECT).
2. **ARI takeover control** — asynchronous multi-channel control: bridge
   the caller with the LiveKit/Aida leg, ring a human on command, connect
   the human instantly on answer, and drain Aida within a bounded window.
3. **Realtime provisioning API** — private, typed HTTP API through which
   AidaAdmin's server provisions extensions, ring groups, DIDs, and
   MAC-based handsets into the Asterisk Realtime MySQL tables.

Normative contract: the
[Aida Office POC — Database and Input Interface Specification](https://github.com/localsplash/AidaInfrastructureSetupInstructions/blob/main/docs/AIDA_POC_DATABASE_AND_INTERFACE_SPECIFICATION.md).

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
       -> POST AidaControl /v1/integrations/officepulse/calls/bootstrap
       -> sets AIDA_DISPOSITION + routing channel variables
  -> [aida-post-bootstrap] static include
       SCREEN   -> Stasis(aida) -> ARI originates the LiveKit SIP-trunk leg
                   with X-Aida-Call-Session / X-Aida-Route-Token headers,
                   bridges caller <-> Aida  (media stays Asterisk<->LiveKit)
       FALLBACK -> failure prompt -> direct Dial to destination, with the
                   extension-side incident prompt on answer
       REJECT   -> hangup
  takeover command (AidaControl -> this service)
       -> single idempotent originate to extension/ring group
       -> MOH while ringing; on answer: human joins bridge immediately,
          Aida drains (<= 10 s or on drain-ack), only the Aida leg is removed
```

If this service, AidaControl, or ARI is down, the dialplan alone still
routes the caller: disclosure → failure prompt → configured destination.
Media never traverses this service.

## Network (private LAN only — see `deploy/firewall-matrix.md`)

| Port | Direction | Peer | Purpose |
|------|-----------|------|---------|
| 4573/tcp | inbound | OfficePulse | FastAGI bootstrap |
| 8085/tcp | inbound | AidaAdmin backend, AidaControl | provisioning + takeover API (CIDR-gated) |
| 8088/tcp | outbound | OfficePulse | ARI REST + events WebSocket |
| 3306/tcp | outbound | OfficePulse | Asterisk Realtime MySQL (least-privilege account) |
| — | outbound | AidaControl / provisioning server | bootstrap, events, handset provisioning |

No ARI, MySQL, or FastAGI exposure beyond the private LAN — ever.

## Development

```bash
npm ci
npm run verify      # typecheck + all unit tests (no external credentials needed)
npm run dev         # run against a configured environment
npm run simulate:ari   # fake ARI server (WS + REST) for local runs
npm run simulate:agi   # place a fake FastAGI call against a running service
```

A clean checkout runs the entire test suite with fakes for Asterisk
(FastAGI + ARI), MySQL, AidaControl, and the provisioning server — no
OfficePulse or LiveKit credentials are required.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | production requires all credentials + non-empty CIDRs |
| `OFFICEPULSE_INSTANCE_ID` | — (required in prod) | instance identifier sent to AidaControl |
| `FASTAGI_PORT` / `FASTAGI_BIND` | 4573 / 0.0.0.0 | FastAGI listener |
| `FASTAGI_ADVERTISED_HOST` | aida-integration.internal | host written into provisioned AGI() rows |
| `FASTAGI_MAX_CONNECTIONS` / `FASTAGI_SESSION_TIMEOUT_MS` | 50 / 10000 | FastAGI hardening |
| `HTTP_PORT` / `HTTP_BIND` | 8085 / 0.0.0.0 | private HTTP API |
| `TRUSTED_SERVER_CIDRS` | — (required in prod) | callers allowed on `/v1/*` |
| `TRUSTED_PROXY_CIDRS` | empty | peers whose X-Forwarded-For is honored |
| `HTTP_RATE_LIMIT_PER_MINUTE` / `HTTP_MAX_BODY_BYTES` | 300 / 65536 | API rate/body limits |
| `ARI_URL` / `ARI_USERNAME` / `ARI_PASSWORD` / `ARI_APP` | — / — / — / aida | ARI connection |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | — | Realtime DB |
| `AIDACONTROL_BASE_URL` / `AIDACONTROL_TIMEOUT_MS` | — / 4000 | AidaControl client |
| `PROVISIONING_SERVER_BASE_URL` / `_AUTH_TOKEN` / `_TIMEOUT_MS` | unset | existing HTTPS provisioning server |
| `HANDSET_AIDACONTROL_URL`, `PUSHER_KEY`, `PUSHER_CLUSTER` | — | AidaHandset managed configuration values |
| `LIVEKIT_TRUNK_ENDPOINT` | unset | PJSIP endpoint name of the existing LiveKit SIP trunk |
| `TAKEOVER_RING_TIMEOUT_SECONDS` / `TAKEOVER_DRAIN_TIMEOUT_MS` | 20 / 10000 | takeover behavior |
| `TAKEOVER_DEFAULT_MOH_CLASS` | default | hold treatment while the destination rings |
| `DIALPLAN_*`, `DEFAULT_SIP_TRANSPORT`, `DEFAULT_SIP_ALLOW` | see `src/config.ts` | dialplan/codec defaults |

## Deployment

- `deploy/sql/schema.sql` — bookkeeping tables (in the Realtime DB).
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
- Idempotency: linkedid for bootstrap, requestId for provisioning,
  idempotency keys for takeover commands, stored replay records.
- MAC addresses are lookup data only — never an authentication factor.
- Logs and metrics correlate by `callSessionId`/`linkedid` only.
