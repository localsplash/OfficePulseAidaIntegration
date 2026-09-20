import mysql from 'mysql2/promise';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { CallSessionRecord, RuntimeStore } from '../runtime/store.js';
import { credentialHash, type DeviceGrant, type DeviceStore } from './access.js';

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
function device(row: mysql.RowDataPacket): DeviceGrant {
  return { id: row.id, pbxInstanceId: row.pbx_instance_id, context: row.pbx_context, endpointId: row.endpoint_id,
    appInstanceId: row.app_instance_id, extension: row.extension, label: row.label, mac: row.mac,
    publicIp: row.public_ip, localIp: row.local_ip, deviceModel: row.device_model, appVersion: row.app_version,
    attachedAt: iso(row.attached_at), lastSeenAt: iso(row.last_seen_at), expiresAt: iso(row.expires_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    ...(row.iTenantId == null ? {} : { iTenantId: Number(row.iTenantId) }) };
}
/** Only integration-owned session capabilities. Vendor access is through the read-only inventory. */
export class MysqlDeviceStore implements DeviceStore {
  private readonly pool: mysql.Pool;
  constructor(config: RuntimeMysqlConfig, private readonly runtime: RuntimeStore) {
    this.pool = mysql.createPool({ ...config, timezone: 'Z', connectionLimit: config.connectionLimit ?? 5, connectTimeout: 4000 });
  }
  async close(): Promise<void> { await this.pool.end(); }
  async attach(d: DeviceGrant, tokenHash: string): Promise<string[]> {
    const conn = await this.pool.getConnection();
    // Serialize replacements even when no prior rows exist. The scope is one PBX, so
    // crossing endpoint/app-instance replacement requests cannot leave two sessions live.
    const lock = credentialHash(`handset:${d.pbxInstanceId}`);
    let locked = false;
    try {
      const [locks] = await conn.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS acquired', [lock]);
      locked = Number(locks[0]?.acquired) === 1;
      if (!locked) throw new Error('handset attach lock unavailable');
      await conn.beginTransaction();
      const [previous] = await conn.execute<mysql.RowDataPacket[]>('SELECT id FROM handset_device WHERE pbx_instance_id=? AND revoked_at IS NULL AND (app_instance_id=? OR (pbx_context=? AND endpoint_id=?)) FOR UPDATE', [d.pbxInstanceId, d.appInstanceId, d.context, d.endpointId]);
      await conn.execute('UPDATE handset_device SET revoked_at=UTC_TIMESTAMP(3) WHERE pbx_instance_id=? AND revoked_at IS NULL AND (app_instance_id=? OR (pbx_context=? AND endpoint_id=?))', [d.pbxInstanceId, d.appInstanceId, d.context, d.endpointId]);
      await conn.execute('INSERT INTO handset_device (id,pbx_instance_id,pbx_context,endpoint_id,app_instance_id,token_hash,iTenantId,extension,label,mac,public_ip,local_ip,device_model,app_version,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [d.id,d.pbxInstanceId,d.context,d.endpointId,d.appInstanceId,tokenHash,d.iTenantId ?? null,d.extension,d.label,d.mac,d.publicIp,d.localIp,d.deviceModel,d.appVersion,new Date(d.expiresAt)]);
      await conn.commit(); return previous.map(row => String(row.id));
    } catch (error) { await conn.rollback(); throw error; }
    finally { if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {}); conn.release(); }
  }
  async resolveSession(hash: string): Promise<DeviceGrant | undefined> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT * FROM handset_device WHERE token_hash=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3)', [hash]);
    return rows[0] ? device(rows[0]) : undefined;
  }
  async getDevice(id: string): Promise<DeviceGrant | undefined> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT * FROM handset_device WHERE id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3)', [id]);
    return rows[0] ? device(rows[0]) : undefined;
  }
  async touch(id: string): Promise<void> {
    await this.pool.execute('UPDATE handset_device SET last_seen_at=UTC_TIMESTAMP(3) WHERE id=? AND last_seen_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE)', [id]);
  }
  async revokeDevice(id: string): Promise<void> {
    await this.pool.execute('UPDATE handset_device SET revoked_at=UTC_TIMESTAMP(3) WHERE id=? AND revoked_at IS NULL', [id]);
  }
  async listDevices(pbxInstanceId: string, context: string): Promise<DeviceGrant[]> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT * FROM handset_device WHERE pbx_instance_id=? AND pbx_context=? ORDER BY attached_at DESC LIMIT 1000', [pbxInstanceId,context]);
    return rows.map(device);
  }
  async listCalls(d: DeviceGrant, queues: string[]): Promise<CallSessionRecord[]> {
    if (!queues.length) return [];
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM call_session WHERE BINARY officepulse_instance_id=? AND BINARY pbx_context=? AND destination_type='QUEUE' AND BINARY destination_id IN (${queues.map(() => '?').join(',')}) AND ended_at IS NULL AND state IN ('screening','admitted','agent-ready','ringing') ORDER BY created_at DESC LIMIT 100`,
      [d.pbxInstanceId,d.context,...queues]);
    const calls = await Promise.all(rows.map(row => this.runtime.getCallSession(String(row.id))));
    return calls.filter((c): c is CallSessionRecord => !!c);
  }
}
