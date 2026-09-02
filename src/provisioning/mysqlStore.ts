import mysql from 'mysql2/promise';
import type {
  AidaDeviceRow,
  AidaObjectKind,
  AidaObjectRow,
  AorRow,
  AuthRow,
  DialplanRow,
  EndpointRow,
  RealtimeStore,
  RealtimeTx,
  RequestRecord,
} from './store.js';

export interface MysqlStoreConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

type Executor = Pick<mysql.Pool, 'execute'> | Pick<mysql.PoolConnection, 'execute'>;

/**
 * MySQL-backed store over the installed Asterisk 22 Realtime schemas.
 * Every statement is a prepared statement with bound parameters — no
 * string interpolation of caller data ever reaches SQL. The connecting
 * MySQL account is expected to be least-privilege: SELECT/INSERT/UPDATE/
 * DELETE on the six tables below only (see deploy/sql/grants.sql).
 */
export class MysqlRealtimeStore implements RealtimeStore {
  private readonly pool: mysql.Pool;

  constructor(config: MysqlStoreConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit ?? 5,
      namedPlaceholders: false,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async withTransaction<T>(fn: (tx: RealtimeTx) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx = new MysqlTx(conn);
      const result = await fn(tx);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* connection-level failure; pool will recycle */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  async getAuth(authId: string): Promise<AuthRow | undefined> {
    const [rows] = await this.pool.execute('SELECT id, auth_type, username, password FROM ps_auths WHERE id = ?', [authId]);
    return (rows as AuthRow[])[0];
  }

  async getEndpoint(endpointId: string): Promise<EndpointRow | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT id, transport, aors, auth, context, disallow, allow, callerid FROM ps_endpoints WHERE id = ?',
      [endpointId],
    );
    return (rows as EndpointRow[])[0];
  }

  async getDialplan(context: string, exten: string): Promise<DialplanRow[]> {
    const [rows] = await this.pool.execute(
      'SELECT priority, app, appdata FROM extensions WHERE context = ? AND exten = ? ORDER BY priority',
      [context, exten],
    );
    return rows as DialplanRow[];
  }

  async getAidaObject(kind: AidaObjectKind, externalId: string): Promise<AidaObjectRow | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT kind, external_id, tenant_id, context, exten, endpoint_id, enabled FROM aida_object WHERE kind = ? AND external_id = ?',
      [kind, externalId],
    );
    return (rows as AidaObjectRow[])[0];
  }

  async findExtensionObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    const [rows] = await this.pool.execute(
      "SELECT kind, external_id, tenant_id, context, exten, endpoint_id, enabled FROM aida_object WHERE kind = 'EXTENSION' AND context = ? AND exten = ?",
      [context, exten],
    );
    return (rows as AidaObjectRow[])[0];
  }

  async findDidObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    const [rows] = await this.pool.execute(
      "SELECT kind, external_id, tenant_id, context, exten, endpoint_id, enabled FROM aida_object WHERE kind = 'DID' AND context = ? AND exten = ?",
      [context, exten],
    );
    return (rows as AidaObjectRow[])[0];
  }

  async findObjectAtLocation(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT kind, external_id, tenant_id, context, exten, endpoint_id, enabled FROM aida_object WHERE context = ? AND exten = ?',
      [context, exten],
    );
    return (rows as AidaObjectRow[])[0];
  }

  async getAidaDeviceByExtension(extensionExternalId: string): Promise<AidaDeviceRow | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT device_id, extension_external_id, provisioning_mac, provisioning_profile FROM aida_device WHERE extension_external_id = ?',
      [extensionExternalId],
    );
    return (rows as AidaDeviceRow[])[0];
  }

  async getRequest(requestId: string): Promise<RequestRecord | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT request_id, kind, external_id, action FROM aida_provisioning_request WHERE request_id = ?',
      [requestId],
    );
    return (rows as RequestRecord[])[0];
  }
}

class MysqlTx implements RealtimeTx {
  constructor(private readonly conn: Executor) {}

