import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type { RuntimeMysqlConfig } from '../runtime/mysqlRuntimeStore.js';
import type { ProfileSnapshot } from './contract.js';
import { CredentialRejected, profileSnapshot, sameHash } from './contract.js';

export interface Admission {
  callId: string; tenantId: string; roomName: string; instanceId: string; linkedId: string;
  /** Routing scope pinned at admission; ingressContext lets ownership be re-derived from the DID's own rows. */
  pbxInstanceId: string; context: string; ingressContext: string;
  bootstrapHash: string; routeHash: string; profile: ProfileSnapshot; expiresAt: number;
  dispatchId?: string; agentIdentity?: string; agentSid?: string; sipIdentity?: string; sipSid?: string;
  status: 'pending' | 'dispatched' | 'admitted' | 'ready' | 'fallback' | 'ended';
}
export interface AdmissionStore {
  create(value: Admission): Promise<void>;
  get(callId: string): Promise<Admission | undefined>;
  dispatched(callId: string, dispatchId: string): Promise<void>;
  consume(expected: Admission, binding: { bootstrapHash: string; routeHash: string; sipIdentity: string; sipSid: string; agentIdentity: string; agentSid: string }): Promise<ProfileSnapshot>;
  transition(callId: string, status: 'ready' | 'fallback' | 'ended', event: string): Promise<boolean>;
}
function decode(row: mysql.RowDataPacket): Admission {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return { ...data, callId: row.call_id, status: row.status, dispatchId: row.dispatch_id ?? undefined,
    sipIdentity: row.sip_identity ?? undefined, sipSid: row.sip_sid ?? undefined,
    agentIdentity: row.agent_identity ?? undefined, agentSid: row.agent_sid ?? undefined };
}
/** Call lock precedes admission lock, matching lifecycle/webhook writers. No plaintext tokens. */
export class MysqlAdmissionStore implements AdmissionStore {
  private readonly pool: mysql.Pool;
  constructor(config: RuntimeMysqlConfig) { this.pool = mysql.createPool({ ...config, connectionLimit: 4, connectTimeout: 4000 }); }
  close(): Promise<void> { return this.pool.end(); }
  async create(a: Admission): Promise<void> {
    await this.pool.execute('INSERT INTO agent_admission (call_id,status,data) VALUES (?, ?, ?)', [a.callId, 'pending', JSON.stringify(a)]);
  }
  async get(id: string): Promise<Admission | undefined> {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>('SELECT * FROM agent_admission WHERE call_id=?', [id]);
    return rows[0] ? decode(rows[0]) : undefined;
  }
  async dispatched(id: string, dispatchId: string): Promise<void> {
    const [r] = await this.pool.execute<mysql.ResultSetHeader>("UPDATE agent_admission SET dispatch_id=?,status='dispatched' WHERE call_id=? AND status='pending'", [dispatchId, id]);
    if (r.affectedRows !== 1) throw new CredentialRejected();
  }
  private async event(conn: mysql.PoolConnection, id: string, event: string): Promise<void> {
    await conn.execute(`INSERT INTO call_event (id,call_session_id,sequence_number,event_type)
      SELECT ?, ?, COALESCE(MAX(sequence_number),0)+1, ? FROM call_event WHERE call_session_id=?`, [randomUUID(), id, event, id]);
  }
  async consume(expected: Admission, b: Parameters<AdmissionStore['consume']>[1]): Promise<ProfileSnapshot> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [calls] = await conn.execute<mysql.RowDataPacket[]>('SELECT * FROM call_session WHERE id=? FOR UPDATE', [expected.callId]);
      const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT *, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS now_ms FROM agent_admission WHERE call_id=? FOR UPDATE', [expected.callId]);
      const c = calls[0]; const a = rows[0] ? decode(rows[0]) : undefined;
      if (!a || !c || a.status !== 'dispatched' || a.expiresAt <= Number(rows[0]!.now_ms) || c.ended_at || c.disposition !== 'SCREEN' ||
        ['ended','failed','fallback','human-active'].includes(c.state) || a.dispatchId !== expected.dispatchId ||
        !sameHash(a.bootstrapHash, b.bootstrapHash) || !sameHash(a.routeHash, b.routeHash) || a.tenantId !== expected.tenantId ||
        a.pbxInstanceId !== expected.pbxInstanceId || a.context !== expected.context ||
        c.tenant_id !== a.tenantId || c.room_name !== a.roomName || c.officepulse_instance_id !== a.instanceId || c.asterisk_linked_id !== a.linkedId ||
        // Routing scope is pinned three ways: snapshot, admission and call record must all agree (#22).
        c.officepulse_instance_id !== a.pbxInstanceId || c.pbx_context !== a.context) throw new CredentialRejected();
      // v2 only: a stored v1 snapshot (or any malformed one) is a rejected credential, never a 400 to the Agent.
      let profile: ProfileSnapshot; try { profile = profileSnapshot(a.profile); } catch { throw new CredentialRejected(); }
      if (profile.tenantId !== a.tenantId || profile.callSessionId !== a.callId || profile.didE164 !== c.did_e164 ||
        profile.pbxInstanceId !== a.pbxInstanceId || profile.context !== a.context) throw new CredentialRejected();
      await conn.execute("UPDATE agent_admission SET status='admitted',sip_identity=?,sip_sid=?,agent_identity=?,agent_sid=? WHERE call_id=?",
        [b.sipIdentity, b.sipSid, b.agentIdentity, b.agentSid, a.callId]);
      await conn.execute("UPDATE call_session SET state='admitted',agent_participant_sid=?,version=version+1 WHERE id=?", [b.agentSid, a.callId]);
      await this.event(conn, a.callId, 'agent-admitted');
      await conn.commit(); return profile;
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }
  async transition(id: string, status: 'ready' | 'fallback' | 'ended', event: string): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [calls] = await conn.execute<mysql.RowDataPacket[]>('SELECT ended_at,state FROM call_session WHERE id=? FOR UPDATE', [id]);
      const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT status FROM agent_admission WHERE call_id=? FOR UPDATE', [id]);
      const previous = rows[0]?.status;
      if (!previous || previous === 'ended' || previous === status || (status !== 'ended' &&
        (previous === 'fallback' || calls[0]?.ended_at || calls[0]?.state === 'human-active')) || (status === 'ready' && previous !== 'admitted')) {
        await conn.rollback(); return false;
      }
      await conn.execute('UPDATE agent_admission SET status=? WHERE call_id=?', [status, id]);
      await conn.execute(`UPDATE call_session SET state=?,version=version+1${status === 'fallback' ? ",disposition='FALLBACK',agent_participant_sid=NULL" : ''}${status === 'ended' ? ',ended_at=COALESCE(ended_at,CURRENT_TIMESTAMP),agent_participant_sid=NULL' : ''} WHERE id=?`, [status === 'ready' ? 'agent-ready' : status, id]);
      await this.event(conn, id, event);
      await conn.commit(); return true;
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }
}
