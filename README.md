# OfficePulseAidaIntegration

The canonical development service exposes private Asterisk endpoint/queue
inventory, opt-in POC provisioning, and integration call diagnostics. Asterisk/OfficePulse is
the source of truth for PBX configuration. AidaAdmin administers Identity
businesses, users, roles, business numbers and AI profiles, and manages scoped
PBX objects through this service.

There is no copied extension/queue desired state, provisioning synchronization,
retry ledger, ring-group adapter or rollback switch. The optional writer changes
Asterisk Realtime directly; the NocoDB routing graph remains removed. Reusable ARI, LiveKit, FastAGI, takeover and
device modules and their tests remain. With voice enabled, ARI reconciliation,
signed LiveKit callbacks and FastAGI still run. Agent bootstrap v2 and native
queue admission are available through explicit opt-in configuration; disabled
admission preserves PBX fallback. TAKEOVER returns 503 before recording a command
until its separate native destination resolver is supplied. DRAIN_ACK remains supported. Handset attach, scoped observation and device-targeted takeover use live native SIP registrations and queue membership.

## Current API

| Listener | Routes | Access |
| --- | --- | --- |
| Private `HTTP_PORT=8085` | `/v1/admin/pbx/contexts`, `/v1/admin/pbx/extensions?context=X`, `/v1/admin/pbx/queues?context=X` | CIDR-admitted Admin server; scope is one Asterisk context on this PBX instance |
| Private `HTTP_PORT=8085` | extension, queue, queue-member and DID mutations under `/v1/admin/pbx` | Explicit opt-in writer; same context scope and Admin controls (DID routes add `didContext`) |
| Private `HTTP_PORT=8085` | `/v1/admin/calls/:id`, `/v1/admin/calls/:id/events` | Read-only observed integration call history |
| Private `HTTP_PORT=8085` | POST `/v1/admin/calls/:id/commands` | DRAIN_ACK with voice enabled; TAKEOVER unavailable until native routing exists |
| Private `HTTP_PORT=8085` | GET/DELETE `/v1/admin/handsets` | Context-scoped device administration |
| Public `PUBLIC_HTTP_PORT=8086` | `/v1/handset/attach`, `/me`, `/calls`, `/logout`, call detail/takeover | Registration matching then device bearer auth; see handset runbook |
| Public `PUBLIC_HTTP_PORT=8086` | POST `/v1/agent/calls/:id/bootstrap` | One-time call credentials; explicit native admission opt-in |
| Public `PUBLIC_HTTP_PORT=8086` | `/healthz`, `/readyz`, signed LiveKit webhook | Callback verifies signature; disabled voice returns 503 |

Legacy `/v1/provisioning`, `/v1/devices` and device `/v1/calls` paths remain absent. The smaller
PBX writer exists only under `/v1/admin/pbx` when explicitly enabled.
The private API is not browser authentication: AidaAdmin must authenticate its
staff actor, authorize the requested tenant, resolve that tenant's Asterisk
contexts, and authorize the call before forwarding a request. A context name
selects the routing scope `{pbxInstanceId, context}`; it is never authorization by itself.

Read the [PBX inventory contract](docs/PBX_SOURCE_OF_TRUTH.md),
[runtime contract](docs/PLATFORM_API.md) and
[development cleanup manifest](docs/DEV_CLEANUP.md).

## Configuration

