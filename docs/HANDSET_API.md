# Handset API

OfficePulse recognizes a handset app from one unexpired Asterisk `ps_contacts`
registration. It matches the request's public address against the SIP contact URI
and a normalized app-reported local address against `via_addr`. Loopback and
link-local addresses are ignored. The trusted proxy policy is unchanged: nginx
overwrites X-Forwarded-For and only the configured loopback proxy is trusted.
`HANDSET_REQUIRE_PUBLIC_IP_MATCH=false` deliberately relaxes only the public-IP
check for multi-WAN offices. A matching MAC claim is optional; the registration's
user-agent MAC is audit information, never an enrollment credential.

This authorizes **a device on the same network as the registered phone**, not the
physical phone. Anyone on that trusted office LAN able to reach the API can claim
its local address. This is the agreed POC trust model. Follow-up: distribute a
per-device credential through phone provisioning before expanding that trust.

All routes return `Cache-Control: no-store`, enforce request size and per-source
rate limits, and use HTTPS through the existing public nginx listener. No handset
connects to NocoDB. No enrollment codes or MAC allow-list are used.

| Route | Request / response |
| --- | --- |
| POST `/v1/handset/attach` | `{appInstanceId,localIps,deviceModel,appVersion,claimedMac?}` → `{token,expiresAt,device:{id,pbxInstanceId,context,endpointId,extension,label}}` |
| GET `/v1/handset/me` | Bearer token → `{device,queues:[{name,channel}],pusher:{key,cluster}}`; `pusher:null` if disabled |
| GET `/v1/handset/calls` | `{calls:[{id,state,version,queue,callerNumber?,startedAt}]}` for screening/ringing calls |
| GET `/v1/handset/calls/{id}` | `{call:{…,agentParticipantSid?,takeover?},livekit?:{url,token,expiresIn:120}}` |
| POST `/v1/handset/calls/{id}/takeover` | `{idempotencyKey,expectedCallVersion}` → accepted state or recorded replay |
| POST `/v1/handset/logout` | Revoke bearer and remove observer from call rooms |
| GET `/v1/admin/handsets?context=X` | CIDR-admitted backend or authenticated Operations gateway: `{handsets:[…]}` |
| DELETE `/v1/admin/handsets/{id}?context=X` | Revoke scoped session and remove observer; re-attach remains possible |

Zero contact matches return 403 `handset_not_recognized`; multiple matches return
409 `handset_ambiguous`. These errors echo only the compared request `publicIp`
and normalized `localIps`, never registration rows or other endpoints.

Every `/v1/handset/*` request is recorded, always on, in
`/var/log/officepulse-aida-integration/handset-requests-YYYY-MM-DD.jsonl` (UTC days,
systemd `LogsDirectory=`): client IP, user agent, request body, status and error.
Valid JSON is stored parsed with secret-looking keys redacted; anything else as text.
The bearer header and response bodies (which carry the token) are never recorded.
The service deletes day files older than 14 days.

Device tokens contain 32 random bytes, base64url encoded. Only SHA-256 hashes are
stored, with a default 24-hour expiry (`HANDSET_TOKEN_TTL_SECONDS`, maximum 86400).
A new attach supersedes earlier sessions for the same app install or endpoint on
this PBX. The database serializes replacement, including simultaneous attaches.
Authenticated requests update last-seen at most once per minute.

Calls are visible only for the same PBX instance and context, a live QUEUE
destination, and membership through `PJSIP/<endpoint>` or the endpoint's dialable
`Local/<extension>@<context>` (also `/n`). Missing authorization returns 404;
the list omits inaccessible calls. Membership caches expire within 30 seconds.
Existing `admitted`/`agent-ready` diagnostics are exposed as `screening` to the
handset; Agent lifecycle records and bootstrap v2 remain unchanged.

