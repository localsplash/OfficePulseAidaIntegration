# Firewall matrix — LSAidaOffice01 ↔ OfficePulse private LAN

All flows below are private-LAN IPv4 only. **Nothing in this matrix is
ever exposed publicly**: no public ARI, no public MySQL, no public
FastAGI, no public provisioning API.

| # | Source | Destination | Port/Proto | Purpose |
|---|--------|-------------|------------|---------|
| 1 | OfficePulse (Asterisk) | LSAidaOffice01 | 4573/tcp | FastAGI `/bootstrap` |
| 2 | AidaAdmin backend (LSAidaOffice01) | LSAidaOffice01 | 8085/tcp | Provisioning API (`/v1/provisioning/*`) |
| 3 | AidaControl (LSAidaOffice01) | LSAidaOffice01 | 8085/tcp | Takeover command / drain-ack (`/v1/calls/*`) |
| 4 | LSAidaOffice01 (this service) | OfficePulse | 8088/tcp | ARI REST + events WebSocket |
| 5 | LSAidaOffice01 (this service) | OfficePulse | 3306/tcp | Asterisk Realtime MySQL (least-privilege account) |
| 6 | LSAidaOffice01 (this service) | AidaControl | per env | `bootstrapCall`, call events |
| 7 | LSAidaOffice01 (this service) | Provisioning server | 443/tcp | Grandstream/AidaHandset provisioning (HTTPS) |
| 8 | OfficePulse (Asterisk) | LiveKit Cloud SIP | SIP/RTP per trunk | Existing LiveKit SIP trunk (media path — never through this service) |

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
