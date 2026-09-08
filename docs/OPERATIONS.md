# Operations deployment

Run the built integration service on OfficePulse with Node 22. The existing API
listeners remain on `HTTP_BIND` (use `127.0.0.1` behind nginx), ports 8085 and 8086.
Enable the separate human operations listener with the following PlatformConfig
settings in the `officepulse` application scope:

| Setting | Dev value |
| --- | --- |
| `OPS_ENABLED` | `true` |
| `OPS_PUBLIC_URL` | `https://officepulse-admin.localsplash.dev` |
| `OPS_IDENTITY_URL` | `https://identity.localsplash.dev` |
| `OPS_API_URL` | `https://officepulse-api.localsplash.dev` |
| `OPS_HTTP_PORT` | `8087` |

Keep bootstrap and secret values in a root-readable service environment file.
When Identity uses secret admission, supply `OPS_IDENTITY_CLIENT_SECRET` matching
its admitted application secret. With CIDR admission, admit the OfficePulse host
at Identity instead. Login uses `/authorize`, exchanges a single-use code at
`/api/token`, and revalidates `/api/sessions/introspect` on every data request.
The fixed HTTPS callback is `OPS_PUBLIC_URL` + `/ops/auth/callback`. Only central
Super Admins may enter. No local password or separate user database is created.

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
`/openapi.json` to the public listener on 8086 alongside health and signed callbacks.
Retain the existing trusted-backend ACL for `/v1/admin/` on 8085. Do not expose
internal listener ports publicly. Swagger assets are bundled, require no CDN, and
offer no interactive command submission.

AidaAdmin's `OFFICEPULSE_API_BASE_URL` belongs in PlatformConfig's **`aida-admin`**
scope, with value `https://officepulse-api.localsplash.dev`. It is not a browser
setting and must not include an internal port. Remove stale environment overrides.

Validate public TLS, anonymous data rejection, central login and revocation,
tenant mappings, native queue member counts and Swagger assets after restarting
the integration and reloading nginx. A successful diagnostics deployment does not
prove live call takeover, carrier registration, native CDR coverage or maintenance
operations; those capabilities remain separate work.
