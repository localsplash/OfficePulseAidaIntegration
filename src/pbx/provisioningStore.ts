import { randomBytes } from 'node:crypto';
import { queueMarkerData as markerData, queueMarkerExten as markerExten } from './queueOwnership.js';
import mysql from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';
import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../errors.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { PbxTenantScope } from './inventory.js';
import { recognizeDidRows, type DialplanRow } from './managedDid.js';

export interface ExtensionCreate {
  extension: string; endpointId: string; context: string; displayName?: string; callerIdNumber?: string;
}
export interface QueueCreate { name: string; strategy: string }
export interface QueueMember {
  queue: string; extension: string; endpointId: string; context: string; penalty: number; paused: boolean;
}
export interface DidInventory { did: string; rows: DialplanRow[] }
export interface PbxProvisioner {
  createExtension(input: ExtensionCreate): Promise<{ extension: string; sipUsername: string; sipSecret: string }>;
  deleteExtension(extension: string, endpointId: string, contexts: readonly string[]): Promise<void>;
  createQueue(input: QueueCreate, scope: PbxTenantScope): Promise<void>;
  deleteQueue(name: string, scope: PbxTenantScope): Promise<void>;
  setQueueMember(input: QueueMember, scope: PbxTenantScope): Promise<void>;
  deleteQueueMember(queue: string, extension: string, endpointId: string, scope: PbxTenantScope): Promise<void>;
  listDids(context: string, dids: readonly string[]): Promise<DidInventory[]>;
  setDid(context: string, did: string, queue: string, rows: DialplanRow[], scope: PbxTenantScope): Promise<void>;
  deleteDid(context: string, did: string): Promise<void>;
}

type SqlConnection = Pick<mysql.PoolConnection, 'execute'>;
type WriterPool = Pick<mysql.Pool, 'getConnection' | 'execute' | 'end'>;
type DbRow = Record<string, unknown>;
const MAX_ROWS = 1000;
const placeholders = (values: readonly (string | number)[]) => values.map(() => '?').join(',');
const extensionRows = (endpointId: string): DialplanRow[] => [
  { priority: 1, app: 'Dial', appdata: `PJSIP/${endpointId},20` },
  { priority: 2, app: 'Hangup', appdata: '' },
];

/** Never attach the upstream error as a cause: duplicate SQL errors can contain SIP passwords. */
function safeError(error: unknown): Error {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof ValidationError || error instanceof DependencyUnavailableError) return error;
  const errno = (error as { errno?: number } | null)?.errno;
  if (errno === 1062) return new ConflictError('The PBX object already exists');
  if (errno === 1213 || errno === 1205) return new ConflictError('The PBX object changed concurrently; retry the operation');
  return new DependencyUnavailableError('PBX provisioning database operation failed');
}

async function read(conn: SqlConnection, sql: string, values: readonly (string | number)[]): Promise<DbRow[]> {
  const [rows] = await conn.execute({ sql, timeout: 4000 }, [...values]);
  return rows as DbRow[];
}
async function execute(conn: SqlConnection, sql: string, values: readonly (string | number)[]): Promise<ResultSetHeader> {
  const [result] = await conn.execute({ sql, timeout: 4000 }, [...values]);
  return result as ResultSetHeader;
}
function dialplan(rows: DbRow[]): DialplanRow[] {
  return rows.map(row => ({ priority: Number(row.priority), app: String(row.app), appdata: String(row.appdata ?? '') }));
}
async function lockDialplan(conn: SqlConnection, context: string, exten: string): Promise<DialplanRow[]> {
  return dialplan(await read(conn,
    'SELECT priority, app, appdata FROM extensions WHERE BINARY context = ? AND BINARY exten = ? ORDER BY priority LIMIT 1001 FOR UPDATE', [context, exten]));
}
async function insertDialplan(conn: SqlConnection, context: string, exten: string, rows: DialplanRow[]): Promise<void> {
  for (const row of rows) await execute(conn,
    'INSERT INTO extensions (context, exten, priority, app, appdata) VALUES (?, ?, ?, ?, ?)',
    [context, exten, row.priority, row.app, row.appdata]);
}
async function removeDialplan(conn: SqlConnection, context: string, exten: string): Promise<void> {
  await execute(conn, 'DELETE FROM extensions WHERE BINARY context = ? AND BINARY exten = ?', [context, exten]);
}

