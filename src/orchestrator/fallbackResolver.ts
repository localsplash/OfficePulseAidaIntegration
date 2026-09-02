import type { Logger } from '../logging/logger.js';
import type { DestinationType } from '../nocodb/configRepository.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { RealtimeStore } from '../provisioning/store.js';

export interface DialplanTarget {
  context: string;
  exten: string;
}

export interface ResolvedFallback extends DialplanTarget {
  /** How this target was chosen — surfaced in logs and call events. */
  source: 'did-projection' | 'route-destination' | 'operator-default';
  tenantId?: string;
}

/** Both stored forms of an E.164 number: with and without the leading '+'. */
function didVariants(didE164: string): string[] {
  const trimmed = didE164.trim();
  const bare = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  return [`+${bare}`, bare];
}

export interface FallbackResolverDeps {
  runtime: RuntimeStore;
  realtime: RealtimeStore;
  logger: Logger;
  /**
   * Deployment-wide emergency destination. The LAST resort only: used when
   * a DID has no local projection at all, never in place of one.
   */
  operatorDefault?: DialplanTarget;
}

/**
 * Local fail-safe resolution (issue #9).
 *
 * When NocoDB, LiveKit, or bootstrap fails, the caller must still reach
 * THIS DID's own destination. The projection written at provisioning time
 * makes that possible without any cloud read.
 *
 * Tenant safety: a destination is only ever used when it belongs to the
 * same tenant as the DID. Routing one tenant's caller into another
 * tenant's extension would be worse than congestion, so it never happens —
 * a tenant mismatch drops through to the operator default, or to nothing.
 */
export class FallbackResolver {
  constructor(private readonly deps: FallbackResolverDeps) {}

  /** Resolves the fallback for an inbound DID, tenant-scoped throughout. */
  async resolveForDid(didE164: string): Promise<ResolvedFallback | undefined> {
    let projection;
    try {
      // Asterisk hands us whatever the trunk sent, which may lack the
      // leading '+' that provisioning normalized in. Missing the
      // projection over a plus sign would silently downgrade a DID's own
      // destination to the emergency default, so both forms are tried.
      for (const variant of didVariants(didE164)) {
        projection = await this.deps.runtime.getDidFallbackByDid(variant);
        if (projection) break;
      }
    } catch (err) {
      this.deps.logger.warn('did fallback lookup failed', { err });
    }

    if (projection?.enabled) {
      const target = await this.toDialplanTarget(
        projection.destinationType,
        projection.destinationId,
        projection.tenantId,
      );
      if (target) return { ...target, source: 'did-projection', tenantId: projection.tenantId };
      this.deps.logger.warn('did projection destination is not provisioned locally', {
        didRouteId: projection.didRouteId,
        destinationType: projection.destinationType,
      });
    }

    return this.operatorDefault('no local destination projection for this DID');
  }

  /**
   * Resolves a destination named by a live route (the SCREEN path's own
   * takeover target), scoped to the route's tenant.
   */
  async resolveDestination(
    destinationType: DestinationType,
    destinationId: string,
    tenantId: string,
  ): Promise<ResolvedFallback | undefined> {
    const target = await this.toDialplanTarget(destinationType, destinationId, tenantId);
    return target ? { ...target, source: 'route-destination', tenantId } : undefined;
  }

  private operatorDefault(reason: string): ResolvedFallback | undefined {
    const fallback = this.deps.operatorDefault;
    if (!fallback) {
      this.deps.logger.error('no fallback destination available; caller will hear congestion', { reason });
      return undefined;
    }
    this.deps.logger.warn('using deployment-wide operator emergency fallback', { reason });
    return { ...fallback, source: 'operator-default' };
  }

  /**
   * Maps an AidaAdmin destination id to the dialplan location the
   * provisioning API actually wrote, refusing any cross-tenant match.
   */
  private async toDialplanTarget(
    destinationType: DestinationType,
    destinationId: string,
    tenantId: string,
  ): Promise<DialplanTarget | undefined> {
    const object = await this.deps.realtime.getAidaObject(destinationType, destinationId);
    if (!object || object.enabled !== 1) return undefined;
    if (object.tenant_id !== null && object.tenant_id !== tenantId) {
      this.deps.logger.error('refusing cross-tenant fallback destination', {
        destinationType,
        expectedTenantId: tenantId,
        actualTenantId: object.tenant_id,
      });
      return undefined;
    }
    return { context: object.context, exten: object.exten };
  }
}