  async upsertAor(row: AorRow): Promise<void> {
    await this.conn.execute(
      `INSERT INTO ps_aors (id, max_contacts, remove_existing) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE max_contacts = VALUES(max_contacts), remove_existing = VALUES(remove_existing)`,
      [row.id, row.max_contacts, row.remove_existing],
    );
  }

  async upsertAuth(row: AuthRow): Promise<void> {
    await this.conn.execute(
      `INSERT INTO ps_auths (id, auth_type, username, password) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE auth_type = VALUES(auth_type), username = VALUES(username), password = VALUES(password)`,
      [row.id, row.auth_type, row.username, row.password],
    );
  }

  async upsertEndpoint(row: EndpointRow): Promise<void> {
    await this.conn.execute(
      `INSERT INTO ps_endpoints (id, transport, aors, auth, context, disallow, allow, callerid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE transport = VALUES(transport), aors = VALUES(aors), auth = VALUES(auth),
         context = VALUES(context), disallow = VALUES(disallow), allow = VALUES(allow), callerid = VALUES(callerid)`,
      [row.id, row.transport, row.aors, row.auth, row.context, row.disallow, row.allow, row.callerid],
    );
  }

  async deleteEndpointBundle(endpointId: string): Promise<void> {
    await this.conn.execute('DELETE FROM ps_endpoints WHERE id = ?', [endpointId]);
    await this.conn.execute('DELETE FROM ps_auths WHERE id = ?', [endpointId]);
    await this.conn.execute('DELETE FROM ps_aors WHERE id = ?', [endpointId]);
  }

  async setEndpointFields(endpointId: string, fields: Partial<Pick<EndpointRow, 'context' | 'callerid'>>): Promise<void> {
    const sets: string[] = [];
    const params: string[] = [];
    if (fields.context !== undefined) {
      sets.push('context = ?');
      params.push(fields.context);
    }
    if (fields.callerid !== undefined) {
      sets.push('callerid = ?');
      params.push(fields.callerid);
    }
    if (sets.length === 0) return;
    params.push(endpointId);
    await this.conn.execute(`UPDATE ps_endpoints SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async setAuthPassword(authId: string, password: string): Promise<void> {
    await this.conn.execute('UPDATE ps_auths SET password = ? WHERE id = ?', [password, authId]);
  }

  async replaceDialplan(context: string, exten: string, rows: DialplanRow[]): Promise<void> {
    await this.conn.execute('DELETE FROM extensions WHERE context = ? AND exten = ?', [context, exten]);
    for (const row of rows) {
      await this.conn.execute('INSERT INTO extensions (context, exten, priority, app, appdata) VALUES (?, ?, ?, ?, ?)', [
        context,
        exten,
        row.priority,
        row.app,
        row.appdata,
      ]);
    }
  }

  async deleteDialplan(context: string, exten: string): Promise<void> {
    await this.conn.execute('DELETE FROM extensions WHERE context = ? AND exten = ?', [context, exten]);
  }

  async upsertAidaObject(row: AidaObjectRow): Promise<void> {
    await this.conn.execute(
      `INSERT INTO aida_object (kind, external_id, tenant_id, context, exten, endpoint_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), context = VALUES(context), exten = VALUES(exten),
         endpoint_id = VALUES(endpoint_id), enabled = VALUES(enabled)`,
      [row.kind, row.external_id, row.tenant_id, row.context, row.exten, row.endpoint_id, row.enabled],
    );
  }

  async upsertAidaDevice(row: AidaDeviceRow): Promise<void> {
    await this.conn.execute(
      `INSERT INTO aida_device (device_id, extension_external_id, provisioning_mac, provisioning_profile)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE extension_external_id = VALUES(extension_external_id),
         provisioning_mac = VALUES(provisioning_mac), provisioning_profile = VALUES(provisioning_profile)`,
      [row.device_id, row.extension_external_id, row.provisioning_mac, row.provisioning_profile],
    );
  }

  async recordRequest(record: RequestRecord): Promise<void> {
    await this.conn.execute(
      'INSERT INTO aida_provisioning_request (request_id, kind, external_id, action) VALUES (?, ?, ?, ?)',
      [record.request_id, record.kind, record.external_id, record.action],
    );
  }
}
