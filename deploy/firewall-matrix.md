# Firewall matrix — LSAidaOffice01 ↔ OfficePulse private LAN

All flows below are private-LAN IPv4 only. **Nothing in this matrix is
ever exposed publicly**: no public ARI, no public MySQL, no public
FastAGI, no public provisioning API.

| # | Source | Destination | Port/Proto | Purpose |
|---|--------|-------------|------------|---------|
| 1 | OfficePulse (Asterisk) | LSAidaOffice01 | 4573/tcp | FastAGI `/bootstrap` |
| 2 | AidaAdmin backend (LSAidaOffice01) | LSAidaOffice01 | 8085/tcp | Provisioning API (`/v1/provisioning/*`) |
| 3 | AidaAdmin backend / AidaHandset | LSAidaOffice01 | 8085/tcp | Call state and control commands (`/v1/calls/*`) |
| 4 | LSAidaOffice01 (this service) | OfficePulse | 8088/tcp | ARI REST + events WebSocket |
| 5 | LSAidaOffice01 (this service) | OfficePulse | 3306/tcp | Asterisk Realtime MySQL (least-privilege account) |
| 6 | LSAidaOffice01 (this service) | NocoDB (AidaAdmin base) | 443/tcp | Read-only configuration reads |
| 7 | LSAidaOffice01 (this service) | Provisioning server | 443/tcp | Grandstream/AidaHandset provisioning (HTTPS) |
| 8 | OfficePulse (Asterisk) | LiveKit Cloud SIP | SIP/RTP per trunk | Existing LiveKit SIP trunk (media path — never through this service) |
| 9 | LSAidaOffice01 (this service) | LiveKit Cloud API | 443/tcp | Room creation, `aida-prime` dispatch, data publishing |
| 10 | LSAidaOffice01 (this service) | Pusher | 443/tcp | Call-arrival notification (notification only) |
| 11 | LiveKit Cloud | LSAidaOffice01 | 8085/tcp | Signed webhooks — see the exception below |
| 12 | AidaAdmin backend | Runtime MySQL | 3306/tcp | Read-only account on `aida_officepulse` |

Deny-by-default everywhere else. In particular:

- 4573/tcp accepts connections **only** from the OfficePulse host.
- 8085/tcp accepts connections **only** from `TRUSTED_SERVER_CIDRS`
  (enforced by firewall **and** in-application CIDR checks — both layers
  are required; the application also refuses to start in production with
  an empty allowlist).
- 8088/tcp (ARI) and 3306/tcp (MySQL) on OfficePulse accept **only**
  LSAidaOffice01.
- `X-Forwarded-For` is honored only from `TRUSTED_PROXY_CIDRS` (empty by
  default: the socket peer is the client).

## The one exception: the LiveKit webhook

`POST /v1/integrations/livekit/webhooks` (flow 11) is the only route not
gated by `TRUSTED_SERVER_CIDRS`, because it is called by LiveKit Cloud from
outside the private LAN. It is authenticated instead by LiveKit's signature
over the **raw request body**, so a captured token cannot be replayed over
different content, and duplicate deliveries are suppressed by delivery id.
Rate limiting and the body-size cap still apply. If the deployment can
constrain LiveKit's source addresses, add them to `TRUSTED_SERVER_CIDRS`
and this route gains a second, independent guard.
