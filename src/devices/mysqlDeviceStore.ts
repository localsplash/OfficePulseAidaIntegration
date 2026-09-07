import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { CallSessionRecord, RuntimeStore } from '../runtime/store.js';
import type { DeviceGrant, DeviceStore } from './access.js';

/** Only the integration-owned runtime database; no DDL or credentials in Asterisk. */
export class MysqlDeviceStore implements DeviceStore {
  private readonly pool: mysql.Pool;
  constructor(config: RuntimeMysqlConfig, private readonly runtime: RuntimeStore) {
    this.pool = mysql.createPool({ ...config, connectionLimit: config.connectionLimit ?? 5 });
  }
  async close(): Promise<void> { await this.pool.end(); }

  async issueEnrollment(hash: string, iTenantId: number, extensionId: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO aida_tbl_DeviceEnrollment (tokenHash,iTenantId,uidExtension,dtExpires) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))',
      [hash, iTenantId, extensionId],
    );
  }

  async consumeEnrollment(hash: string, hardwareId: string, sessionHash: string): Promise<DeviceGrant | undefined> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        'SELECT iTenantId,uidExtension FROM aida_tbl_DeviceEnrollment WHERE tokenHash=? AND dtConsumed IS NULL AND dtExpires>UTC_TIMESTAMP(3) FOR UPDATE', [hash],
      );
      const row = rows[0];
      if (!row) { await conn.rollback(); return undefined; }
      const grant = { id: randomUUID(), iTenantId: Number(row.iTenantId), extensionId: String(row.uidExtension) };
      // A new enrollment for this hardware/extension supersedes earlier device capabilities.
      await conn.execute('UPDATE aida_tbl_DeviceSession SET dtRevoked=UTC_TIMESTAMP(3) WHERE hardwareId=? AND uidExtension=? AND iTenantId=? AND dtRevoked IS NULL', [hardwareId, grant.extensionId, grant.iTenantId]);
      await conn.execute(
        'INSERT INTO aida_tbl_DeviceSession (uidDevice,iTenantId,uidExtension,hardwareId,tokenHash) VALUES (?,?,?,?,?)',
        [grant.id, grant.iTenantId, grant.extensionId, hardwareId, sessionHash],
      );
      await conn.execute('UPDATE aida_tbl_DeviceEnrollment SET dtConsumed=UTC_TIMESTAMP(3) WHERE tokenHash=?', [hash]);
      await conn.commit();
      return grant;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  async resolveSession(hash: string): Promise<DeviceGrant | undefined> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT uidDevice,iTenantId,uidExtension FROM aida_tbl_DeviceSession WHERE tokenHash=? AND dtRevoked IS NULL', [hash],
    );
    const row = rows[0];
    return row ? { id: String(row.uidDevice), iTenantId: Number(row.iTenantId), extensionId: String(row.uidExtension) } : undefined;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.pool.execute('UPDATE aida_tbl_DeviceSession SET dtRevoked=UTC_TIMESTAMP(3) WHERE uidDevice=? AND dtRevoked IS NULL', [id]);
  }

  async getDevice(id: string): Promise<DeviceGrant | undefined> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      'SELECT uidDevice,iTenantId,uidExtension FROM aida_tbl_DeviceSession WHERE uidDevice=? AND dtRevoked IS NULL', [id],
    );
    const row = rows[0];
    return row ? { id: String(row.uidDevice), iTenantId: Number(row.iTenantId), extensionId: String(row.uidExtension) } : undefined;
  }

  async listCalls(tenantId: string, destinations: string[]): Promise<CallSessionRecord[]> {
    if (!destinations.length) return [];
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM call_session WHERE tenant_id=? AND destination_id IN (${destinations.map(() => '?').join(',')}) AND ended_at IS NULL ORDER BY created_at DESC LIMIT 100`,
      [tenantId, ...destinations],
    );
    const calls = await Promise.all(rows.map((r) => this.runtime.getCallSession(String(r.id))));
    return calls.filter((c): c is CallSessionRecord => !!c && c.tenantId === tenantId && !c.endedAt);
  }
}
