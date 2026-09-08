# Canonical runtime API

Asterisk/OfficePulse owns PBX configuration. Identity owns users, tenants,
roles and business-number identity; AidaAdmin owns business and AI profiles.
OfficePulse reads only scoped service settings from PlatformConfig and native
PBX endpoint/queue inventory from the vendor database. There is no desired-state
copy, sync status or ring-group provisioning contract.

## Stores

`aidacalls_db` contains observed integration call sessions/events, command
history, participant/webhook observations, event receipts and dependency status.
Its rows are diagnostics, not a copy of current PBX configuration or native
Asterisk CDR. Existing observed destination labels/IDs may remain in historical
call rows. Canonical TAKEOVER cannot resolve these IDs as native routing intent.

The old `provisioning_operation` and `did_fallback` tables and accessors are
removed. Device enrollment/session tables and reusable device primitives remain;
canonical routes need a native authorization adapter before registration.
The migration runner is restricted to `aidacalls_db` and disposable `aida_*_test`
schemas. It cannot target the external `asterisk` database. The runner strips historical database-selection statements; no vendor DDL is
packaged or applied.

## HTTP

- Private GET `/v1/admin/pbx/extensions?iTenantId=N` and `/v1/admin/pbx/queues?iTenantId=N`
  follow the [inventory contract](PBX_SOURCE_OF_TRUTH.md).
- Private GET `/v1/admin/calls/:callSessionId` returns the observed session or 404.
- Private GET `/v1/admin/calls/:callSessionId/events` returns `{events:[...]}` for an
  call ID. It does not read the PBX CDR table.
- Private POST `/v1/admin/calls/:callSessionId/commands` retains the allowlisted
  `TAKEOVER`/`DRAIN_ACK`, idempotency key and optimistic version contract. Canonical
  `TAKEOVER` returns 503 `native_destination_unavailable` before a command claim.
  `DRAIN_ACK` remains supported when voice is enabled.
- POST `/v1/integrations/livekit/webhooks` verifies LiveKit's signature over the
  raw body and retains durable event handling. It is the only public application route.
- `/healthz` and `/readyz` are available on both listeners.

Provisioning routes are removed, and canonical device admission is not registered.
With `VOICE_ENABLED=false`, all voice mutations/callbacks return 503 `voice_unavailable`
and connectors stay stopped. With voice enabled, ARI reconciliation, LiveKit
callbacks and FastAGI run. FastAGI `/bootstrap` returns FALLBACK without overwriting
PBX-owned fallback variables or reading deleted projections. The protocol adapter
still supports injectable SCREEN decisions for a future verified native resolver.
Device, ARI, takeover, protocol/event libraries and their tests remain reusable.

The private listener is CIDR-admitted and never published through the browser
proxy. AidaAdmin authenticates staff and checks tenant/call access. A query ID,
forwarded header, MAC, phone number or recording filename is not authorization.
SQL read grants, scope mapping and HTTP trust are separate requirements.

## Remaining work

Native queue call admission/control, business DID-to-PBX references, authenticated
operations UI, native CDR/recording access and external PBX acceptance are tracked
in issues #2/#7 and AidaAdmin #29. AidaAgent and AidaHandset implementation remains
deferred. There is no separate AidaOfficePbxAdmin or AidaControl application.