`NOCODB_BASE_URL` and `NOCODB_API_TOKEN` bootstrap `PlatformConfig.cfg_tbl_Setting`.
Nonblank environment overrides take precedence over `officepulse`, `aida`, then
`*` scopes. Restart after changing settings. OfficePulse no longer reads
AidaAdmin's retired extension, ring-group, DID or device tables. Opt-in native
admission reads the persisted per-context/DID profile assignments
(`aida_tbl_ProfileAssignment`, managed through AidaAdmin) for a pinned call snapshot.

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
| `OFFICEPULSE_INSTANCE_ID` | `officepulse-dev` outside production | PBX instance wire name `pbxInstanceId` (`^[A-Za-z0-9_.-]{1,80}$`); with an Asterisk context it forms the routing scope |
| `PBX_INVENTORY_TENANTS_JSON` | retired | Startup fails when set: PBX scope is the Asterisk context. See `docs/PBX_SOURCE_OF_TRUTH.md` (Migrating from tenant maps) |
| `PBX_PROVISIONING_ENABLED` | false | Register the POC PBX mutation routes |
| `PBX_PROVISIONING_MYSQL_USER`, `PBX_PROVISIONING_MYSQL_PASSWORD` | required when enabled | Dedicated Realtime writer account |
| `NATIVE_ADMISSION_ENABLED` | false | Opt in to native Agent bootstrap; see `docs/AGENT_BOOTSTRAP.md` |
| `AGENT_PROFILE_IDS_JSON` | retired | Startup fails when set: profiles are assigned per context/DID in `aida_tbl_ProfileAssignment` through AidaAdmin. See `docs/AGENT_BOOTSTRAP.md` |
| `AGENT_CONFIG_REFRESH_SECONDS` | 300 (range 30–3600) | Background refresh of the cached profiles; never a call-path timeout |
| `AGENT_IDENTITY_TENANT_CHECK` | false | Consult Identity's runtime tenant check during refresh only, never during a call |

`VOICE_ENABLED=false` is the canonical development setting. With voice enabled,
`ARI_URL`, `ARI_USERNAME`, `ARI_PASSWORD`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and `LIVEKIT_SIP_HOST` remain required in production;
`OFFICEPULSE_INSTANCE_ID` names this PBX instance (`pbxInstanceId` in `/readyz`, inventory
responses, dispatch metadata and profile snapshots). `FASTAGI_PORT` defaults to 4573,
`FASTAGI_BIND` to 0.0.0.0. Existing takeover timing/MOH and optional Pusher settings
remain supported. PBX writer credentials are required only when its opt-in flag
is enabled; Handset device admission uses live registration matching. Native Agent admission uses the opt-in
settings in the bootstrap runbook; it loads the per-context/DID profile assignments at
startup and refreshes them in the background, so admission and active calls issue no
Identity or NocoDB request.

Readiness reports runtime MySQL and NocoDB as critical, and PBX inventory as a
separate degraded component when not configured/unavailable. ARI is critical
when voice is enabled; LiveKit and native-admission availability are reported
separately. It never claims
live PBX registrations or calls were validated. With no external PBX connection,
Admin shows inventory unavailable while business administration and integration
history remain usable.

Provision the platform database accounts with [`scripts/db-users.sh`](scripts/db-users.sh)
before startup. It uses the existing runtime settings and AidaAdmin reader URL,
creates `aida_runtime`/`aidaadmin_ro`, and converges migration/read-only grants on
every run. See [database account ownership and operator instructions](docs/DB_USERS.md),
including the separate PBX account templates. The old runtime `grants.sql` is retired.

### Identity base URL

In PlatformConfig mode (the default) OfficePulse keeps no copy of the Identity
URL. At startup the settings reader loads the Identity application's own record,
`cfg_tbl_Setting` with `app = identity` and `settingKey = APP_BASE_URL`, validates
it as an HTTPS origin (no credentials, path, query or fragment; a trailing slash is
tolerated) and supplies it internally as `ID_BASE_URL` to the background tenant
check and, unless `OPS_IDENTITY_URL` is set explicitly, to the Operations login.
Only that record is consulted: another application's `APP_BASE_URL` is never
selected and the key is never looked up without the `app` filter. A missing or
blank record leaves the origin unset, so native admission refuses to start and
names the record; duplicate or malformed records and a NocoDB failure during the
lookup fail startup with an explicit configuration error. Errors and log lines
never include the setting value or NocoDB credentials.

| Setting | Default | Purpose |
| --- | --- | --- |
| `PLATFORM_CONFIG_MODE` | PlatformConfig | `environment` is the retained environment-only mode: NocoDB is not read and every setting, including `ID_BASE_URL`, comes from the process environment |
| `ID_BASE_URL` | resolved from `identity/APP_BASE_URL` | Retired as an input in PlatformConfig mode: a nonblank value in the environment or in any `*`/`aida`/`officepulse` row fails startup; set it by hand only in environment-only mode |
| `OPS_IDENTITY_URL` | the resolved Identity origin | An explicit value keeps precedence; see `docs/OPERATIONS.md` |

The record is read once at startup; a central change takes effect at the next
restart. Nothing is hot reloaded.