Issuing a room token rechecks the pinned registration binding within 30 seconds.
The 120-second LiveKit grant has identity `handset-<deviceId>`, room
`aida-<callSessionId>`, `roomJoin:true`, `hidden:true`, and `canSubscribe`,
`canPublish`, `canPublishData`, `canUpdateOwnMetadata` all false. Hidden observers
do not alter Agent participant monitoring. Every 30 seconds the room guard removes
revoked, expired, reassigned, or unauthorized handsets without touching SIP or
Agent participants or another PBX's rooms. Removal failures retry on the next sweep.
See the [LiveKit grant reference](https://docs.livekit.io/frontends/reference/tokens-grants/).

## Notifications

Use a separate Pusher app per environment. `officepulse` PlatformConfig rows
`PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET` (`bSecret=1`), `PUSHER_CLUSTER` supply
server credentials; optional `PUSHER_TIMEOUT_MS` defaults to 3000. Blank app ID
disables alerts. Restart after changes. `me` gives the app only the public key,
cluster, and authorized channel list; refresh it on start, reconnect and every ten
minutes. Never put Pusher secrets into a handset or service environment override.

Public channel names are `aida;{pbxInstanceId};{context};{queue}`. Parts cannot
contain semicolons. Over 164 characters becomes `aida;h;` plus the first 40 hex
characters of SHA-256 of the full name. This follows
[Pusher's channel naming rules](https://pusher.com/docs/channels/using_channels/channels/).
The `call` event is exactly `{v:1,eventId,callSessionId,state,occurredAt}` and carries
no caller number, DID, prompt or transcript. State changes publish after durable
persistence; duplicate lifecycle deliveries do not notify twice. Pusher is optional,
fire-and-forget, and degraded-only in readiness. Clients fetch authoritative call
state and tolerate missing, duplicate or reordered alerts.

## Handset takeover

Only the attached endpoint can be targeted: `Local/<endpointId>@aida-takeover`.
Client destination fields are ignored. Staff TAKEOVER remains unavailable (503).
The command key is SHA-256 of `deviceId:key`; atomic call-version claiming prevents
double execution. A stale version returns 409 `stale_version`, a running takeover
409 `takeover_in_progress`, and an answered call 409 `already_taken`. A replay
returns its recorded acknowledgement without another originate. Call detail shows
the eventual outcome in `takeover:{status,reason?,mine}`. The command payload and
request event record the device/endpoint for Admin diagnostics.

The originate passes `__AIDA_TAKEOVER=1` and `__AIDA_TAKEOVER_RING_SECONDS` from
`TAKEOVER_RING_TIMEOUT_SECONDS`. The dialplan rejects missing guards, invalid
endpoint names/timeouts and busy endpoint state. Only its dedicated pre-dial
handler adds `Call-Info: <sip:127.0.0.1>;answer-after=0`. It adds no Alert-Info.
Normal queue/internal calls do not invoke this handler. Caller ID is retained.
Failure keeps Aida with the caller, records busy/rejected/no-answer/failed, and
sends `transfer_failed`; bridging sends `human_answered` and starts bounded drain.

GXV3450 provisioning must use its own parameters, not the unrelated `P90`:
`P2981=1` allows tagged auto-answer and `P2862=3` selects speaker mode. Disable
mute (`P2863=0`) and call-waiting/barging (`P2983=0`, `P2860=0`) for predictable
handovers, and enable incoming SIP from proxy only on the device. Read back the
actual device UI after re-provisioning. Never select answer-all-calls. Physical
acceptance requires immediate two-way audio, busy/DND fallback without barging,
Agent drain, and ordinary queue/internal calls still ringing normally.

## Deployment

1. Startup applies `007_handset_devices.sql` in the integration runtime database.
   Legacy enrollment/session tables are dropped; no backup is required on dev.
2. Apply the added SELECT grant for `asterisk.ps_contacts` from
   `deploy/sql/pbx-inventory-grants.sql`. Inventory readiness names this grant when
   unavailable; this is not a vendor-schema migration.
3. Install `deploy/nginx/officepulse-api.localsplash.dev.conf` byte-for-byte at
   `/etc/nginx/sites-available/officepulse-api-canonical`, `nginx -t`, reload nginx.
4. Install include v2 from `asterisk/extensions_aida.conf` and reload the dialplan.
5. Restart the integration after PlatformConfig and profile assignment updates.
6. Run `PUBLIC_URL=https://officepulse-api.localsplash.dev scripts/validate.sh`.
   The empty public attach must return application 400, never edge 404.
7. Verify Pusher, inventory and native admission readiness, then test a real call
   from the GXV3450 app: attach, alert, call list, takeover, two-way audio, drain,
   and failed handover while busy/DND. Automated/fake tests do not prove hardware audio.
