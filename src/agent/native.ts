import mysql from 'mysql2/promise';
import type { InventoryQuery } from '../pbx/inventory.js';
import { queueOwner } from '../pbx/queueOwnership.js';
import { recognizeDidRows } from '../pbx/managedDid.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { Logger } from '../logging/logger.js';
import { cachedProfileSnapshot, type CachedProfile, type ProfileLookup } from './profileCache.js';
import type { ProfileSnapshot } from './contract.js';

export interface NativeRequest { didE164: string; ingressContext: string; fallbackQueue: string }
/** Routing scope {pbxInstanceId, context} plus the ingress context the DID arrived in, pinned per call so ownership can be re-derived. */
export interface CallScope { pbxInstanceId: string; context: string; ingressContext: string }
export interface NativeResolution { pbxInstanceId: string; context: string; tenantId: string; queue: string; profileId: string; profileRevision: number; profile: ProfileSnapshot }
export interface NativeAuthority {
  resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined>;
  authorized(scope: CallScope, did: string, queue: string, profileId: string): Promise<boolean>;
}
/**
 * Route ownership comes from Asterisk's own Realtime rows on this PBX host;
 * business configuration comes from the startup-loaded cache. Neither path
 * performs an Identity or NocoDB request while a call is in progress (#19).
 */
export class NativeAdmissionAuthority implements NativeAuthority {
  constructor(private readonly opts: { pbxInstanceId: string; query: InventoryQuery; profiles: ProfileLookup }) {}
  /** The context owning the queue this DID's managed route names; undefined when the route is absent, names another queue, or the marker is missing/ambiguous. */
  private async owner(ingressContext: string, did: string, queue: string): Promise<string | undefined> {
    const rows = await this.opts.query('SELECT priority,app,appdata FROM extensions WHERE BINARY context=? AND BINARY exten=? ORDER BY priority LIMIT 4', [ingressContext, did]);
    const settings = recognizeDidRows(did, rows.map(r => ({ priority: Number(r.priority), app: String(r.app), appdata: String(r.appdata) })));
    if (settings?.queue !== queue) return;
    const context = await queueOwner(this.opts.query, queue);
    if (!context) return;
    return (await this.opts.query('SELECT name FROM queues WHERE BINARY name=? LIMIT 1', [queue])).length ? context : undefined;
  }
  /** A DID-specific assignment wins over the context default; neither means the caller stays on the PBX queue. */
  private entry(context: string, did: string): CachedProfile | undefined {
    const entry = this.opts.profiles.get(context, did) ?? this.opts.profiles.get(context, '');
    return entry?.pbxInstanceId === this.opts.pbxInstanceId ? entry : undefined;
  }
  async authorized(scope: CallScope, did: string, queue: string, profileId: string): Promise<boolean> {
    if (scope.pbxInstanceId !== this.opts.pbxInstanceId) return false;
    const entry = this.entry(scope.context, did);
    if (!entry || entry.profileId !== profileId) return false;
    return await this.owner(scope.ingressContext, did, queue) === scope.context;
  }
  async resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined> {
    if (!/^\+[1-9][0-9]{6,14}$/.test(request.didE164) || !/^[a-zA-Z0-9_.-]{1,40}$/.test(request.ingressContext) || !/^[a-zA-Z0-9_.-]{1,60}$/.test(request.fallbackQueue)) return;
    const context = await this.owner(request.ingressContext, request.didE164, request.fallbackQueue);
    if (!context) return;
    const entry = this.entry(context, request.didE164);
    if (!entry) return; // no assignment, or it was revoked at the last refresh
    let profile: ProfileSnapshot;
    try { profile = cachedProfileSnapshot(entry, { callSessionId: callId, didE164: request.didE164 }); } catch { return; }
    return { pbxInstanceId: this.opts.pbxInstanceId, context, tenantId: entry.tenantId, queue: request.fallbackQueue, profileId: entry.profileId, profileRevision: entry.profileRevision, profile };
  }
}
export function mysqlNativeAuthority(config: RuntimeMysqlConfig, opts: Omit<ConstructorParameters<typeof NativeAdmissionAuthority>[0], 'query'>) {
  const pool = mysql.createPool({ ...config, connectionLimit: 2, connectTimeout: 4000 });
  return { authority: new NativeAdmissionAuthority({ ...opts, query: async (sql, values) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>({ sql, timeout: 4000 }, values); return rows;
  } }), close: () => pool.end() };
}
export interface IdentityTenantOptions {
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn'>;
}
/** Startup/background only. Never called while a call is being admitted or monitored. */
export function identityTenantEnabled(origin: string, options: IdentityTenantOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (id: string): Promise<boolean> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(`/api/runtime/tenants/${id}`, origin), {
        headers: options.clientSecret ? { 'X-Id-Client-Secret': options.clientSecret } : {},
        redirect: 'error', signal: AbortSignal.timeout(3000),
      });
    } catch {
      options.logger?.warn('Identity tenant validation request failed', { tenantId: id, status: 'network_error' });
      throw new Error('Identity runtime unavailable');
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      options.logger?.warn('Identity tenant validation request failed', { tenantId: id, status: response.status });
      throw new Error('Identity runtime unavailable');
    }
    let body: { iTenantId?: unknown; bEnabled?: unknown };
    try { body = await response.json() as typeof body; }
    catch {
      options.logger?.warn('Identity tenant validation response was invalid', { tenantId: id, status: response.status });
      throw new Error('Identity runtime unavailable');
    }
    return String(body.iTenantId) === id && body.bEnabled === true;
  };
}
