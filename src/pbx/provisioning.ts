import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../errors.js';
import type { Route } from '../http/httpServer.js';
import { contextQuery } from './inventory.js';
import type { PbxProvisioner } from './provisioningStore.js';
import { contextName, didDialplanRows, e164, managedDid, name, object, parseDidSettings, recognizeDidRows } from './managedDid.js';
export { MysqlPbxProvisioner, type PbxProvisioner } from './provisioningStore.js';
export { didDialplanRows, type DidSettings, type DidSchedule, type DialplanRow } from './managedDid.js';

const STRATEGIES = new Set(['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear', 'wrandom']);
function extension(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{2,12}$/.test(value)) throw new ValidationError('extension must be 2-12 digits');
  return value;
}
/** New endpoint/auth/AOR ids are `<extension>-<context>`; legacy `<extension>-t<N>` bundles are reached through their own Dial row. */
function endpointId(ext: string, context: string): string {
  const id = `${ext}-${context}`;
  if (id.length > 40) throw new ValidationError('extension and context exceed the installed 40-character endpoint ID');
  return id;
}
/** A body context may only repeat the query scope; it never widens it. */
function sameContext(body: Record<string, unknown>, context: string): void {
  if (body.context !== undefined && contextName(body.context) !== context) throw new ValidationError('context in the body must equal the context query');
}
function authorizedDids(query: URLSearchParams | undefined): string[] {
  const values = query?.getAll('authorizedDid') ?? [];
  if (values.length > 100) throw new ValidationError('authorizedDid may contain at most 100 numbers');
  const unique = new Set<string>();
  for (const value of values) {
    const did = e164(value, 'authorizedDid');
    if (unique.has(did)) throw new ValidationError('authorizedDid values must be unique');
    unique.add(did);
  }
  return [...unique];
}
function ownedDid(value: unknown, authorized: readonly string[], destructive = false): string {
  const did = e164(value);
  if (!authorized.includes(did)) {
    if (destructive) throw new NotFoundError('DID was not found for this context');
    throw new ValidationError('DID is not assigned to this tenant in Identity');
  }
  return did;
}
/** Both scopes of a DID request: the extension context owning the queue and the ingress context holding the route. */
function didScopes(query: URLSearchParams | undefined): { context: string; didContext: string } {
  const context = contextQuery(query); const didContext = contextQuery(query, 'didContext');
  if (didContext === context) throw new ValidationError('didContext must be the inbound ingress context, not the extension context');
  return { context, didContext };
}
const unmanaged = (did: string, availability: 'manual' | 'unconfigured') => ({ did, managed: false as const, availability, applyState: 'unknown' as const });

/** No mutations exist unless both the explicit flag and dedicated writer configuration are supplied. */
export function pbxProvisioningRoutes(writer: PbxProvisioner | undefined, enabled: boolean, pbxInstanceId: string): Route[] {
  if (!enabled || !writer) return [];
  const access = { scope: 'context-query' as const, query: 'context' as const };
  const routes: Route[] = [
    { method: 'POST', pattern: '/v1/admin/pbx/extensions', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query);
      const body = object(req.body, ['extension', 'context', 'displayName', 'callerIdNumber']);
      const ext = extension(body.extension); sameContext(body, context);
      const displayName = body.displayName;
      if (displayName !== undefined && (typeof displayName !== 'string' || !/^[^"<>\\\x00-\x1f\x7f]{1,33}$/.test(displayName))) throw new ValidationError('displayName contains unsupported characters');
      const callerIdNumber = body.callerIdNumber === undefined ? undefined : e164(body.callerIdNumber, 'callerIdNumber');
      if (typeof displayName === 'string' && displayName.length + (callerIdNumber ?? ext).length + 5 > 40) throw new ValidationError('displayName and callerIdNumber exceed the native 40-character caller ID limit');
      const created = await writer.createExtension({ extension: ext, endpointId: endpointId(ext, context), context, displayName, callerIdNumber });
      return { status: 201, body: { ...created, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/extensions/:extension', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query);
      await writer.deleteExtension(extension(req.params.extension), context); return { status: 204 };
    } },
    { method: 'POST', pattern: '/v1/admin/pbx/queues', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query); const body = object(req.body, ['name', 'strategy']);
      const slug = name(body.name, 'name'); const strategy = body.strategy === undefined ? 'ringall' : body.strategy;
      if (typeof strategy !== 'string' || !STRATEGIES.has(strategy)) throw new ValidationError('strategy is not supported');
      const created = await writer.createQueue({ name: slug, strategy }, context);
      return { status: 201, body: { name: created.name, strategy, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/queues/:queue', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query); await writer.deleteQueue(name(req.params.queue, 'queue'), context); return { status: 204 };
    } },
    { method: 'PUT', pattern: '/v1/admin/pbx/queues/:queue/extensions/:extension', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query); const body = object(req.body, ['context', 'penalty', 'paused']);
      const queue = name(req.params.queue, 'queue'); const ext = extension(req.params.extension); sameContext(body, context);
      const penalty = body.penalty === undefined ? 0 : body.penalty;
      if (!Number.isInteger(penalty) || Number(penalty) < 0 || Number(penalty) > 100) throw new ValidationError('penalty must be an integer in [0, 100]');
      const paused = body.paused === undefined ? false : body.paused;
      if (typeof paused !== 'boolean') throw new ValidationError('paused must be a boolean');
      await writer.setQueueMember({ queue, extension: ext, context, penalty: Number(penalty), paused });
      return { status: 200, body: { queue, extension: ext, penalty, paused, applyState: 'committed' } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/queues/:queue/extensions/:extension', operationsAccess: access, handler: async req => {
      const context = contextQuery(req.query);
      await writer.deleteQueueMember(name(req.params.queue, 'queue'), extension(req.params.extension), context); return { status: 204 };
    } },
    { method: 'GET', pattern: '/v1/admin/pbx/dids', handler: async req => {
      const { context, didContext } = didScopes(req.query);
      const authorized = authorizedDids(req.query);
      const [found, owned] = authorized.length ? await Promise.all([writer.listDids(didContext, authorized), writer.ownedQueues(context)]) : [[], []];
      const dids = authorized.map(did => {
        const rows = found.find(item => item.did === did)?.rows ?? [];
        const settings = recognizeDidRows(did, rows);
        // A recognized route whose queue another context owns is reported as manual, never adopted.
        return settings && owned.includes(settings.queue) ? managedDid(did, settings) : unmanaged(did, rows.length ? 'manual' : 'unconfigured');
      });
      return { status: 200, body: { source: 'asterisk', pbxInstanceId, context, didContext, provisioningEnabled: true, dids } };
    } },
    { method: 'PUT', pattern: '/v1/admin/pbx/dids/:did', handler: async req => {
      const { context, didContext } = didScopes(req.query); const did = ownedDid(req.params.did, authorizedDids(req.query));
      const settings = parseDidSettings(req.body);
      await writer.setDid(didContext, did, settings.queue, didDialplanRows(did, settings), context);
      return { status: 200, body: managedDid(did, settings) };
    } },
    { method: 'DELETE', pattern: '/v1/admin/pbx/dids/:did', handler: async req => {
      const { context, didContext } = didScopes(req.query); const did = ownedDid(req.params.did, authorizedDids(req.query), true);
      await writer.deleteDid(didContext, did, context); return { status: 204 };
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
