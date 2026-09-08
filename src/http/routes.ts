import type { Route } from './httpServer.js';
import type { TakeoverManager } from '../takeover/takeoverManager.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { LiveKitWebhookHandler } from '../livekit/webhookHandler.js';
import { NotFoundError, ValidationError } from '../errors.js';

export interface RouteDeps {
  takeover: TakeoverManager;
  runtime: RuntimeStore;
  /** An adapter must validate native PBX destinations for this tenant; canonical startup has none yet. */
  destinationResolver?: { resolveDestination(type: 'EXTENSION' | 'QUEUE', id: string, tenantId: string): Promise<{ context: string; exten: string } | undefined> };
  webhooks: LiveKitWebhookHandler;
  defaultRingTimeoutSeconds: number;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Call-control commands this service will act on. Anything else is refused. */
const ALLOWED_COMMANDS = new Set(['TAKEOVER', 'DRAIN_ACK']);

/**
 * Private call-control API; no provisioning routes. All routes sit behind the
 * CIDR/rate/body-limit middleware in HttpApi, except the LiveKit webhook,
 * which authenticates by signature over the raw body instead.
 */
export function buildRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/calls/:callSessionId',
      operationsAccess: { scope: 'call-session', param: 'callSessionId' },
      handler: async (req) => {
        const session = await deps.runtime.getCallSession(req.params.callSessionId ?? '');
        if (!session) throw new NotFoundError(`no call session ${req.params.callSessionId}`);
        return { status: 200, body: session };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/calls/:callSessionId/events',
      operationsAccess: { scope: 'call-session', param: 'callSessionId' },
      handler: async (req) => {
        const events = await deps.runtime.listCallEvents(req.params.callSessionId ?? '');
        return { status: 200, body: { events } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/calls/:callSessionId/commands',
      operationsAccess: { scope: 'call-session', param: 'callSessionId' },
      handler: async (req) => {
        const callSessionId = req.params.callSessionId ?? '';
        const body = asObject(req.body);
        const problems: string[] = [];
        const commandType = typeof body.commandType === 'string' ? body.commandType : '';
        if (!ALLOWED_COMMANDS.has(commandType)) {
          problems.push(`commandType must be one of ${[...ALLOWED_COMMANDS].join(', ')}`);
        }
        const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
        if (idempotencyKey === '') problems.push('idempotencyKey is required');
        if (problems.length > 0) throw new ValidationError('invalid call command', problems);

        const session = await deps.runtime.getCallSession(callSessionId);
        if (!session) throw new NotFoundError(`no call session ${callSessionId}`);

        // No command row or call version change while native destination admission is unavailable.
        if (commandType === 'TAKEOVER' && !deps.destinationResolver) return {
          status: 503, body: { error: 'native_destination_unavailable', message: 'Native PBX queue takeover is not configured' },
        };

        // A duplicate submission returns the recorded outcome instead of
        // running the command a second time.
        const claim = await deps.runtime.claimControlCommand({
          callSessionId,
          idempotencyKey,
          commandType,
          payload: { ...body, ...(req.operator ? { _operationsActor: req.operator } : {}) },
          status: 'in-progress',
        }, typeof body.expectedCallVersion === 'number' ? body.expectedCallVersion : undefined);
        if (!claim.claimed) {
          if (claim.existing?.status === 'failed') return {
            status: 409,
            body: { status: 'failed', error: 'The previous command failed; refresh before starting a new command.', duplicate: true },
          };
          return {
            status: 200,
            body: { status: claim.existing?.status ?? 'in-progress', result: claim.existing?.result, duplicate: true },
          };
        }

        try {
          const result =
            commandType === 'TAKEOVER'
              ? await runTakeover(deps, session.id, session, body, idempotencyKey)
              : await deps.takeover.acknowledgeDrain(callSessionId);
          await deps.runtime.completeControlCommand(callSessionId, idempotencyKey, 'completed', {
            ...(result as Record<string, unknown>),
          });
          return { status: 202, body: result };
        } catch (err) {
          await deps.runtime.completeControlCommand(callSessionId, idempotencyKey, 'failed', {
            error: (err as Error).message,
          });
          throw err;
        }
      },
    },
    {
      method: 'POST',
      pattern: '/v1/integrations/livekit/webhooks',
      // Authenticated by LiveKit's signature over the raw body, not by CIDR:
      // the callback arrives from LiveKit Cloud, outside the private LAN.
      trusted: false,
      rawBody: true,
      handler: async (req) => {
        const outcome = await deps.webhooks.handle(req.rawBody ?? Buffer.alloc(0), req.headers.authorization);
        return { status: outcome.accepted ? 200 : 401, body: outcome };
      },
    },
  ];
}

async function runTakeover(
  deps: RouteDeps,
  callSessionId: string,
  session: { destinationType?: string; destinationId?: string; tenantId: string },
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  // The destination comes from the call session pinned at bootstrap, not
  // from the request: a command may not redirect a call to an arbitrary
  // extension, and certainly not to another tenant's.
  const destinationType = (body.destinationType as string | undefined) ?? session.destinationType;
  const destinationId = (body.destinationId as string | undefined) ?? session.destinationId;
  if (destinationType !== 'EXTENSION' && destinationType !== 'QUEUE') {
    throw new ValidationError('destinationType must be EXTENSION or QUEUE');
  }
  if (!destinationId) throw new ValidationError('destinationId is required');
  if (
    session.destinationId !== undefined &&
    (destinationId !== session.destinationId || destinationType !== session.destinationType)
  ) {
    throw new ValidationError("takeover destination does not match this call's pinned destination");
  }

  const target = await deps.destinationResolver!.resolveDestination(destinationType, destinationId, session.tenantId);
  if (!target) throw new NotFoundError(`destination ${destinationId} is not available for this tenant`);

  return deps.takeover.takeover({
    callSessionId,
    idempotencyKey,
    destinationType,
    context: target.context,
    exten: target.exten,
    ringTimeoutSeconds:
      typeof body.ringTimeoutSeconds === 'number' ? body.ringTimeoutSeconds : deps.defaultRingTimeoutSeconds,
    musicOnHoldClass: typeof body.musicOnHoldClass === 'string' ? body.musicOnHoldClass : undefined,
  });
}
