import mysql from 'mysql2/promise';
import type { PbxTenantScopes, InventoryQuery } from '../pbx/inventory.js';
import { PbxInventoryReader } from '../pbx/inventory.js';
import { recognizeDidRows } from '../pbx/managedDid.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { Logger } from '../logging/logger.js';
import { cachedProfileSnapshot, type ProfileLookup } from './profileCache.js';
import type { ProfileSnapshot } from './contract.js';

export interface NativeRequest { didE164: string; ingressContext: string; fallbackQueue: string }
export interface NativeResolution { tenantId: string; queue: string; profileId: string; profileRevision: number; profile: ProfileSnapshot }
export interface NativeAuthority {
  resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined>;
  authorized(tenantId: string, did: string, queue: string, profileId: string): Promise<boolean>;
}
/**
 * Route ownership comes from Asterisk's own Realtime rows on this PBX host;
 * business configuration comes from the startup-loaded cache. Neither path
 * performs an Identity or NocoDB request while a call is in progress (#19).
 */
export class NativeAdmissionAuthority implements NativeAuthority {
  private readonly inventory: PbxInventoryReader;
  constructor(private readonly opts: { scopes: PbxTenantScopes; query: InventoryQuery; profiles: ProfileLookup }) {
    this.inventory = new PbxInventoryReader(opts.query, true);
  }
  private async owned(tenantId: string, did: string, queue: string): Promise<boolean> {
    const scope = this.opts.scopes.get(tenantId);
    if (!scope?.didContext) return false;
    const rows = await this.opts.query('SELECT priority,app,appdata FROM extensions WHERE BINARY context=? AND BINARY exten=? ORDER BY priority LIMIT 4', [scope.didContext, did]);
    const settings = recognizeDidRows(did, rows.map(r => ({ priority: Number(r.priority), app: String(r.app), appdata: String(r.appdata) })));
    return settings?.queue === queue && (await this.inventory.queues(scope)).some(q => q.id === queue);
  }
  async authorized(tenantId: string, did: string, queue: string, profileId: string): Promise<boolean> {
    const entry = this.opts.profiles.get(tenantId);
    if (!entry || entry.profileId !== profileId) return false;
    return this.owned(tenantId, did, queue);
  }
  async resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined> {
    if (!/^\+[1-9][0-9]{6,14}$/.test(request.didE164) || !/^[a-zA-Z0-9_.-]{1,40}$/.test(request.ingressContext) || !/^[a-zA-Z0-9_.-]{1,60}$/.test(request.fallbackQueue)) return;
    const matches: string[] = [];
    for (const [id, scope] of this.opts.scopes) if (scope.didContext === request.ingressContext && await this.owned(id, request.didE164, request.fallbackQueue)) matches.push(id);
    if (matches.length !== 1) return;
    const tenantId = matches[0]!;
    const entry = this.opts.profiles.get(tenantId);
    if (!entry) return; // configuration was never loaded, or was revoked at the last refresh
    let profile: ProfileSnapshot;
    try { profile = cachedProfileSnapshot(entry, { callSessionId: callId, tenantId, didE164: request.didE164 }); } catch { return; }
    return { tenantId, queue: request.fallbackQueue, profileId: entry.profileId, profileRevision: entry.profileRevision, profile };
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
