import { randomBytes } from 'node:crypto';
import { queueMarkerData as markerData, queueMarkerExten as markerExten, ownedQueueNames, queueOwner, type MarkerQuery } from './queueOwnership.js';
import mysql from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';
import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../errors.js';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import { dialedEndpoint } from './inventory.js';
import { NAME_RE, recognizeDidRows, type DialplanRow } from './managedDid.js';

export interface ExtensionCreate {
  extension: string; endpointId: string; context: string; displayName?: string; callerIdNumber?: string;
}
export interface QueueCreate { name: string; strategy: string }
export interface QueueMember {
  queue: string; extension: string; context: string; penalty: number; paused: boolean;
}
export interface DidInventory { did: string; rows: DialplanRow[] }
/** Every operation is scoped by one extension context; ownership comes from Asterisk's own rows, never a tenant map. */
export interface PbxProvisioner {
  createExtension(input: ExtensionCreate): Promise<{ extension: string; sipUsername: string; sipSecret: string }>;
  /** The endpoint id is resolved from the context's managed Dial route, so legacy `<ext>-t<N>` bundles keep working. */
  deleteExtension(extension: string, context: string): Promise<void>;
  /** Returns the native queue id: the exact name when this context already owns it, else `<context>.<slug>`. */
  createQueue(input: QueueCreate, context: string): Promise<{ name: string }>;
  deleteQueue(name: string, context: string): Promise<void>;
  setQueueMember(input: QueueMember): Promise<void>;
  deleteQueueMember(queue: string, extension: string, context: string): Promise<void>;
  ownedQueues(context: string): Promise<string[]>;
  listDids(didContext: string, dids: readonly string[]): Promise<DidInventory[]>;
  setDid(didContext: string, did: string, queue: string, rows: DialplanRow[], context: string): Promise<void>;
  deleteDid(didContext: string, did: string, context: string): Promise<void>;
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
const reader = (conn: SqlConnection): MarkerQuery => (sql, values) => read(conn, sql, values);
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

  private async ownedQueue(conn: SqlConnection, name: string, context: string): Promise<void> {
    const missing = () => new NotFoundError('Queue was not found in this context');
    // The queue row serializes membership changes, DID writes and queue deletion.
    const queues = await read(conn, 'SELECT name FROM queues WHERE BINARY name = ? LIMIT 1 FOR UPDATE', [name]);
    if (!queues.length) throw missing();
    // Exactly one marker row, and it must sit in this context; a duplicate elsewhere is ambiguous and owned by nobody.
    if (await queueOwner(reader(conn), name, true) !== context) throw missing();
  }

  /** The endpoint dialed by this context's managed route for the extension. Absent and foreign routes are the same 404. */
  private async managedEndpoint(conn: SqlConnection, extension: string, context: string): Promise<{ id: string; rows: DialplanRow[]; endpoint: DbRow }> {
    const missing = () => new NotFoundError('Extension was not found in this context');
    const rows = await lockDialplan(conn, context, extension);
    const id = rows[0]?.priority === 1 && rows[0].app === 'Dial' ? dialedEndpoint(rows[0].appdata) : undefined;
    if (!id) throw missing();
    const endpoints = await read(conn, 'SELECT id, context, auth, aors FROM ps_endpoints WHERE BINARY id = ? AND BINARY context = ? LIMIT 1 FOR UPDATE', [id, context]);
    if (!endpoints.length) throw missing();
    return { id, rows, endpoint: endpoints[0]! };
  }

