import mysql from 'mysql2/promise';
import { ConfigError, DependencyUnavailableError, ValidationError } from '../errors.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { Route } from '../http/httpServer.js';

export interface PbxTenantScope { contexts: string[]; queueNames: string[] }
export type PbxTenantScopes = ReadonlyMap<string, PbxTenantScope>;
export interface PbxExtension {
  id: string; context: string; callerId: string | null; transport: string | null; aors: string | null;
}
export interface PbxQueue {
  id: string; name: string; strategy: string | null;
  members: { interface: string; memberName: string | null; penalty: number; paused: boolean }[];
}

/** Operator-owned authorization references, never a second copy of PBX records. */
export function parsePbxTenantScopes(raw: string | undefined): PbxTenantScopes {
  if (!raw?.trim()) return new Map();
  const invalid = () => new ConfigError(['PBX_INVENTORY_TENANTS_JSON must map canonical tenant IDs to distinct contexts and queueNames arrays']);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const scopes = new Map<string, PbxTenantScope>();
  const owners = { contexts: new Set<string>(), queueNames: new Set<string>() };
  for (const [id, scope] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || !scope || typeof scope !== 'object' || Array.isArray(scope)) throw invalid();
    const typed = scope as Record<string, unknown>;
    if (Object.keys(typed).some((key) => key !== 'contexts' && key !== 'queueNames')) throw invalid();
    for (const field of ['contexts', 'queueNames'] as const) {
      const values = typed[field];
      if (!Array.isArray(values) || values.length > 100) throw invalid();
      for (const value of values) {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value)) throw invalid();
        const normalized = value.toLowerCase();
        if (owners[field].has(normalized)) throw invalid();
        owners[field].add(normalized);
      }
    }
    scopes.set(id, { contexts: [...typed.contexts as string[]], queueNames: [...typed.queueNames as string[]] });
  }
  return scopes;
}

export interface InventoryReader {
  extensions(scope: PbxTenantScope): Promise<PbxExtension[]>;
  queues(scope: PbxTenantScope): Promise<PbxQueue[]>;
}
export type InventoryQuery = (sql: string, values: string[]) => Promise<Record<string, unknown>[]>;
const MAX_ROWS = 1000;
const nullable = (value: unknown): string | null => value == null ? null : String(value);
function bounded(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length > MAX_ROWS) throw new DependencyUnavailableError('PBX inventory exceeds the supported POC size');
  return rows;
}

/** Only SELECT on vendor tables. No auth reads, provisioning projection, DDL or writes. */
export class PbxInventoryReader implements InventoryReader {
  constructor(private readonly query: InventoryQuery) {}
  async extensions(scope: PbxTenantScope): Promise<PbxExtension[]> {
    if (!scope.contexts.length) return [];
    const rows = bounded(await this.query(
      `SELECT id, context, callerid, transport, aors FROM ps_endpoints WHERE BINARY context IN (${scope.contexts.map(() => '?').join(',')}) ORDER BY id LIMIT 1001`, scope.contexts));
    return rows.map((row) => ({ id: String(row.id), context: String(row.context), callerId: nullable(row.callerid), transport: nullable(row.transport), aors: nullable(row.aors) }));
  }
  async queues(scope: PbxTenantScope): Promise<PbxQueue[]> {
    if (!scope.queueNames.length) return [];
    const placeholders = scope.queueNames.map(() => '?').join(',');
    const queues = bounded(await this.query(`SELECT name, strategy FROM queues WHERE BINARY name IN (${placeholders}) ORDER BY name LIMIT 1001`, scope.queueNames));
    // A misspelled mapping or absent realtime queue is not a successful empty inventory.
    if (queues.length !== scope.queueNames.length) throw new DependencyUnavailableError('Mapped PBX queues are unavailable');
    const members = bounded(await this.query(`SELECT queue_name, interface, membername, penalty, paused FROM queue_members WHERE BINARY queue_name IN (${placeholders}) ORDER BY queue_name, interface LIMIT 1001`, scope.queueNames));
    return queues.map((row) => ({ id: String(row.name), name: String(row.name), strategy: nullable(row.strategy),
      members: members.filter((member) => member.queue_name === row.name).map((member) => ({
        interface: String(member.interface), memberName: nullable(member.membername),
        penalty: Number(member.penalty ?? 0), paused: member.paused === 1 || member.paused === '1' || member.paused === true,
      })),
    }));
  }
}

export function mysqlPbxInventory(config: RuntimeMysqlConfig): { reader: InventoryReader; close: () => Promise<void> } {
  const pool = mysql.createPool({ ...config, connectionLimit: 2, connectTimeout: 4000 });
  return { reader: new PbxInventoryReader(async (sql, values) => {
    const [rows] = await pool.execute({ sql, timeout: 4000 }, values);
    return rows as Record<string, unknown>[];
  }), close: () => pool.end() };
}

export function pbxInventoryRoutes(reader: InventoryReader, scopes: PbxTenantScopes, enabled: boolean): Route[] {
  return (['extensions', 'queues'] as const).map((kind) => ({
    method: 'GET', pattern: `/v1/admin/pbx/${kind}`,
    operationsAccess: { scope: 'tenant-query' as const, query: 'iTenantId' },
    handler: async (req) => {
      const ids = req.query?.getAll('iTenantId') ?? [];
      const id = ids[0] ?? '';
      if (ids.length !== 1 || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new ValidationError('iTenantId must be a positive canonical Identity tenant ID');
      const scope = scopes.get(id);
      if (!enabled || !scope) return { status: 503, body: { error: 'pbx_inventory_unavailable', message: 'Configure the PBX connection and an operator-approved tenant inventory scope' } };
      try {
        return { status: 200, body: { source: 'asterisk', iTenantId: Number(id), [kind]: await reader[kind](scope) } };
      } catch {
        return { status: 503, body: { error: 'pbx_inventory_unavailable', message: 'Check the PBX read grants, realtime schema and tenant inventory scope in OfficePulse' } };
      }
    },
  }));
}
