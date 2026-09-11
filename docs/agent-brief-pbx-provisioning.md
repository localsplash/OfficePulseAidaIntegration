# Agent implementation brief: native PBX provisioning and managed DID routing

## Objective

Implement the smallest production-shaped POC API through which AidaAdmin can manage tenant-scoped Asterisk extensions, native queues, queue membership, and DID routing. Asterisk remains the effective PBX source of truth. Do not restore the retired `/v1/provisioning/*` graph, NocoDB projection, retry ledger, or runtime `extensions.conf` rewriting.

Coordinate the public contract with the companion AidaAdmin implementation brief. Treat changes to either side of the contract as cross-repository changes and keep their tests aligned.

## Required architectural decisions

- Register mutations only when an explicit `PBX_PROVISIONING_ENABLED=true` setting and dedicated writer credentials are present. Disabled means the mutation routes are absent, not present-but-permissive.
- Keep the existing private network admission and authenticated Operations gateway. Every route must declare tenant-query authorization through canonical Identity `iTenantId`; never accept a tenant from an unverified forwarded header.
- Use a dedicated least-privilege MySQL account. Do not reuse the runtime migration account or inventory read account, perform DDL at application startup, or grant access to unrelated Asterisk tables.
- Write Asterisk Realtime tables directly and transactionally. The API must never edit `extensions.conf` or another `/etc/asterisk` file at runtime.
- Put shared call behavior in a version-controlled Asterisk dialplan subroutine in `asterisk/extensions_aida.conf`. Realtime DID rows should supply validated arguments and invoke the shared subroutine instead of duplicating branching logic for every DID.
- Hardcode LiveKit as the AI destination provider. Do not expose `aiProvider` in the API or UI. The installed PJSIP endpoint name is `livekit`.
- Native Asterisk queues replace the former simultaneous-dial/ring-group provisioning concept. Do not add another ring-group adapter.
- A successful database transaction is not automatically proof that cached/running Asterisk state is active. Return an honest apply state such as `committed`; return `active` only after an implementation has verified effective state through an appropriate Asterisk control/read interface.

## One-time Asterisk installation contract

Document and test the required operator-owned setup:

- Map `ps_endpoints`, `ps_auths`, `ps_aors`, `extensions`, `queues`, and `queue_members` through the installed Realtime driver.
- Include the versioned `extensions_aida.conf` once from the operator-owned `extensions.conf`.
- Configure the reviewed carrier ingress context once to consult the Realtime `extensions` family. This generic lookup is transport plumbing and must contain no DID-specific destination or delegation.
- Store every managed DID route in the Realtime `extensions` rows. Remove the supplied static `+19496501147` route after equivalent managed rows exist so the database is the sole source for that DID's handling.
- Supply a validation/runbook step that proves which source wins for a DID, that the queue exists, and that the LiveKit PJSIP endpoint is available.

The application must not silently claim it performed this installation. Readiness should report provisioning disabled, database unavailable, or Asterisk delegation/apply-state unknown distinctly.

## Tenant ownership model

- Continue treating tenant-to-PBX references as authorization metadata, not desired state.
- Existing imported contexts, queue names, and DIDs require explicit operator-approved ownership mapping. Extend the current tenant scope format with a managed inbound context and exact E.164 DID allowlist. Reject duplicate DID ownership across tenants.
- API-created endpoint IDs and queue IDs must be deterministic and tenant-namespaced so tenants may reuse extension numbers and friendly queue names safely. Keep the dialable extension inside its tenant context; never use a global extension-number lookup for authorization.
- Permit mapped legacy native names such as `concierge`, but never infer ownership of an arbitrary pre-existing queue merely from a prefix.
- All destructive operations must first resolve and lock the owned native object. A tenant must receive the same not-found response for absent and other-tenant objects.

## Canonical private API

Use `/v1/admin/pbx` exclusively and keep the existing inventory GET routes. Require exactly one positive safe-integer `iTenantId` on every route.

### Extensions

- `POST /v1/admin/pbx/extensions?iTenantId=N`
  - Input: dialable `extension`, optional context when the tenant has more than one, display name, and optional E.164 caller-ID number.
  - Create AOR, auth, endpoint, and tenant-context dialplan rows in one transaction.
  - Generate a strong SIP secret and return it exactly once. Inventory, logs, errors, and replay responses must never expose an existing secret.
  - Use a deterministic tenant-namespaced endpoint/auth/AOR ID and a documented POC transport/codec default.
- `DELETE /v1/admin/pbx/extensions/:extension?iTenantId=N`
  - Delete only the owned endpoint bundle, its dialplan entry, and its queue-member rows in one transaction.
  - Refuse or explicitly handle any remaining references; do not leave broken members.

Do not add update or secret-rotation scope unless required by an accepted follow-up. Keep this PR faithful to create/delete.

### Queues and membership

- `POST /v1/admin/pbx/queues?iTenantId=N`
  - Input: tenant-friendly name/slug and a small allowlist of supported native strategies, defaulting to `ringall`.
  - Generate or validate the native tenant-namespaced queue ID. Do not interpolate client strings into SQL.
- `DELETE /v1/admin/pbx/queues/:queue?iTenantId=N`
  - Delete members atomically with the queue.
  - Return conflict while a managed DID references the queue; require the DID to be changed/deleted first.
