# Authorized disposable development cleanup

This change applies to the canonical development service on dockerappvm01-dev.
The user explicitly authorized removing obsolete development data and compatibility
paths. It is not authorization to modify the separate OfficePulse PBX host.

## Application graph removed

The PBX provisioning writers, concrete NocoDB route/destination repository, and
projection fallback resolver are deleted. No production table reader remains for:

- `aida_tbl_Extension`
- `aida_tbl_RingGroup`
- `aida_tbl_RingGroupMember`
- `aida_tbl_DidRoute`
- `aida_tbl_ConfigurationSource`

AidaAdmin coordinates removal of those NocoDB metadata/physical tables after its
own readers/editors are removed. Keep `aida_tbl_TenantProfile` and
`aida_tbl_AssistantProfile` for business/AI administration. OfficePulse no longer
reads those business profiles; only `cfg_tbl_Setting` is a startup dependency.

## Integration runtime migration

`004_remove_retired_pbx.sql` runs only against configured `aidacalls_db` or a
disposable test schema after the existing checksum-verified migrations. Historical
migration files stay unchanged; rerunning startup does not recreate dropped tables.

| Removed table | Deleted exclusive application use |
| --- | --- |
| `provisioning_operation` | Provisioning outcome/idempotency accessors |
| `did_fallback` | Old generated DID destination projection and fallback resolver |

The migration removes only `asterisk-mysql` and `provisioning-adapter` dependency
rows for deleted PBX writers. Retained tables are `call_session`, `call_event`,
`control_command`, `livekit_participant`, `webhook_delivery`,
`aida_tbl_EventReceipt`, `aida_tbl_SchemaMigration`, `dependency_status`,
`aida_tbl_DeviceEnrollment` and `aida_tbl_DeviceSession`. These support call/event
processing, observed diagnostics and retained independent device primitives.

ARI reconciliation, LiveKit signed callbacks/event handling, FastAGI protocol,
TakeoverManager, device access/room-guard libraries and setup assets remain.
Canonical startup does not register device routes without native PBX authorization.
Its FastAGI bootstrap preserves the PBX-owned fallback; TAKEOVER returns 503 before
claiming a command until native destination resolution exists. DRAIN_ACK remains
available with voice enabled. `VOICE_ENABLED=false` disables connectors as before.

The prior development database name `aida_db` is no longer configured by this
service. The deployment coordinator may remove it after proving no running
application still references it. This source migration does not drop databases.

## External PBX exclusion

Do not drop/change `asterisk` vendor tables, PBX-side integration objects, native
CDR, recordings, endpoints, queues, dialplan, trunks, phone files or credentials
on the physical OfficePulse host. Its changes require a separately scoped PBX
implementation/deployment. The local development cleanup has no PBX connection
or credentials and does not fabricate vendor inventory data.

## Validation

HTTP tests prove provisioning/device admission routes are absent, private call
commands retain their contract, and inventory/call reads still work. Core tests
exercise ARI takeover/reconciliation, signed events and FastAGI fallback. The
canonical TAKEOVER test proves 503 changes neither command rows nor call version. The disposable runtime database test creates
retired table fixtures, runs cleanup, verifies their absence and proves existing
call history survives; rerunning initialization does not recreate removed tables.
Inventory tests continue to enforce tenant scopes and SELECT-only vendor access.
No compatibility flag or rollback window is required for this development reset.
