# Operations deployment

Run the built integration service on OfficePulse with Node 22. The existing API
listeners remain on `HTTP_BIND` (use `127.0.0.1` behind nginx), ports 8085 and 8086.
Enable the separate human operations listener with the following PlatformConfig
settings in the `officepulse` application scope:

| Setting | Dev value |
| --- | --- |
| `OPS_ENABLED` | `true` |
| `OPS_PUBLIC_URL` | `https://officepulse-admin.localsplash.dev` |
| `OPS_API_URL` | `https://officepulse-api.localsplash.dev` |
| `OPS_HTTP_PORT` | `8087` |

Keep bootstrap and secret values in a root-readable service environment file.
When Identity uses secret admission, supply `OPS_IDENTITY_CLIENT_SECRET` matching
its admitted application secret. With CIDR admission, admit the OfficePulse host
at Identity instead. Login uses `/authorize`, exchanges a single-use code at
`/api/token`, and revalidates `/api/sessions/introspect` on every data request.
The fixed HTTPS callback is `OPS_PUBLIC_URL` + `/ops/auth/callback`. Only central
Super Admins may enter. No local password or separate user database is created.

### Identity base URL

The Identity URL is not duplicated into the operations settings (#20). In
PlatformConfig mode the login and session-introspection origin defaults to the
Identity application's own `APP_BASE_URL` record (`cfg_tbl_Setting`,
`app = identity`), resolved and validated as an HTTPS origin once at startup as
described in the README's "Identity base URL" section. A missing, blank,
duplicate or malformed record, or a NocoDB failure during that lookup, is reported
as a configuration error and is never replaced by a guessed host or another
application's URL. An explicit `OPS_IDENTITY_URL` keeps precedence when the
operations login must use a different Identity origin; in
`PLATFORM_CONFIG_MODE=environment` the default is the environment's `ID_BASE_URL`.
Do not set `ID_BASE_URL` in PlatformConfig mode: it fails startup as a retired
override. A change to the central record takes effect at the next restart;
nothing is hot reloaded.

The authenticated interactive API console is at `OPS_PUBLIC_URL` + `/ops/docs`.
Browser requests use the same-origin `/ops/api/v1/admin/*` gateway, which revalidates
Identity, validates the requested Asterisk `context` grammar for inventory and
provisioning routes, restricts call lookups to an enabled tenant, and requires
Origin plus CSRF proof for every non-read method. The gateway supports GET, POST, PUT, PATCH and
DELETE, but a new private route is not exposed merely by existing: its `Route`
must opt in with `operationsAccess` and declare context-query, platform, or
call-session authorization. The UI toolbar selects one context from
`/ops/api/contexts` (which also reports `pbxInstanceId`) and reads
`/ops/api/contexts/:context/extensions|queues`; `/ops/api/tenants/:id/calls/:callId`
stays tenant-authorized because a call belongs to a customer. This prevents future internal maintenance endpoints from silently
becoming browser-accessible.

Optional live diagnostics use `OPS_ARI_URL=http://127.0.0.1:8088/ari`,
`OPS_ARI_USERNAME` and `OPS_ARI_PASSWORD`. Create a dedicated ARI user with
`type=user` and **`read_only=yes`**, using a protected included configuration file.
Reload `res_ari.so` after configuration, without restarting Asterisk. The operations
client only GETs Asterisk info, endpoints and channels; it never changes PBX state.
These credentials are independent of the voice connector. `VOICE_ENABLED=false`
remains supported. Missing ARI diagnostics show unavailable, never fabricated zeroes.

At nginx, terminate valid TLS for `officepulse-admin.localsplash.dev` and proxy all
paths to `http://127.0.0.1:8087`. Forward Host and HTTPS protocol, overwrite forwarded
client addresses, and use a small request body limit. Do not point this host at
the vendor Apache default page. Keep phone provisioning on its existing IP/port.