- `PUT /v1/admin/pbx/queues/:queue/extensions/:extension?iTenantId=N`
  - Idempotently create/update one native `queue_members` row.
  - Validate that both objects belong to the same tenant. Support bounded integer `penalty` and Boolean `paused`, with safe defaults.
- `DELETE /v1/admin/pbx/queues/:queue/extensions/:extension?iTenantId=N`
  - Delete only that owned mapping and return not found when it does not exist.

Inventory must treat an authorized but not-yet-created/deleted queue as a normal omission rather than making the entire tenant inventory unavailable.

### Managed DIDs

- `GET /v1/admin/pbx/dids?iTenantId=N`
  - Return only managed/recognized DID routes with normalized settings and apply state. Do not attempt to parse arbitrary operator-authored dialplan into a managed DTO; identify unmanaged allowed DIDs explicitly.
- `PUT /v1/admin/pbx/dids/:e164?iTenantId=N`
  - Input contract:
    - `queue`: an existing owned native queue.
    - `ringsBeforeAi`: integer 1 through 12.
    - optional `schedule` containing `timeRange` (`HH:MM-HH:MM`), Asterisk-compatible normalized weekdays (for example `mon-fri`), and an IANA timezone.
    - optional E.164 `livekitDestination`, defaulting to the DID itself.
  - There is no provider field. Compile the destination as `PJSIP/<destination>@livekit`.
  - Reject a DID outside the tenant's exact allowlist and reject a missing/cross-tenant queue before replacing any rows.
  - Replace all managed rows for the DID transactionally; never partially update a route.
- `DELETE /v1/admin/pbx/dids/:e164?iTenantId=N`
  - Delete only the recognized managed Realtime rows for that owned DID. Refuse to delete an unrecognized/manual dialplan route.

Represent enough versioned metadata in the deterministic managed Realtime rows to support the GET contract without reverse-engineering arbitrary dialplan. Do not add a second desired-state routing database merely to make GET easy.

## Shared DID subroutine semantics

Implement one versioned subroutine with these outcomes:

- No schedule: queue is open at all times.
- Inside schedule: enter the configured queue for the configured ring budget, then fall through to LiveKit if unanswered/unavailable.
- Outside schedule: go directly to LiveKit.
- Convert `ringsBeforeAi` to a timeout with one documented POC constant (five seconds per ring unless deployment evidence requires another value). Return the derived timeout in API responses so the approximation is visible.
- Preserve the existing call-recording behavior where applicable and avoid starting duplicate recordings.
- Fail closed for malformed arguments. Define and test the behavior when the queue or LiveKit endpoint becomes unavailable; do not create a dialplan loop.

Use native `GotoIfTime`, `Queue`, `Dial`, and `Hangup`/return behavior in the shared dialplan. Do not introduce a per-call external AGI or require this Node service to be reachable for ordinary schedule evaluation and queue fallback.

## Persistence and concurrency requirements

- Use prepared statements exclusively.
- Use transactions and row locks for multi-table create/delete and reference checks. Ensure a concurrent DID update cannot race a queue deletion into a broken committed route.
- Map duplicate keys to 409, invalid/out-of-scope input to 422, missing owned objects to 404, disabled provisioning to route absence or the documented unavailable result, and unexpected database details to a redacted 5xx response.
- Bound inventory reads and avoid credentials/auth columns in inventory responses.
- Never log SIP secrets, database credentials, complete bearer tokens, or unredacted upstream bodies.

## Documentation and deployment deliverables

- Update public and authenticated OpenAPI documents for every added route and schema.
- Add a manual least-privilege grant script covering only the required Realtime tables.
- Update the Realtime mapping template for native queues and members.
- Document enablement settings, tenant ownership mapping, the one-time generic Realtime ingress lookup, removal of DID-specific static routes, rollback, and the distinction between `committed` and `active`.
- Document the API contract expected by AidaAdmin, including URL encoding of `+` in DID path segments.
- Preserve current public-listener isolation: no PBX mutation route may be reachable through the public health/webhook listener.

## Tests and acceptance evidence

Add focused unit/HTTP tests for validation, tenant isolation, secret handling, queue-member idempotency, reference conflicts, deterministic DID compilation, schedule branches, hardcoded LiveKit routing, disabled mode, OpenAPI coverage, and public-listener denial.

Add an opt-in disposable MySQL integration test using representative Asterisk table shapes. It must prove transaction rollback and forbidden access with the proposed writer grants; it must refuse a non-test database name.

Before calling the POC operationally complete, record external PBX evidence for two tenants with overlapping extension numbers:

1. Create extensions and verify effective PJSIP endpoint visibility without exposing auth secrets.
2. Create queues, add/remove members, and verify native queue status.
3. Route one allowed DID during and outside its schedule.
4. Verify queue timeout reaches `PJSIP/<destination>@livekit` and a queue answer does not.
5. Prove an unauthorized tenant cannot read, mutate, or delete the other tenant's objects.
6. Prove `+19496501147` resolves from its managed Realtime rows and has no DID-specific static route.
7. Delete objects and verify there are no orphaned endpoint/auth/AOR/dialplan/member rows.

## Explicit non-goals

- Runtime rewriting of `extensions.conf` or automatic broad Asterisk configuration management.
- Retell/provider selection.
- Ring groups implemented as simultaneous `Dial` strings.
- Handset enrollment, extension update, secret rotation, carrier number provisioning, CDR/recording APIs, or LiveKit assistant-profile management.
- Restoring the retired NocoDB PBX desired-state graph or background reconciliation ledger.