  createExtension(input: ExtensionCreate): Promise<{ extension: string; sipUsername: string; sipSecret: string }> {
    const callerId = input.displayName ? `"${input.displayName}" <${input.callerIdNumber ?? input.extension}>` : (input.callerIdNumber ?? input.extension);
    if (input.context.length > 40 || input.extension.length > 40 || input.endpointId.length > 40 || callerId.length > 40) {
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

  deleteExtension(extension: string, context: string): Promise<void> {
    return this.transaction(async conn => {
      const { id: endpointId, rows, endpoint } = await this.managedEndpoint(conn, extension, context);
      if (endpoint.auth !== endpointId || endpoint.aors !== endpointId) throw new ConflictError('Extension uses a shared or unmanaged auth/AOR bundle');
      if (JSON.stringify(rows) !== JSON.stringify(extensionRows(endpointId))) throw new ConflictError('Extension has an unmanaged dialplan route');
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

  createQueue(input: QueueCreate, context: string): Promise<{ name: string }> {
    return this.transaction(async conn => {
      // An adopted legacy name keeps its exact native id; anything else is namespaced by its context.
      const owned = await queueOwner(reader(conn), input.name, true) === context;
      let name = input.name;
      if (!owned) {
        if (input.name.length > 60) throw new ValidationError('queue friendly name must be at most 60 characters');
        name = `${context}.${input.name}`;
        if (!NAME_RE.test(name)) throw new ValidationError('native queue ID exceeds 80 characters');
      }
      await execute(conn, 'INSERT INTO queues (name, strategy) VALUES (?, ?)', [name, input.strategy]);
      if (owned) return { name };
      // A marker for this id in any context, including a foreign one, would make ownership ambiguous.
      const markers = await read(conn, "SELECT context FROM extensions WHERE BINARY exten = ? AND priority = 1 AND app = 'NoOp' AND BINARY appdata = ? LIMIT 2 FOR UPDATE", [markerExten(name), markerData(name)]);
      if (markers.length || (await lockDialplan(conn, context, markerExten(name))).length) throw new ConflictError('Queue ownership marker is already in use');
      await insertDialplan(conn, context, markerExten(name), [{ priority: 1, app: 'NoOp', appdata: markerData(name) }]);
      return { name };
    });
  }

  deleteQueue(name: string, context: string): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, name, context);
      // Locking read sees current committed routes after obtaining the queue lock, including at REPEATABLE READ.
      const references = await read(conn,
        "SELECT exten FROM extensions WHERE (BINARY app = ? AND LOCATE(?, BINARY appdata) = 1) OR (BINARY app = ? AND BINARY SUBSTRING_INDEX(appdata, ',', 1) = ?) LIMIT 1 FOR UPDATE",
        ['Gosub', `aida-managed-did-v1,s,1(${name},`, 'Queue', name]);
      if (references.length) throw new ConflictError('Queue is still referenced by a DID; change or delete the route first');
      await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ?', [name]);
      await execute(conn, 'DELETE FROM queues WHERE BINARY name = ?', [name]);
      await execute(conn,
        'DELETE FROM extensions WHERE BINARY context = ? AND BINARY exten = ? AND priority = ? AND BINARY app = ? AND BINARY appdata = ?',
        [context, markerExten(name), 1, 'NoOp', markerData(name)]);
    });
  }

  setQueueMember(input: QueueMember): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, input.queue, input.context);
      const { id } = await this.managedEndpoint(conn, input.extension, input.context);
      const iface = `PJSIP/${id}`;
      // Serialized by the queue lock; delete/insert is idempotent without UPDATE grants or a vendor-specific unique key.
      await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ? AND BINARY interface = ?', [input.queue, iface]);
      await execute(conn, 'INSERT INTO queue_members (queue_name, interface, membername, penalty, paused) VALUES (?, ?, ?, ?, ?)',
        [input.queue, iface, input.extension, input.penalty, input.paused ? 1 : 0]);
    });
  }

  deleteQueueMember(queue: string, extension: string, context: string): Promise<void> {
    return this.transaction(async conn => {
      await this.ownedQueue(conn, queue, context);
      const { id } = await this.managedEndpoint(conn, extension, context);
      const result = await execute(conn, 'DELETE FROM queue_members WHERE BINARY queue_name = ? AND BINARY interface = ?', [queue, `PJSIP/${id}`]);
      if (!result.affectedRows) throw new NotFoundError('Queue membership was not found in this context');
    });
  }

  async ownedQueues(context: string): Promise<string[]> {
    try { return await ownedQueueNames(reader(this.pool), context); }
    catch (error) { throw safeError(error); }
  }

  async listDids(didContext: string, dids: readonly string[]): Promise<DidInventory[]> {
    if (!dids.length) return [];
    if (dids.length > 100) throw new ValidationError('DID inventory exceeds the supported authorized Number list size');
    try {
      const rows = await read(this.pool,
        `SELECT exten, priority, app, appdata FROM extensions WHERE BINARY context = ? AND BINARY exten IN (${placeholders(dids)}) ORDER BY exten, priority LIMIT 1001`,
        [didContext, ...dids]);
      if (rows.length > MAX_ROWS) throw new DependencyUnavailableError('PBX DID inventory exceeds the supported POC size');
      return dids.map(did => ({ did, rows: dialplan(rows.filter(row => row.exten === did)) }));
    } catch (error) { throw safeError(error); }
  }

  /** Only a recognized route whose queue this context owns may be replaced or deleted; manual and foreign routes stay put. */
  private async replaceable(conn: SqlConnection, did: string, existing: DialplanRow[], context: string): Promise<void> {
    const current = recognizeDidRows(did, existing);
    if (!current) throw new ConflictError('DID has an unmanaged dialplan route');
    if (await queueOwner(reader(conn), current.queue, true) !== context) throw new ConflictError('DID route belongs to another context');
  }

  setDid(didContext: string, did: string, queue: string, rows: DialplanRow[], context: string): Promise<void> {
    return this.transaction(async conn => {
      const settings = recognizeDidRows(did, rows);
      if (!settings || settings.queue !== queue) throw new ValidationError('DID rows are not a recognized managed route');
      await this.ownedQueue(conn, queue, context);
      const existing = await lockDialplan(conn, didContext, did);
      if (existing.length) await this.replaceable(conn, did, existing, context);
      await removeDialplan(conn, didContext, did);
      await insertDialplan(conn, didContext, did, rows);
    });
  }

  deleteDid(didContext: string, did: string, context: string): Promise<void> {
    return this.transaction(async conn => {
      const existing = await lockDialplan(conn, didContext, did);
      if (!existing.length) throw new NotFoundError('Managed DID route was not found');
      await this.replaceable(conn, did, existing, context);
      await removeDialplan(conn, didContext, did);
    });
  }
}
