import type { ApiRequest, Route } from './httpServer.js';
import { ValidationError } from '../errors.js';
import { CALL_LIST_STATES, type CallListState, type RuntimeQueries } from '../runtime/queries.js';

/**
 * Private, server-only reads of this service's runtime state for AidaAdmin's
 * calls, dependencies and issues screens. AidaAdmin authenticates staff and
 * scopes each request to a tenant before calling; these routes are
 * CIDR-admitted like every other private route and are not exposed through
 * the Operations gateway.
 */
export function runtimeQueryRoutes(queries: RuntimeQueries): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/v1/admin/calls',
      handler: async (req) => {
        const state = (req.query?.get('state') ?? 'all') as CallListState;
        if (!CALL_LIST_STATES.includes(state)) throw new ValidationError(`state must be one of ${CALL_LIST_STATES.join(', ')}`);
        const calls = await queries.listCallSessions({ state, tenantId: tenant(req), limit: integer(req, 'limit') });
        return { status: 200, body: { calls } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/admin/calls/:callSessionId/commands',
      handler: async (req) => ({ status: 200, body: { commands: await queries.listControlCommands(req.params.callSessionId ?? '') } }),
    },
    {
      method: 'GET',
      pattern: '/v1/admin/calls/:callSessionId/participants',
      handler: async (req) => ({ status: 200, body: { participants: await queries.listParticipants(req.params.callSessionId ?? '') } }),
    },
    {
      method: 'GET',
      pattern: '/v1/admin/runtime/webhook-deliveries',
      handler: async (req) => ({ status: 200, body: { deliveries: await queries.listWebhookDeliveries(integer(req, 'limit')) } }),
    },
    {
      method: 'GET',
      pattern: '/v1/admin/runtime/dependencies',
      handler: async () => ({ status: 200, body: { dependencies: await queries.listDependencyStatus() } }),
    },
    {
      method: 'GET',
      pattern: '/v1/admin/runtime/failed-commands',
      handler: async (req) => ({
        status: 200,
        body: { commands: await queries.listFailedCommands(integer(req, 'sinceHours') ?? 24, tenant(req)) },
      }),
    },
    {
      method: 'GET',
      pattern: '/v1/admin/runtime/events',
      handler: async (req) => {
        const types = req.query?.getAll('type').filter(Boolean) ?? [];
        if (!types.length) throw new ValidationError('at least one type is required');
        return { status: 200, body: { events: await queries.listEventsOfType(types, integer(req, 'sinceHours') ?? 24, tenant(req)) } };
      },
    },
  ];
}

/** Omitted means every tenant; a present but blank value is a caller bug, not "all". */
function tenant(req: ApiRequest): string | undefined {
  const value = req.query?.get('tenantId');
  if (value === null || value === undefined) return undefined;
  if (!value.trim()) throw new ValidationError('tenantId must not be blank');
  return value;
}

function integer(req: ApiRequest, name: string): number | undefined {
  const value = req.query?.get(name);
  if (value === null || value === undefined) return undefined;
  if (!/^[0-9]{1,6}$/.test(value)) throw new ValidationError(`${name} must be a whole number`);
  return Number(value);
}