/** Narrow transactional writer over Asterisk Realtime. No runtime DDL or copied desired state. */
export class MysqlPbxProvisioner implements PbxProvisioner {
  private readonly pool: WriterPool;
  constructor(config: RuntimeMysqlConfig, pool?: WriterPool) {
    this.pool = pool ?? mysql.createPool({ ...config, connectionLimit: 3, connectTimeout: 4000 });
  }
  close(): Promise<void> { return this.pool.end(); }
  async ping(): Promise<boolean> { try { await this.pool.execute({ sql: 'SELECT 1', timeout: 4000 }); return true; } catch { return false; } }

  private async transaction<T>(operation: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    let conn: mysql.PoolConnection | undefined;
    try {
      conn = await this.pool.getConnection();
      await conn.beginTransaction();
      const result = await operation(conn);
      await conn.commit();
      return result;
    } catch (error) {
      if (conn) await conn.rollback().catch(() => {});
      throw safeError(error);
    } finally { conn?.release(); }
  }

  private async ownedQueue(conn: SqlConnection, name: string, scope: PbxTenantScope): Promise<void> {
    const missing = () => new NotFoundError('Queue was not found in this tenant');
    // The queue row serializes membership changes, DID writes and queue deletion.
    const queues = await read(conn, 'SELECT name FROM queues WHERE BINARY name = ? LIMIT 1 FOR UPDATE', [name]);
    if (!queues.length) throw missing();
    if (scope.queueNames.includes(name)) return;
    if (!scope.contexts.length) throw missing();
    const markers = await read(conn,
      `SELECT priority, app, appdata FROM extensions WHERE BINARY context IN (${placeholders(scope.contexts)}) AND BINARY exten = ? LIMIT 2 FOR UPDATE`,
      [...scope.contexts, markerExten(name)]);
    if (markers.length !== 1 || Number(markers[0]!.priority) !== 1 || markers[0]!.app !== 'NoOp' || markers[0]!.appdata !== markerData(name)) throw missing();
  }

  private async ownedEndpoint(conn: SqlConnection, extension: string, endpointId: string, contexts: readonly string[]): Promise<DbRow> {
    if (!contexts.length) throw new NotFoundError('Extension was not found in this tenant');
    const rows = await read(conn,
      `SELECT id, context, auth, aors FROM ps_endpoints WHERE BINARY id = ? AND BINARY context IN (${placeholders(contexts)}) LIMIT 1 FOR UPDATE`,
      [endpointId, ...contexts]);
    if (!rows.length) throw new NotFoundError(`Extension ${extension} was not found in this tenant`);
    return rows[0]!;
  }

