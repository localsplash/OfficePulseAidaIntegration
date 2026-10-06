# Canonical development network boundary

| Source | Destination | Port | Purpose |
| --- | --- | --- | --- |
| NPM | OfficePulse health listener | 8086 (host mapping 18085) | Health/readiness and signed LiveKit callback (503 with voice disabled) |
| AidaAdmin backend | OfficePulse private listener | 8085 | Tenant-authorized PBX inventory, call reads and allowlisted commands |
| Integration / Admin | Local integration MySQL | 3306 | Runtime schema/diagnostic writer and separate Admin SELECT account |
| Integration | NocoDB | Private HTTP | Scoped PlatformConfig settings discovery |
| Integration | External PBX MySQL, when separately configured | Private connection only | Dedicated SELECT account for reviewed inventory scopes |

With canonical Dev `VOICE_ENABLED=false`, FastAGI/ARI/LiveKit stay stopped.
Separately configured voice deployments retain private FastAGI4573 and outbound
ARI/LiveKit connectivity; device admission is not registered. Keep the private API and SQL off public ingress. CIDR admission
trusts controlled services; AidaAdmin must authenticate its human staff actor
and authorize tenant/call access. No external PBX host firewall is changed.
