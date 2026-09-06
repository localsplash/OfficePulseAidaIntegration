# Development network boundary

| Source | Destination | Port | Purpose |
| --- | --- | --- | --- |
| NPM | OfficePulse public listener | 8086 (host mapping 18085) | Device bearer APIs, signed LiveKit webhook, health |
| AidaAdmin backend | OfficePulse private listener | 8085 | CIDR-admitted provisioning/admin commands |
| OfficePulse PBX | Integration | 4573 | FastAGI; allow only the PBX address |
| Integration | PBX | 8088, 3306 | ARI and supported Realtime provisioning |
| Integration / Admin | Integration MySQL | 3306 | Separate runtime-writer / Admin-reader accounts |
| Platform servers | Identity / NocoDB | Deployment-specific private HTTP(S) | Canonical authorization/configuration |
| Agent / Integration / Android | LiveKit | Service ports over TLS | Worker/media/data/control |

Expose only the public HTTP listener through NPM. Private routes are absent
from it. Keep 8085, FastAGI, ARI and SQL off public ingress. Set proxy CIDRs to
the actual NPM peer(s), and server CIDRs to backend service addresses. CIDR
admission trusts controlled services; it is not user authorization. Admin must
validate its central staff actor before invoking the private API.

The Android app uses HTTPS and a device bearer token; the LiveKit webhook uses
a signature bound to the raw body. Both have body and rate limits. All SIP/RTP
rules belong to the existing PBX/LiveKit deployment and require its verified
addresses. Do not copy generic public SIP rules into this host composition.