  createExtension(input: ExtensionCreate): Promise<{ extension: string; sipUsername: string; sipSecret: string }> {
    const callerId = input.displayName ? `"${input.displayName}" <${input.callerIdNumber ?? input.extension}>` : (input.callerIdNumber ?? input.extension);
    if (input.context.length > 40 || input.extension.length > 40 || callerId.length > 40) {
      return Promise.reject(new ValidationError('Extension values exceed the installed Asterisk 40-character columns'));
    }
    return this.transaction(async conn => {
      if ((await lockDialplan(conn, input.context, input.extension)).length) throw new ConflictError('The extension already has a dialplan route');
      const secret = randomBytes(32).toString('base64url');
      await execute(conn, 'INSERT INTO ps_aors (id, max_contacts, remove_existing) VALUES (?, ?, ?)', [input.endpointId, 1, 'yes']);
      await execute(conn, 'INSERT INTO ps_auths (id, auth_type, username, password) VALUES (?, ?, ?, ?)', [input.endpointId, 'userpass', input.endpointId, secret]);
      await execute(conn, 'INSERT INTO ps_endpoints (id, transport, aors, auth, context, disallow, allow, callerid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [input.endpointId, 'transport-udp', input.endpointId, input.endpointId, input.context, 'all', 'ulaw,alaw', callerId]);
      await insertDialplan(conn, input.context, input.extension, extensionRows(input.endpointId));
      return { extension: input.extension, sipUsername: input.endpointId, sipSecret: secret };
    });
  }

  deleteExtension(extension: string, endpointId: string, contexts: readonly string[]): Promise<void> {
    return this.transaction(async conn => {
      const endpoint = await this.ownedEndpoint(conn, extension, endpointId, contexts);
      const context = String(endpoint.context);
      if (endpoint.auth !== endpointId || endpoint.aors !== endpointId) throw new ConflictError('Extension uses a shared or unmanaged auth/AOR bundle');
      const rows = await lockDialplan(conn, context, extension);
      if (JSON.stringify(rows) !== JSON.stringify(extensionRows(endpointId))) throw new ConflictError('Extension has an unmanaged or missing dialplan route');
      // Auth and AOR references are lists in native PJSIP, so exact id equality alone is insufficient.
      const references = await read(conn,
        `SELECT id FROM ps_endpoints WHERE BINARY id <> ? AND (FIND_IN_SET(?, BINARY REPLACE(COALESCE(auth, ''), ' ', '')) > 0 OR FIND_IN_SET(?, BINARY REPLACE(COALESCE(outbound_auth, ''), ' ', '')) > 0 OR FIND_IN_SET(?, BINARY REPLACE(COALESCE(aors, ''), ' ', '')) > 0) LIMIT 1 FOR UPDATE`,
        [endpointId, endpointId, endpointId, endpointId]);
      if (references.length) throw new ConflictError('Extension auth/AOR is still referenced by another endpoint');
      const dialReferences = await read(conn,
        'SELECT exten FROM extensions WHERE NOT (BINARY context = ? AND BINARY exten = ?) AND (LOCATE(?, BINARY appdata) > 0 OR LOCATE(?, BINARY appdata) > 0) LIMIT 1 FOR UPDATE',
        [context, extension, `PJSIP/${endpointId}`, `Local/${extension}@${context}`]);
      if (dialReferences.length) throw new ConflictError('Extension is still referenced by another dialplan route');
      const iface = `PJSIP/${endpointId}`;
      const local = `Local/${extension}@${context}`;
      const stateReferences = await read(conn,
        `SELECT queue_name FROM queue_members WHERE LOCATE(?, BINARY state_interface) > 0 AND BINARY interface <> ? AND BINARY SUBSTRING_INDEX(interface, '/', 2) <> ? LIMIT 1 FOR UPDATE`,
        [endpointId, iface, local]);
      if (stateReferences.length) throw new ConflictError('Extension is still used as another queue member\'s state interface');
      await execute(conn, "DELETE FROM queue_members WHERE BINARY interface = ? OR BINARY SUBSTRING_INDEX(interface, '/', 2) = ?", [iface, local]);
      await removeDialplan(conn, context, extension);
      await execute(conn, 'DELETE FROM ps_endpoints WHERE BINARY id = ?', [endpointId]);
      await execute(conn, 'DELETE FROM ps_auths WHERE BINARY id = ?', [endpointId]);
      await execute(conn, 'DELETE FROM ps_aors WHERE BINARY id = ?', [endpointId]);
    });
  }

  createQueue(input: QueueCreate, scope: PbxTenantScope): Promise<void> {
    return this.transaction(async conn => {
      const context = scope.contexts[0];
      if (!context) throw new ValidationError('Queue creation requires an approved tenant context');
      await execute(conn, 'INSERT INTO queues (name, strategy) VALUES (?, ?)', [input.name, input.strategy]);
      if ((await lockDialplan(conn, context, markerExten(input.name))).length) throw new ConflictError('Queue ownership marker is already in use');
      await insertDialplan(conn, context, markerExten(input.name), [{ priority: 1, app: 'NoOp', appdata: markerData(input.name) }]);
    });
  }

  deleteQueue(name: string, scope: PbxTenantScope): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, name, scope);
      // Locking read sees current committed routes after obtaining the queue lock, including at REPEATABLE READ.
      const references = await read(conn,
        "SELECT exten FROM extensions WHERE (BINARY app = ? AND LOCATE(?, BINARY appdata) = 1) OR (BINARY app = ? AND BINARY SUBSTRING_INDEX(appdata, ',', 1) = ?) LIMIT 1 FOR UPDATE",
        ['Gosub', `aida-managed-did-v1,s,1(${name},`, 'Queue', name]);
      if (references.length) throw new ConflictError('Queue is still referenced by a DID; change or delete the route first');
      await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ?', [name]);
      await execute(conn, 'DELETE FROM queues WHERE BINARY name = ?', [name]);
      if (scope.contexts.length) await execute(conn,
        `DELETE FROM extensions WHERE BINARY context IN (${placeholders(scope.contexts)}) AND BINARY exten = ? AND priority = ? AND BINARY app = ? AND BINARY appdata = ?`,
        [...scope.contexts, markerExten(name), 1, 'NoOp', markerData(name)]);
    });
  }

  setQueueMember(input: QueueMember, scope: PbxTenantScope): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, input.queue, scope);
      if (!scope.contexts.includes(input.context)) throw new NotFoundError('Extension was not found in this tenant');
      await this.ownedEndpoint(conn, input.extension, input.endpointId, [input.context]);
      const iface = `PJSIP/${input.endpointId}`;
      // Serialized by the queue lock; delete/insert is idempotent without UPDATE grants or a vendor-specific unique key.
      await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ? AND BINARY interface = ?', [input.queue, iface]);
      await execute(conn, 'INSERT INTO queue_members (queue_name, interface, membername, penalty, paused) VALUES (?, ?, ?, ?, ?)',
        [input.queue, iface, input.extension, input.penalty, input.paused ? 1 : 0]);
    });
  }

  deleteQueueMember(queue: string, extension: string, endpointId: string, scope: PbxTenantScope): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, queue, scope);
      await this.ownedEndpoint(conn, extension, endpointId, scope.contexts);
      const result = await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ? AND BINARY interface = ?', [queue, `PJSIP/${endpointId}`]);
      if (!result.affectedRows) throw new NotFoundError('Queue membership was not found in this tenant');
    });
  }

  async listDids(context: string, dids: readonly string[]): Promise<DidInventory[]> {
    if (!dids.length) return [];
    if (dids.length > 100) throw new ValidationError('DID inventory exceeds the supported tenant allowlist size');
    try {
      const rows = await read(this.pool,
        `SELECT exten, priority, app, appdata FROM extensions WHERE BINARY context = ? AND BINARY exten IN (${placeholders(dids)}) ORDER BY exten, priority LIMIT 1001`,
        [context, ...dids]);
      if (rows.length > MAX_ROWS) throw new DependencyUnavailableError('PBX DID inventory exceeds the supported POC size');
      return dids.map(did => ({ did, rows: dialplan(rows.filter(row => row.exten === did)) }));
    } catch (error) { throw safeError(error); }
  }

  setDid(context: string, did: string, queue: string, rows: DialplanRow[], scope: PbxTenantScope): Promise<void> {
    return this.transaction(async conn => {
      if (context !== scope.didContext || !scope.didNumbers?.includes(did)) throw new ValidationError('DID is outside this tenant\'s allowlist');
      const settings = recognizeDidRows(did, rows);
      if (!settings || settings.queue !== queue) throw new ValidationError('DID rows are not a recognized managed route');
      await this.ownedQueue(conn, queue, scope);
      const existing = await lockDialplan(conn, context, did);
      if (existing.length && !recognizeDidRows(did, existing)) throw new ConflictError('DID has an unmanaged dialplan route');
      await removeDialplan(conn, context, did);
      await insertDialplan(conn, context, did, rows);
    });
  }

  deleteDid(context: string, did: string): Promise<void> {
    return this.transaction(async conn => {
      const existing = await lockDialplan(conn, context, did);
      if (!existing.length) throw new NotFoundError('Managed DID route was not found');
      if (!recognizeDidRows(did, existing)) throw new ConflictError('DID has an unmanaged dialplan route');
      await removeDialplan(conn, context, did);
    });
  }
}
