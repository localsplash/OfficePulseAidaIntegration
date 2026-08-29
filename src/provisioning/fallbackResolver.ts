import type { FallbackResolver } from '../agi/bootstrapHandler.js';
import type { RealtimeStore } from './store.js';

/**
 * Resolves AidaControl destination UUIDs to the concrete dialplan
 * location recorded by the provisioning API (aida_object), so the
 * FastAGI bootstrap can hand the dialplan a local fallback target.
 */
export class StoreFallbackResolver implements FallbackResolver {
  constructor(private readonly store: RealtimeStore) {}

  async resolveDestination(
    kind: 'EXTENSION' | 'RING_GROUP',
    externalId: string,
  ): Promise<{ context: string; exten: string } | undefined> {
    const obj = await this.store.getAidaObject(kind, externalId);
    if (!obj || obj.enabled !== 1) return undefined;
    return { context: obj.context, exten: obj.exten };
  }
}
