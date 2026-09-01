import type { Logger } from '../logging/logger.js';
import type { DialplanRow, RealtimeStore } from './store.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { DestinationType } from '../nocodb/configRepository.js';
import { requireBoolean, requireContext, requireE164, requireUuid, throwIfProblems } from './validate.js';
import { ValidationError } from '../errors.js';

export interface DidInput {
  didE164: string;
  context: string;
  fastAgiPath?: string;
  enabled: boolean;
  /**
   * Fail-safe association (issue #9). Optional so the provisioning path
   * AidaAdmin uses today keeps working, but a DID provisioned without it
   * has no destination of its own to fall back to when the cloud is
   * unavailable — so its absence is logged as the gap it is.
   */
  tenantId?: string;
  destinationType?: DestinationType;
  destinationId?: string;
}

export interface DidServiceDeps {
  store: RealtimeStore;
  runtime?: RuntimeStore;
  logger: Logger;
  officePulseInstanceId: string;
  fastAgiHost: string;
  fastAgiPort: number;
  disclosureContext: string;
  postBootstrapContext: string;
}

/**
 * Realtime dialplan rows for an inbound DID. Fixed, deterministic order:
 *
 *   DID -> recording disclosure -> FastAGI bootstrap -> post-bootstrap
 *
 * The rows NEVER route directly to a destination — routing decisions come
 * from the FastAGI bootstrap and the static aida-post-bootstrap include,
 * which also owns the local fallback path.
 */
export function didDialplanRows(didRouteId: string, deps: DidServiceDeps, fastAgiPath: string): DialplanRow[] {
  return [
    { priority: 1, app: 'NoOp', appdata: `aida-did ${didRouteId}` },
    { priority: 2, app: 'Set', appdata: `OFFICEPULSE_INSTANCE_ID=${deps.officePulseInstanceId}` },
    { priority: 3, app: 'Set', appdata: 'ASTERISK_LINKEDID=${CHANNEL(linkedid)}' },
    { priority: 4, app: 'Gosub', appdata: `${deps.disclosureContext},s,1` },
    { priority: 5, app: 'AGI', appdata: `agi://${deps.fastAgiHost}:${deps.fastAgiPort}${fastAgiPath}` },
    { priority: 6, app: 'Goto', appdata: `${deps.postBootstrapContext},s,1` },
  ];
}

export class DidProvisioningService {
  constructor(private readonly deps: DidServiceDeps) {}

  async provision(didRouteIdRaw: string, raw: DidInput): Promise<{ status: string; fallbackPersisted: boolean }> {
    const problems: string[] = [];
    const didRouteId = requireUuid(didRouteIdRaw, 'didRouteId', problems);
    const didE164 = requireE164(raw.didE164, 'didE164', problems);
    const context = requireContext(raw.context, 'context', problems);
    const enabled = requireBoolean(raw.enabled, 'enabled', problems);
    const fastAgiPath = raw.fastAgiPath ?? '/bootstrap';
    if (!/^\/[a-zA-Z0-9/_-]{0,60}$/.test(fastAgiPath)) {
      problems.push('fastAgiPath must be an absolute path of safe characters');
    }

    // The fail-safe association is all-or-nothing: a partial one would
    // produce a fallback that cannot be tenant-checked.
    const hasAnyFallbackField =
      raw.tenantId !== undefined || raw.destinationType !== undefined || raw.destinationId !== undefined;
    let tenantId = '';
    let destinationId = '';
    let destinationType: DestinationType | undefined;
    if (hasAnyFallbackField) {
      tenantId = requireUuid(raw.tenantId, 'tenantId', problems);
      destinationId = requireUuid(raw.destinationId, 'destinationId', problems);
      if (raw.destinationType !== 'EXTENSION' && raw.destinationType !== 'RING_GROUP') {
        problems.push('destinationType must be EXTENSION or RING_GROUP');
      } else {
        destinationType = raw.destinationType;
      }
    }
    throwIfProblems(problems);

    const existing = await this.deps.store.getAidaObject('DID', didRouteId);
    const conflicting = await this.deps.store.findDidObjectByExten(context, didE164);
    if (conflicting && conflicting.external_id !== didRouteId) {
      throw new ValidationError(`DID ${didE164} is already routed by another did_route`);
    }

    await this.deps.store.withTransaction(async (tx) => {
      if (existing && (existing.context !== context || existing.exten !== didE164)) {
        await tx.deleteDialplan(existing.context, existing.exten);
      }
      if (enabled) {
        await tx.replaceDialplan(context, didE164, didDialplanRows(didRouteId, this.deps, fastAgiPath));
      } else {
        await tx.deleteDialplan(context, didE164);
      }
      await tx.upsertAidaObject({
        kind: 'DID',
        external_id: didRouteId,
        tenant_id: tenantId === '' ? null : tenantId,
        context,
        exten: didE164,
        endpoint_id: null,
        enabled: enabled ? 1 : 0,
      });
    });

    // Written after the dialplan so a projection never points at a DID
    // that failed to provision.
    let fallbackPersisted = false;
    if (destinationType && this.deps.runtime) {
      await this.deps.runtime.upsertDidFallback({
        didRouteId,
        tenantId,
        didE164,
        destinationType,
        destinationId,
        enabled,
      });
      fallbackPersisted = true;
    } else if (!destinationType) {
      this.deps.logger.warn('DID provisioned without a local destination; cloud-outage fallback will use the operator default', {
        didRouteId,
      });
    }

    this.deps.logger.info('did provisioned', { didRouteId, context, fallbackPersisted });
    return { status: 'provisioned', fallbackPersisted };
  }
}
