import mysql from 'mysql2/promise';
import { ownedQueueNames } from './queueOwnership.js';
import { CONTEXT_RE } from './managedDid.js';
import { DependencyUnavailableError, ValidationError } from '../errors.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { Route } from '../http/httpServer.js';

export interface PbxExtension {
  id: string;
  /** Dialable number from the managed Dial route in this context, else the legacy id fallback, else null. */
  extension: string | null;
  context: string; callerId: string | null; transport: string | null; aors: string | null;
  /** True when the endpoint has the managed Dial route in this context; imported endpoints are false. */
  managed: boolean;
}
export interface PbxQueue {
  id: string; name: string; strategy: string | null;
  members: { interface: string; memberName: string | null; penalty: number; paused: boolean }[];
}

/** Routing scope is {pbxInstanceId, context}: every read names one Asterisk context and derives ownership from Asterisk's own rows. */
export interface InventoryReader {
  contexts(): Promise<string[]>;
  extensions(context: string): Promise<PbxExtension[]>;
  queues(context: string): Promise<PbxQueue[]>;
}
export type InventoryQuery = (sql: string, values: string[]) => Promise<Record<string, unknown>[]>;
const MAX_ROWS = 1000;
const nullable = (value: unknown): string | null => value == null ? null : String(value);
function bounded(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length > MAX_ROWS) throw new DependencyUnavailableError('PBX inventory exceeds the supported POC size');
  return rows;
}
/** Fallback for endpoints without a managed route: the legacy `<digits>-t<N>` id or a pure-digit id. */
export const legacyExtension = (id: string): string | null => /^([0-9]{2,12})-t[1-9][0-9]*$/.exec(id)?.[1] ?? (/^[0-9]{2,12}$/.test(id) ? id : null);
/** The endpoint a managed extension route's first row dials; undefined for any other dialplan. */
export const dialedEndpoint = (appdata: string): string | undefined => /^PJSIP\/([A-Za-z0-9_.-]{1,40}),20$/.exec(appdata)?.[1];

/** Only SELECT on vendor tables. No auth reads, provisioning projection, DDL or writes. */
export class PbxInventoryReader implements InventoryReader {
  constructor(private readonly query: InventoryQuery) {}
  async contexts(): Promise<string[]> {
    // BINARY-distinct: two contexts differing only by case are two scopes on this PBX.
    const rows = bounded(await this.query("SELECT MIN(context) AS context FROM (SELECT context FROM ps_endpoints WHERE context IS NOT NULL AND context <> '' UNION ALL SELECT context FROM extensions WHERE context IS NOT NULL AND context <> '') AS c GROUP BY BINARY context LIMIT 1001", []));
    return rows.map(row => String(row.context)).sort();
  }
  async extensions(context: string): Promise<PbxExtension[]> {
    const rows = bounded(await this.query('SELECT id, context, callerid, transport, aors FROM ps_endpoints WHERE BINARY context = ? ORDER BY id LIMIT 1001', [context]));
    // The dialable number is the managed Dial route in this context, never the endpoint id alone.
    const routes = bounded(await this.query("SELECT exten, appdata FROM extensions WHERE BINARY context = ? AND priority = 1 AND app = 'Dial' AND LEFT(appdata, 6) = 'PJSIP/' ORDER BY exten LIMIT 1001", [context]));
    const dialed = new Map<string, string>();
    for (const row of routes) {
      const endpoint = dialedEndpoint(String(row.appdata ?? '')); const exten = String(row.exten);
      if (endpoint && /^[0-9]{2,12}$/.test(exten) && !dialed.has(endpoint)) dialed.set(endpoint, exten);
    }
    return rows.map((row) => {
      const id = String(row.id); const managed = dialed.get(id);
      return { id, extension: managed ?? legacyExtension(id), context: String(row.context), callerId: nullable(row.callerid), transport: nullable(row.transport), aors: nullable(row.aors), managed: managed !== undefined };
    });
  }
  async queues(context: string): Promise<PbxQueue[]> {
    const queueNames = await ownedQueueNames(this.query, context);
    if (!queueNames.length) return [];
    const placeholders = queueNames.map(() => '?').join(',');
    const queues = bounded(await this.query(`SELECT name, strategy FROM queues WHERE BINARY name IN (${placeholders}) ORDER BY name LIMIT 1001`, queueNames));
    // A marker whose queue row was deleted or not yet created is a valid omission, not an inventory dependency failure.
    const members = bounded(await this.query(`SELECT queue_name, interface, membername, penalty, paused FROM queue_members WHERE BINARY queue_name IN (${placeholders}) ORDER BY queue_name, interface LIMIT 1001`, queueNames));
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

/** Exactly one context query value. The retired tenant parameter is refused so no caller silently keeps tenant scope. */
export function contextQuery(query: URLSearchParams | undefined, name: 'context' | 'didContext' = 'context'): string {
  if (query?.has('iTenantId')) throw new ValidationError('iTenantId is retired; supply context');
  const values = query?.getAll(name) ?? [];
  if (values.length !== 1 || !CONTEXT_RE.test(values[0]!)) throw new ValidationError(`${name} must be exactly one Asterisk context name`);
  return values[0]!;
}
const unavailable = (message: string) => ({ status: 503, body: { error: 'pbx_inventory_unavailable', message } });

export function pbxInventoryRoutes(reader: InventoryReader, enabled: boolean, pbxInstanceId: string, provisioningEnabled = false): Route[] {
  const contexts: Route = { method: 'GET', pattern: '/v1/admin/pbx/contexts', operationsAccess: { scope: 'platform' }, handler: async (req) => {
    if (req.query?.has('iTenantId')) throw new ValidationError('iTenantId is retired; supply context');
    if (!enabled) return unavailable('Configure the PBX inventory connection');
    try { return { status: 200, body: { source: 'asterisk', pbxInstanceId, contexts: await reader.contexts() } }; }
    catch { return unavailable('Check the PBX read grants and realtime schema in OfficePulse'); }
  } };
  return [contexts, ...(['extensions', 'queues'] as const).map((kind): Route => ({
    method: 'GET', pattern: `/v1/admin/pbx/${kind}`,
    operationsAccess: { scope: 'context-query', query: 'context' },
    handler: async (req) => {
      const context = contextQuery(req.query);
      if (!enabled) return unavailable('Configure the PBX inventory connection');
      try {
        const items = (await reader[kind](context)).map(record => ({ ...record, applyState: 'unknown' }));
        return { status: 200, body: { source: 'asterisk', pbxInstanceId, context, provisioningEnabled,
          ...(kind === 'extensions' ? { contexts: [context] } : {}), [kind]: items } };
      } catch {
        return unavailable('Check the PBX read grants and realtime schema in OfficePulse');
      }
    },
  }))];
}
