import mysql from 'mysql2/promise';
import type { PbxTenantScopes, InventoryQuery } from '../pbx/inventory.js';
import { PbxInventoryReader } from '../pbx/inventory.js';
import { recognizeDidRows } from '../pbx/managedDid.js';
import type { NocoReadApi } from '../nocodb/api.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import { profileSnapshot, type ProfileSnapshot } from './contract.js';

export interface NativeRequest { didE164: string; ingressContext: string; fallbackQueue: string }
export interface NativeResolution { tenantId: string; queue: string; profileId: string; profileRevision: number; profile: ProfileSnapshot }
export interface NativeAuthority {
  resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined>;
  authorized(tenantId: string, did: string, queue: string, profileId: string): Promise<boolean>;
}
export class NativeAdmissionAuthority implements NativeAuthority {
  private readonly inventory: PbxInventoryReader;
  constructor(private readonly opts: { scopes: PbxTenantScopes; query: InventoryQuery; noco: NocoReadApi;
    tenantEnabled: (tenantId: string) => Promise<boolean>; profileIds: ReadonlyMap<string, string> }) {
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
    if (!await this.opts.tenantEnabled(tenantId) || !await this.owned(tenantId, did, queue)) return false;
    const rows = await this.opts.noco.listRecords('aida_tbl_AssistantProfile', [{ field: 'iTenantId', op: 'eq', value: Number(tenantId) }, { field: 'id', op: 'eq', value: profileId }], 2);
    return rows.length === 1 && String(rows[0]!.iTenantId) === tenantId && [true, 1, '1'].includes(rows[0]!.enabled as boolean);
  }
  async resolve(request: NativeRequest, callId: string): Promise<NativeResolution | undefined> {
    if (!/^\+[1-9][0-9]{6,14}$/.test(request.didE164) || !/^[a-zA-Z0-9_.-]{1,40}$/.test(request.ingressContext) || !/^[a-zA-Z0-9_.-]{1,60}$/.test(request.fallbackQueue)) return;
    const matches: string[] = [];
    for (const [id, scope] of this.opts.scopes) if (scope.didContext === request.ingressContext && await this.owned(id, request.didE164, request.fallbackQueue)) matches.push(id);
    if (matches.length !== 1) return;
    const tenantId = matches[0]!;
    if (!await this.opts.tenantEnabled(tenantId)) return;
    const selected = this.opts.profileIds.get(tenantId);
    const rows = await this.opts.noco.listRecords('aida_tbl_AssistantProfile', [
      { field: 'iTenantId', op: 'eq', value: Number(tenantId) }, ...(selected ? [{ field: 'id', op: 'eq' as const, value: selected }] : []),
      { field: 'enabled', op: 'eq', value: true },
    ], 2);
    if (rows.length !== 1) return; // multiple enabled profiles require an explicit selection
    const r = rows[0]!;
    if (String(r.iTenantId) !== tenantId || ![true, 1, '1'].includes(r.enabled as boolean) || !/^[A-Za-z0-9_.-]{1,60}$/.test(String(r.id)) || !Number.isSafeInteger(Number(r.revision))) return;
    const profile = profileSnapshot({ schemaVersion: 1, callSessionId: callId, tenantId, didE164: request.didE164,
      businessName: r.business_name, prompt: r.prompt, locale: 'en-US',
      ...Object.fromEntries(Object.entries({ tone: r.tone, objective: r.objective, openingStatement: r.opening_statement,
        transferStatement: r.transfer_statement, failedTransferStatement: r.failed_transfer_statement }).filter(([, v]) => v !== undefined && v !== null)),
    });
    return { tenantId, queue: request.fallbackQueue, profileId: String(r.id), profileRevision: Number(r.revision), profile };
  }
}
export function mysqlNativeAuthority(config: RuntimeMysqlConfig, opts: Omit<ConstructorParameters<typeof NativeAdmissionAuthority>[0], 'query'>) {
  const pool = mysql.createPool({ ...config, connectionLimit: 2, connectTimeout: 4000 });
  return { authority: new NativeAdmissionAuthority({ ...opts, query: async (sql, values) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>({ sql, timeout: 4000 }, values); return rows;
  } }), close: () => pool.end() };
}
export function identityTenantEnabled(origin: string, fetchImpl = fetch) {
  return async (id: string): Promise<boolean> => {
    const response = await fetchImpl(new URL(`/api/runtime/tenants/${id}`, origin), { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error('Identity runtime unavailable');
    const body = await response.json() as { iTenantId?: unknown; bEnabled?: unknown };
    return String(body.iTenantId) === id && body.bEnabled === true;
  };
}
