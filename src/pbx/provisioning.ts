import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../errors.js';
import type { Route } from '../http/httpServer.js';
import type { PbxTenantScope, PbxTenantScopes } from './inventory.js';
import type { PbxProvisioner } from './provisioningStore.js';
import { contextName, didDialplanRows, e164, managedDid, name, object, parseDidSettings, recognizeDidRows } from './managedDid.js';
export { MysqlPbxProvisioner, type PbxProvisioner } from './provisioningStore.js';
export { didDialplanRows, type DidSettings, type DidSchedule, type DialplanRow } from './managedDid.js';

const STRATEGIES = new Set(['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear', 'wrandom']);
function tenantScope(query: URLSearchParams | undefined, scopes: PbxTenantScopes): { id: number; scope: PbxTenantScope } {
  const ids = query?.getAll('iTenantId') ?? []; const raw = ids[0] ?? '';
  if (ids.length !== 1 || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ValidationError('iTenantId must be a positive canonical Identity tenant ID');
  const scope = scopes.get(raw);
  if (!scope) throw new DependencyUnavailableError('No operator-approved PBX provisioning scope exists for this tenant');
  return { id: Number(raw), scope };
}
function extension(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{2,12}$/.test(value)) throw new ValidationError('extension must be 2-12 digits');
  return value;
}
function endpointId(ext: string, tenant: number): string { return `${ext}-t${tenant}`; }
function context(body: Record<string, unknown>, scope: PbxTenantScope): string {
  const selected = body.context === undefined && scope.contexts.length === 1 ? scope.contexts[0]! : contextName(body.context);
  if (!scope.contexts.includes(selected)) throw new ValidationError('context is outside this tenant scope');
  return selected;
}
function ownedDid(value: unknown, scope: PbxTenantScope, destructive = false): string {
  const did = e164(value);
  if (!scope.didContext || !scope.didNumbers?.includes(did)) {
    if (destructive) throw new NotFoundError('DID was not found in this tenant');
    throw new ValidationError('DID is outside this tenant allowlist');
  }
  return did;
}
function queueForCreation(value: unknown, id: number, scope: PbxTenantScope): string {
  const slug = name(value, 'name');
  if (scope.queueNames.includes(slug)) return slug;
  if (slug.length > 60) throw new ValidationError('queue friendly name must be at most 60 characters');
  return name(`t${id}.${slug}`, 'native queue ID');
}

/** No mutations exist unless both the explicit flag and dedicated writer configuration are supplied. */
export function pbxProvisioningRoutes(writer: PbxProvisioner | undefined, scopes: PbxTenantScopes, enabled: boolean): Route[] {
  if (!enabled || !writer) return [];
  const access = { scope: 'tenant-query' as const, query: 'iTenantId' };
  const routes: Route[] = [
    { method: 'POST', pattern: '/v1/admin/pbx/extensions', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes);
      const body = object(req.body, ['extension', 'context', 'displayName', 'callerIdNumber']);
      const ext = extension(body.extension); const ctx = context(body, scope);
      const displayName = body.displayName;
      if (displayName !== undefined && (typeof displayName !== 'string' || !/^[^"<>\\\x00-\x1f\x7f]{1,33}$/.test(displayName))) throw new ValidationError('displayName contains unsupported characters');
      const callerIdNumber = body.callerIdNumber === undefined ? undefined : e164(body.callerIdNumber, 'callerIdNumber');
      if (typeof displayName === 'string' && displayName.length + (callerIdNumber ?? ext).length + 5 > 40) throw new ValidationError('displayName and callerIdNumber exceed the native 40-character caller ID limit');
      const created = await writer.createExtension({ extension: ext, endpointId: endpointId(ext, id), context: ctx, displayName, callerIdNumber });
      return { status: 201, body: { ...created, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/extensions/:extension', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes); const ext = extension(req.params.extension);
      await writer.deleteExtension(ext, endpointId(ext, id), scope.contexts); return { status: 204 };
    } },
    { method: 'POST', pattern: '/v1/admin/pbx/queues', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes); const body = object(req.body, ['name', 'strategy']);
      const queue = queueForCreation(body.name, id, scope); const strategy = body.strategy === undefined ? 'ringall' : body.strategy;
      if (typeof strategy !== 'string' || !STRATEGIES.has(strategy)) throw new ValidationError('strategy is not supported');
      await writer.createQueue({ name: queue, strategy }, scope);
      return { status: 201, body: { name: queue, strategy, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/queues/:queue', operationsAccess: access, handler: async req => {
      const { scope } = tenantScope(req.query, scopes); await writer.deleteQueue(name(req.params.queue, 'queue'), scope); return { status: 204 };
    } },
    { method: 'PUT', pattern: '/v1/admin/pbx/queues/:queue/extensions/:extension', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes); const body = object(req.body, ['context', 'penalty', 'paused']);
      const queue = name(req.params.queue, 'queue'); const ext = extension(req.params.extension); const ctx = context(body, scope);
      const penalty = body.penalty === undefined ? 0 : body.penalty;
      if (!Number.isInteger(penalty) || Number(penalty) < 0 || Number(penalty) > 100) throw new ValidationError('penalty must be an integer in [0, 100]');
      const paused = body.paused === undefined ? false : body.paused;
      if (typeof paused !== 'boolean') throw new ValidationError('paused must be a boolean');
      await writer.setQueueMember({ queue, extension: ext, endpointId: endpointId(ext, id), context: ctx, penalty: Number(penalty), paused }, scope);
      return { status: 200, body: { queue, extension: ext, penalty, paused, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/queues/:queue/extensions/:extension', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes); const ext = extension(req.params.extension);
      await writer.deleteQueueMember(name(req.params.queue, 'queue'), ext, endpointId(ext, id), scope); return { status: 204 };
    } },
    { method: 'GET', pattern: '/v1/admin/pbx/dids', operationsAccess: access, handler: async req => {
      const { id, scope } = tenantScope(req.query, scopes);
      const found = scope.didContext ? await writer.listDids(scope.didContext, scope.didNumbers ?? []) : [];
      const dids = (scope.didNumbers ?? []).map(did => {
        const rows = found.find(item => item.did === did)?.rows ?? [];
        const settings = recognizeDidRows(did, rows);
        return settings ? managedDid(did, settings) : { did, managed: false, availability: rows.length ? 'manual' : 'unconfigured', applyState: 'unknown' };
      });
      return { status: 200, body: { source: 'asterisk', iTenantId: id, provisioningEnabled: true, dids } };
    } },
    { method: 'PUT', pattern: '/v1/admin/pbx/dids/:did', operationsAccess: access, handler: async req => {
      const { scope } = tenantScope(req.query, scopes); const did = ownedDid(req.params.did, scope);
      const settings = parseDidSettings(req.body);
      await writer.setDid(scope.didContext!, did, settings.queue, didDialplanRows(did, settings), scope);
      return { status: 200, body: managedDid(did, settings) };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/dids/:did', operationsAccess: access, handler: async req => {
      const { scope } = tenantScope(req.query, scopes); const did = ownedDid(req.params.did, scope, true);
      await writer.deleteDid(scope.didContext!, did); return { status: 204 };
    } },
  ];
  // Do not let driver SQL/credentials reach either HTTP or Operations error instrumentation.
  return routes.map(route => ({ ...route, handler: async req => {
    try { return await route.handler(req); }
    catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError || error instanceof DependencyUnavailableError) throw error;
      throw new DependencyUnavailableError('PBX provisioning unavailable; verify the database, schema and writer grants');
    }
  } }));
}
