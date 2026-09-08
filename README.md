# OfficePulseAidaIntegration

The canonical development service exposes private Asterisk endpoint/queue
inventory and read-only integration call diagnostics. Asterisk/OfficePulse is
the source of truth for PBX configuration. AidaAdmin administers Identity
businesses, users, roles, business numbers and AI profiles and reads PBX data
through this service.

There is no copied extension/queue desired state, provisioning synchronization,
retry ledger, ring-group adapter or rollback switch. PBX writers and the NocoDB
routing graph have been removed. Reusable ARI, LiveKit, FastAGI, takeover and
device modules and their tests remain. With voice enabled, ARI reconciliation,
signed LiveKit callbacks and FastAGI still run; native queue admission is pending,
so bootstrap preserves PBX fallback and TAKEOVER returns 503 before recording a
command. DRAIN_ACK remains supported. Canonical device admission is unwired until
native PBX authorization is defined. AidaHandset/AidaAgent work is deferred.

## Current API

| Listener | Routes | Access |
| --- | --- | --- |
| Private `HTTP_PORT=8085` | `/v1/admin/pbx/extensions?iTenantId=N`, `/v1/admin/pbx/queues?iTenantId=N` | CIDR-admitted Admin server; explicit operator tenant scope |
| Private `HTTP_PORT=8085` | `/v1/admin/calls/:id`, `/v1/admin/calls/:id/events` | Read-only observed integration call history |
| Private `HTTP_PORT=8085` | POST `/v1/admin/calls/:id/commands` | DRAIN_ACK with voice enabled; TAKEOVER unavailable until native routing exists |
| Public `PUBLIC_HTTP_PORT=8086` | `/healthz`, `/readyz`, signed LiveKit webhook | Callback verifies signature; disabled voice returns 503 |

Retired provisioning and canonical device paths are absent (404 inside the
private boundary); setting old provisioning flags cannot restore them.
The private API is not browser authentication: AidaAdmin must authenticate its
staff actor and authorize the requested tenant/call before forwarding a request.

Read the [PBX inventory contract](docs/PBX_SOURCE_OF_TRUTH.md),
[runtime contract](docs/PLATFORM_API.md) and
[development cleanup manifest](docs/DEV_CLEANUP.md).

## Configuration

`NOCODB_BASE_URL` and `NOCODB_API_TOKEN` bootstrap `PlatformConfig.cfg_tbl_Setting`.
Nonblank environment overrides take precedence over `officepulse`, `aida`, then
`*` scopes. Restart after changing settings. OfficePulse no longer reads
AidaAdmin's extension, ring-group, DID, device or business-profile tables.

| Setting | Default | Purpose |
| --- | --- | --- |
| `HTTP_PORT` / `PUBLIC_HTTP_PORT` / `HTTP_BIND` | 8085 / 8086 / 0.0.0.0 | Private API and health/callback listener |
| `TRUSTED_SERVER_CIDRS` / `TRUSTED_PROXY_CIDRS` | Required in production / empty | Separate service and proxy trust |
| `HTTP_RATE_LIMIT_PER_MINUTE` / `HTTP_MAX_BODY_BYTES` | 300 / 65536 | HTTP limits |
| `RUNTIME_MYSQL_HOST`, `RUNTIME_MYSQL_PORT`, `RUNTIME_MYSQL_USER`, `RUNTIME_MYSQL_PASSWORD` | Explicit production values / port 3306 | Integration diagnostics database |
| `RUNTIME_MYSQL_DATABASE` | aidacalls_db | Only canonical runtime schema; migrations reject the external asterisk schema |
| `NOCODB_BASE_URL`, `NOCODB_API_TOKEN`, `NOCODB_BASE_NAME`, `NOCODB_TIMEOUT_MS` | Required / PlatformConfig / 4000 | Scoped settings discovery |
| `PBX_INVENTORY_ENABLED` | false | Enable private vendor configuration reads |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE` | Explicit production values / port 3306 | External OfficePulse vendor database coordinates |
| `PBX_INVENTORY_MYSQL_USER`, `PBX_INVENTORY_MYSQL_PASSWORD` | Required when inventory enabled | Dedicated SELECT-only account |
| `PBX_INVENTORY_TENANTS_JSON` | no mappings | Reviewed tenant-to-context/queue allowlist |

`VOICE_ENABLED=false` is the canonical development setting. With voice enabled,
`ARI_URL`, `ARI_USERNAME`, `ARI_PASSWORD`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and `LIVEKIT_SIP_HOST` remain required in production;
`OFFICEPULSE_INSTANCE_ID` identifies this service. `FASTAGI_PORT` defaults to 4573,
`FASTAGI_BIND` to 0.0.0.0. Existing takeover timing/MOH and optional Pusher settings
remain supported. PBX writer credentials and Identity/device-admission settings
are no longer required by startup. Native queue admission is reported unavailable
independently from connector readiness.

Readiness reports runtime MySQL and NocoDB as critical, and PBX inventory as a
separate degraded component when not configured/unavailable. ARI is critical
when voice is enabled; LiveKit and native-admission availability are reported
separately. It never claims
live PBX registrations or calls were validated. With no external PBX connection,
Admin shows inventory unavailable while business administration and integration
history remain usable.

## Development and deployment

Use Node 22: `npm ci`, `npm run verify`, then `npm run build`. The Dockerfile
builds a non-root runtime image. The current authorized deployment is
`dockerappvm01-dev`; it does not change the separate physical OfficePulse PBX.
Startup runs the original checksum-verified runtime migrations followed by the
explicit two-table projection cleanup migration described in the manifest. This development data is disposable;
no old configuration copies, compatibility switch or rollback window is needed.
The systemd installer and generic Asterisk templates remain available for separately
reviewed deployments; this change does not execute them or modify the PBX host.

`TEST_MYSQL_URL` enables runtime migration/concurrency tests,
`TEST_WEBHOOK_MYSQL_URL` tests independent event transaction primitives, and
`TEST_PBX_MYSQL_URL` tests vendor inventory SELECT grants against disposable
fixtures. Those tests are not actual OfficePulse MariaDB or live-call evidence.
