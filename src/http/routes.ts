import type { Route } from './httpServer.js';
import type { ExtensionProvisioningService, ExtensionCreateInput, ExtensionUpdateInput, RotateSecretInput } from '../provisioning/extensions.js';
import type { RingGroupProvisioningService, RingGroupInput } from '../provisioning/ringGroups.js';
import type { DidProvisioningService, DidInput } from '../provisioning/dids.js';
import type { HandsetProvisioningService, HandsetProvisionInput } from '../provisioning/handsets.js';
import type { TakeoverManager } from '../takeover/takeoverManager.js';
import type { FallbackResolver } from '../agi/bootstrapHandler.js';
import { NotFoundError, ValidationError } from '../errors.js';

export interface RouteDeps {
  extensions: ExtensionProvisioningService;
  ringGroups: RingGroupProvisioningService;
  dids: DidProvisioningService;
  handsets: HandsetProvisioningService;
  takeover: TakeoverManager;
  destinationResolver: FallbackResolver;
  defaultRingTimeoutSeconds: number;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/**
 * Private provisioning + operational API surface (spec §2.3 plus the
 * takeover command/drain-ack operations AidaControl drives). All routes
 * here sit behind the CIDR/rate/body-limit middleware in HttpApi.
 */
export function buildRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: 'POST',
      pattern: '/v1/provisioning/extensions',
      handler: async (req) => {
        const result = await deps.extensions.create(asObject(req.body) as unknown as ExtensionCreateInput);
        return { status: 201, body: result };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/provisioning/extensions/:extensionId',
      handler: async (req) => {
        const result = await deps.extensions.update(req.params.extensionId ?? '', asObject(req.body) as unknown as ExtensionUpdateInput);
        return { status: 200, body: result };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/provisioning/extensions/:extensionId/rotate-secret',
      handler: async (req) => {
        const result = await deps.extensions.rotateSecret(req.params.extensionId ?? '', asObject(req.body) as unknown as RotateSecretInput);
        return { status: 200, body: result };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/provisioning/ring-groups/:ringGroupId',
      handler: async (req) => {
        const result = await deps.ringGroups.provision(req.params.ringGroupId ?? '', asObject(req.body) as unknown as RingGroupInput);
        return { status: 200, body: result };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/provisioning/dids/:didRouteId',
      handler: async (req) => {
        const result = await deps.dids.provision(req.params.didRouteId ?? '', asObject(req.body) as unknown as DidInput);
        return { status: 200, body: result };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/provisioning/handsets',
      handler: async (req) => {
        const result = await deps.handsets.provision(asObject(req.body) as unknown as HandsetProvisionInput);
        return { status: 200, body: result };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/calls/:callSessionId/takeover',
      handler: async (req) => {
        const body = asObject(req.body);
        const problems: string[] = [];
        const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey !== '' ? body.idempotencyKey : '';
        if (idempotencyKey === '') problems.push('idempotencyKey is required');
        const destinationType = body.destinationType === 'EXTENSION' || body.destinationType === 'RING_GROUP' ? body.destinationType : undefined;
        if (!destinationType) problems.push('destinationType must be EXTENSION or RING_GROUP');
        const destinationId = typeof body.destinationId === 'string' ? body.destinationId : '';
        if (destinationId === '') problems.push('destinationId is required');
        if (problems.length > 0) throw new ValidationError('invalid takeover command', problems);

        const dest = await deps.destinationResolver.resolveDestination(destinationType as 'EXTENSION' | 'RING_GROUP', destinationId);
        if (!dest) throw new NotFoundError(`destination ${destinationId} is not provisioned`);

        const ack = await deps.takeover.takeover({
          callSessionId: req.params.callSessionId ?? '',
          idempotencyKey,
          destinationType: destinationType as 'EXTENSION' | 'RING_GROUP',
          context: dest.context,
          exten: dest.exten,
          ringTimeoutSeconds:
            typeof body.ringTimeoutSeconds === 'number' ? body.ringTimeoutSeconds : deps.defaultRingTimeoutSeconds,
          musicOnHoldClass: typeof body.musicOnHoldClass === 'string' ? body.musicOnHoldClass : undefined,
        });
        return { status: 202, body: ack };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/calls/:callSessionId/drain-ack',
      handler: async (req) => {
        const result = await deps.takeover.acknowledgeDrain(req.params.callSessionId ?? '');
        return { status: 200, body: result };
      },
    },
  ];
}