On `officepulse-api.localsplash.dev`, proxy `/`, `/docs`, `/docs/`, `/docs/*` and
`/openapi.json` to the public listener on 8086 alongside health, signed callbacks and `/v1/handset/` on 8086.
Retain the existing trusted-backend ACL for `/v1/admin/` on 8085. Do not expose
internal listener ports publicly. Swagger assets are bundled, require no CDN, and
offer no interactive command submission.

AidaAdmin's `OFFICEPULSE_API_BASE_URL` belongs in PlatformConfig's **`aida-admin`**
scope, with value `https://officepulse-api.localsplash.dev`. It is not a browser
setting and must not include an internal port. Remove stale environment overrides.

Validate public TLS, anonymous data rejection, central login and revocation,
the context listing, native queue member counts and Swagger assets after restarting
the integration and reloading nginx. A successful diagnostics deployment does not
prove live call takeover, carrier registration, native CDR coverage or maintenance
operations; those capabilities remain separate work.

## Source version and health checks

`GET /healthz` on both API listeners returns HTTP 200 with:

```json
{
  "status": "ok",
  "version": "2026.9.14.14.30",
  "revision": "<full Git commit ID>",
  "sourceUpdatedAt": "2026-09-14T14:30:42-07:00",
  "timeZone": "America/Los_Angeles",
  "dirty": false
}
```

`npm run build` stamps the artifact with the HEAD commit's **committer time in
Pacific time (`America/Los_Angeles`, PST/PDT)**, formatted `YYYY.M.D.H.M` (month, day, hour, minute without padding).
This is calendar versioning, not a five-part npm/SemVer package version.
The package version and OpenAPI contract version remain separate concepts.
The commit timestamp originates from the machine creating the commit (including
GitHub when it creates a merge commit), not the build machine's current clock.
The display timezone is explicitly pinned, independent of host/container `TZ`.
`sourceUpdatedAt` includes the applicable Pacific offset, and `timeZone` names the
zone. The repeated hour when daylight saving time ends can repeat a version;
use `revision` for identity and the offset-bearing timestamp for chronology.
No manual version bump is needed: commit the code, build, and restart the service.
Rebuilding the same commit keeps the same version, regardless of build time.
The full `revision` distinguishes commits within one minute and is the definitive
check against the expected branch HEAD. Commit timestamps depend on Git's clock
and are not a guaranteed monotonic sequence across branches or rewritten history.

Tracked modifications, staged changes, or untracked non-ignored files append
`-dirty` to the version and set `dirty: true`; deploy from a clean checkout for an
exact revision identity. `npm run dev` reports `unbuilt` and null revision metadata.
Compiled metadata is embedded in `dist/buildInfo.js`; runtime environment changes
or later Git commits cannot change the running process's identity.

Docker excludes `.git`, so pass source metadata explicitly from the checkout:

```sh
docker build -t aida-integration:local \
  --build-arg BUILD_REVISION="$(git rev-parse HEAD)" \
  --build-arg SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" \
  --build-arg BUILD_DIRTY="$(test -z "$(git status --porcelain)" && echo false || echo true)" .
```

For a source archive, set the same three environment variables before
`npm run build`. Missing or malformed identity fails the build rather than
silently using the build clock. CI supplies these arguments automatically.
`SOURCE_DATE_EPOCH` follows the [reproducible-builds source timestamp convention](https://reproducible-builds.org/docs/source-date-epoch/);
the readable version follows [CalVer](https://calver.org/).

## Handset deployment artifacts

`deploy/nginx/officepulse-api.localsplash.dev.conf` is the exact installed API
site, including the handset location. Compare it with
`/etc/nginx/sites-available/officepulse-api-canonical` after installation to detect
drift. Keep X-Forwarded-For overwritten and loopback-only proxy trust unchanged.
`PUBLIC_URL=https://officepulse-api.localsplash.dev scripts/validate.sh` checks
public handset routing. See [Handset API](HANDSET_API.md) for migration 007, contact
read grants, Pusher settings, takeover dialplan and real-phone acceptance.

Health and readiness also report `environmentName` and `pbxInstanceId`, resolved
from PlatformConfig before startup. Follow the README naming/migration procedure
so profile assignments change in lockstep and historical calls remain untouched.