## Development and deployment

Use Node 22: `npm ci`, `npm run verify`, then `npm run build`. The Dockerfile
builds a non-root runtime image. The canonical integration runs on
`officepulse-dev`; AidaAdmin and central runtime storage run on `dockerappvm01-dev`.
Startup runs the original checksum-verified runtime migrations followed by the
explicit two-table projection cleanup migration described in the manifest. This development data is disposable;
no old configuration copies, compatibility switch or rollback window is needed.
The systemd installer and generic Asterisk templates remain available for separately
reviewed deployments; this change does not execute them or modify the PBX host.

## Operations UI and API documentation

The operations UI is served at `https://officepulse-admin.localsplash.dev/`.
Sign in with central Identity using a platform Super Admin account. It reads native
extensions and queues of a selected Asterisk context, service readiness, live ARI endpoints/channels, and tenant
integration call diagnostics. Every data request rechecks the central session.
Its authenticated API
console at `/ops/docs` can invoke explicitly browser-enabled Admin routes, including
call commands and enabled PBX provisioning. Mutations require a same-origin request and CSRF token; each route
must declare its authorization scope (context grammar, platform, or tenant-based call session) before the gateway exposes it.

Public, non-interactive Swagger remains at `https://officepulse-api.localsplash.dev/docs`.
The Super Admin console is at `https://officepulse-admin.localsplash.dev/ops/docs`.
The private API retains its backend network admission and is never called directly
by the browser.

See [operations deployment](docs/OPERATIONS.md) for settings, listener routing,
Identity admission and the separate read-only ARI account. Internal ports 8085–8087
are loopback upstreams; application clients use the public HTTPS names.

`TEST_MYSQL_URL` enables runtime migration/concurrency tests,
`TEST_WEBHOOK_MYSQL_URL` tests independent event transaction primitives, and
`TEST_PBX_MYSQL_URL` tests vendor inventory SELECT grants against disposable
fixtures. Those tests are not actual OfficePulse MariaDB or live-call evidence.

See [POC PBX provisioning](docs/PBX_PROVISIONING.md) for mutation contracts,
DID hours/ring/AI behavior, Identity authorization, installed-schema limits, table-backed
Realtime routing requirements, and apply-state limits.

`TEST_PBX_PROVISIONING_MYSQL_URL` validates writer grants and transactional context isolation on a disposable `aida_pbx_provisioning_*_test` database. `TEST_ASTERISK_BINARY` exercises the shared DID include in an isolated process without SIP/network modules. Neither test mutates the live PBX.

See [Agent bootstrap v2](docs/AGENT_BOOTSTRAP.md) for the #18/#19/#22/#23 implementation,
credential/profile contracts, context-scoped admission, native ingress and SIP prerequisites,
and live-call acceptance.

## Handsets and environment naming

Read [Handset API](docs/HANDSET_API.md) for registration-based attach, queue alerts,
hidden LiveKit observation, takeover, trust assumptions and deployment checks.
Attached handsets are listed in the Operations UI under the selected context.

Set `ENVIRONMENT_NAME` (`dev`, `staging`, `prod`) in PlatformConfig scope `*` and
`OFFICEPULSE_INSTANCE_ID` in scope `officepulse`. Health/readiness return both.
The instance must end with `-${ENVIRONMENT_NAME}` and may not contain
`preview`, `copy`, `temp`, `tmp`, `backup`, or `test` (case-insensitive). Missing
environment preserves legacy behavior with a startup warning. A multi-PBX host
may explicitly override the instance id in its environment; it must still obey
the central environment name. AidaAdmin's environment mismatch UI is owned by
localsplash/AidaAdmin#45; Agent bootstrap remains v2.

On dev use `officepulse-dev`. With no active calls, first rename its persisted
`aida_tbl_ProfileAssignment.pbx_instance_id`, then set the central instance and
remove its env override, and restart. Do not rename historical call records.
Verify `agent-config-cache` has at least one cached assignment and native admission
is ready; then validate a real admitted call. Bootstrap credentials alone should
remain in the service env file (`NOCODB_BASE_URL`, `NOCODB_API_TOKEN`); move other
host settings into `officepulse` scope, with secrets marked `bSecret=1`.
