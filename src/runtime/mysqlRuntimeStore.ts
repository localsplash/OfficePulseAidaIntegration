import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type {
  CallEventRecord,
  CallSessionRecord,
  ControlCommandRecord,
  DidFallbackRecord,
  Disposition,
  NewCallSession,
  ProvisioningOperationRecord,
  RuntimeStore,
} from './store.js';
import type { DestinationType } from '../nocodb/configRepository.js';

export interface RuntimeMysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function isDuplicate(err: unknown): boolean {
  return (err as { code?: string })?.code === DUPLICATE_ENTRY;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date().toISOString();
}

interface CallSessionRow {
  id: string;
  asterisk_linked_id: string;
  officepulse_instance_id: string;
  tenant_id: string;
  did_e164: string;
  caller_number: string | null;
  config_did_route_id: string | null;
  config_did_route_rev: number | null;
  config_profile_id: string | null;
  config_profile_rev: number | null;
  config_tenant_rev: number | null;
  room_name: string | null;
  agent_participant_sid: string | null;
  destination_type: string | null;
  destination_id: string | null;
  disposition: string;
  state: string;
  version: number;
  created_at: Date | string;
  ended_at: Date | string | null;
}

function toSession(row: CallSessionRow): CallSessionRecord {
  return {
    id: row.id,
    asteriskLinkedId: row.asterisk_linked_id,
    officePulseInstanceId: row.officepulse_instance_id,
    tenantId: row.tenant_id,
    didE164: row.did_e164,
    callerNumber: row.caller_number ?? undefined,
    config: {
      didRouteId: row.config_did_route_id ?? undefined,
      didRouteRevision: row.config_did_route_rev ?? undefined,
      profileId: row.config_profile_id ?? undefined,
      profileRevision: row.config_profile_rev ?? undefined,
      tenantRevision: row.config_tenant_rev ?? undefined,
    },
    roomName: row.room_name ?? undefined,
    agentParticipantSid: row.agent_participant_sid ?? undefined,
    destinationType: (row.destination_type as DestinationType | null) ?? undefined,
    destinationId: row.destination_id ?? undefined,
    disposition: row.disposition as Disposition,
    state: row.state,
    version: row.version,
    createdAt: iso(row.created_at),
    endedAt: row.ended_at ? iso(row.ended_at) : undefined,
  };
}

/**
 * MySQL implementation of the runtime store. Prepared statements only; the
 * connecting account needs rights on `aida_officepulse` alone (see
 * deploy/sql/grants.sql).
 */
export class MysqlRuntimeStore implements RuntimeStore {
  private readonly pool: mysql.Pool;

  constructor(config: RuntimeMysqlConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit ?? 5,
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

  async createCallSession(session: NewCallSession): Promise<{ session: CallSessionRecord; created: boolean }> {
    try {
      await this.pool.execute(
        `INSERT INTO call_session (id, asterisk_linked_id, officepulse_instance_id, tenant_id, did_e164,
           caller_number, config_did_route_id, config_did_route_rev, config_profile_id, config_profile_rev,
           config_tenant_rev, room_name, destination_type, destination_id, disposition, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.asteriskLinkedId,
          session.officePulseInstanceId,
          session.tenantId,
          session.didE164,
          session.callerNumber ?? null,
          session.config.didRouteId ?? null,
          session.config.didRouteRevision ?? null,
          session.config.profileId ?? null,
          session.config.profileRevision ?? null,
          session.config.tenantRevision ?? null,
          session.roomName ?? null,
          session.destinationType ?? null,
          session.destinationId ?? null,
          session.disposition,
          session.state,
        ],
      );
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      // A retried FastAGI leg for the same call: return the original.
      const existing = await this.getCallSessionByLinkedId(session.asteriskLinkedId);
      if (existing) return { session: existing, created: false };
      throw err;
    }
    const created = await this.getCallSession(session.id);
    if (!created) throw new Error(`call session ${session.id} vanished immediately after insert`);
    return { session: created, created: true };
  }

  async getCallSession(callSessionId: string): Promise<CallSessionRecord | undefined> {
    const [rows] = await this.pool.execute('SELECT * FROM call_session WHERE id = ?', [callSessionId]);
    const row = (rows as CallSessionRow[])[0];
    return row ? toSession(row) : undefined;
  }

  async getCallSessionByLinkedId(linkedId: string): Promise<CallSessionRecord | undefined> {
    const [rows] = await this.pool.execute('SELECT * FROM call_session WHERE asterisk_linked_id = ?', [linkedId]);
    const row = (rows as CallSessionRow[])[0];
    return row ? toSession(row) : undefined;
  }

  async updateCallSession(
    callSessionId: string,
    fields: Partial<Pick<CallSessionRecord, 'roomName' | 'agentParticipantSid' | 'state' | 'disposition' | 'endedAt'>>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      roomName: 'room_name',
      agentParticipantSid: 'agent_participant_sid',
      state: 'state',
      disposition: 'disposition',
      endedAt: 'ended_at',
    };
    const sets: string[] = [];
    const params: Array<string | null> = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (fields as Record<string, string | undefined>)[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (sets.length === 0) return;
    sets.push('version = version + 1');
    params.push(callSessionId);
    await this.pool.execute(`UPDATE call_session SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async appendCallEvent(
    callSessionId: string,
    event: { eventType: string; payload?: Record<string, unknown> },
  ): Promise<CallEventRecord> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT COALESCE(MAX(sequence_number), 0) AS seq FROM call_event WHERE call_session_id = ? FOR UPDATE',
        [callSessionId],
      );
      const sequenceNumber = Number((rows as Array<{ seq: number }>)[0]?.seq ?? 0) + 1;
      await conn.execute(
        'INSERT INTO call_event (id, call_session_id, sequence_number, event_type, payload) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), callSessionId, sequenceNumber, event.eventType, event.payload ? JSON.stringify(event.payload) : null],
      );
      await conn.commit();
      return {
        eventType: event.eventType,
        payload: event.payload,
        sequenceNumber,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async listCallEvents(callSessionId: string): Promise<CallEventRecord[]> {
    const [rows] = await this.pool.execute(
      'SELECT sequence_number, event_type, payload, created_at FROM call_event WHERE call_session_id = ? ORDER BY sequence_number',
      [callSessionId],
    );
    return (rows as Array<{ sequence_number: number; event_type: string; payload: unknown; created_at: Date }>).map(
      (row) => ({
        sequenceNumber: row.sequence_number,
        eventType: row.event_type,
        payload: asRecord(row.payload),
        createdAt: iso(row.created_at),
      }),
    );
  }

  async claimControlCommand(
    command: ControlCommandRecord,
  ): Promise<{ claimed: boolean; existing?: ControlCommandRecord }> {
    try {
      await this.pool.execute(
        `INSERT INTO control_command (id, call_session_id, idempotency_key, command_type, payload, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          command.callSessionId,
          command.idempotencyKey,
          command.commandType,
          command.payload ? JSON.stringify(command.payload) : null,
          command.status,
        ],
      );
      return { claimed: true };
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const [rows] = await this.pool.execute(
        'SELECT call_session_id, idempotency_key, command_type, payload, status, result FROM control_command WHERE call_session_id = ? AND idempotency_key = ?',
        [command.callSessionId, command.idempotencyKey],
      );
      const row = (rows as Array<{
        call_session_id: string;
        idempotency_key: string;
        command_type: string;
        payload: unknown;
        status: string;
        result: unknown;
      }>)[0];
      if (!row) throw err;
      return {
        claimed: false,
        existing: {
          callSessionId: row.call_session_id,
          idempotencyKey: row.idempotency_key,
          commandType: row.command_type,
          payload: asRecord(row.payload),
          status: row.status,
          result: asRecord(row.result),
        },
      };
    }
  }

  async completeControlCommand(
    callSessionId: string,
    idempotencyKey: string,
    status: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.execute(
      'UPDATE control_command SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP(3) WHERE call_session_id = ? AND idempotency_key = ?',
      [status, result ? JSON.stringify(result) : null, callSessionId, idempotencyKey],
    );
  }

  async upsertParticipant(
    callSessionId: string,
    participant: { participantSid: string; identity?: string; kind: string },
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO livekit_participant (call_session_id, participant_sid, identity, kind)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE identity = VALUES(identity), kind = VALUES(kind), left_at = NULL`,
      [callSessionId, participant.participantSid, participant.identity ?? null, participant.kind],
    );
  }

  async markParticipantLeft(callSessionId: string, participantSid: string): Promise<void> {
    await this.pool.execute(
      'UPDATE livekit_participant SET left_at = CURRENT_TIMESTAMP(3) WHERE call_session_id = ? AND participant_sid = ?',
      [callSessionId, participantSid],
    );
  }

  async recordWebhookDelivery(
    source: string,
    deliveryId: string,
    eventType: string,
    callSessionId?: string,
  ): Promise<boolean> {
    try {
      await this.pool.execute(
        'INSERT INTO webhook_delivery (delivery_id, source, event_type, call_session_id) VALUES (?, ?, ?, ?)',
        [deliveryId, source, eventType, callSessionId ?? null],
      );
      return true;
    } catch (err) {
      if (isDuplicate(err)) return false;
      throw err;
    }
  }

  async upsertDidFallback(record: DidFallbackRecord): Promise<void> {
    await this.pool.execute(
      `INSERT INTO did_fallback (did_route_id, tenant_id, did_e164, destination_type, destination_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), did_e164 = VALUES(did_e164),
         destination_type = VALUES(destination_type), destination_id = VALUES(destination_id),
         enabled = VALUES(enabled)`,
      [
        record.didRouteId,
        record.tenantId,
        record.didE164,
        record.destinationType,
        record.destinationId,
        record.enabled ? 1 : 0,
      ],
    );
  }

  async getDidFallbackByDid(didE164: string): Promise<DidFallbackRecord | undefined> {
    const [rows] = await this.pool.execute('SELECT * FROM did_fallback WHERE did_e164 = ?', [didE164]);
    return this.toFallback(rows);
  }

  async getDidFallbackByRouteId(didRouteId: string): Promise<DidFallbackRecord | undefined> {
    const [rows] = await this.pool.execute('SELECT * FROM did_fallback WHERE did_route_id = ?', [didRouteId]);
    return this.toFallback(rows);
  }

  private toFallback(rows: unknown): DidFallbackRecord | undefined {
    const row = (rows as Array<{
      did_route_id: string;
      tenant_id: string;
      did_e164: string;
      destination_type: string;
      destination_id: string;
      enabled: number;
    }>)[0];
    if (!row) return undefined;
    return {
      didRouteId: row.did_route_id,
      tenantId: row.tenant_id,
      didE164: row.did_e164,
      destinationType: row.destination_type as DestinationType,
      destinationId: row.destination_id,
      enabled: row.enabled === 1,
    };
  }

  async recordProvisioningOperation(record: ProvisioningOperationRecord): Promise<void> {
    await this.pool.execute(
      'INSERT INTO provisioning_operation (request_id, kind, external_id, action, status) VALUES (?, ?, ?, ?, ?)',
      [record.requestId, record.kind, record.externalId, record.action, record.status],
    );
  }

  async getProvisioningOperation(requestId: string): Promise<ProvisioningOperationRecord | undefined> {
    const [rows] = await this.pool.execute(
      'SELECT request_id, kind, external_id, action, status FROM provisioning_operation WHERE request_id = ?',
      [requestId],
    );
    const row = (rows as Array<{
      request_id: string;
      kind: string;
      external_id: string;
      action: string;
      status: string;
    }>)[0];
    if (!row) return undefined;
    return {
      requestId: row.request_id,
      kind: row.kind,
      externalId: row.external_id,
      action: row.action,
      status: row.status,
    };
  }

  async setDependencyStatus(name: string, ready: boolean, detail?: string): Promise<void> {
    await this.pool.execute(
      `INSERT INTO dependency_status (name, ready, detail) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ready = VALUES(ready), detail = VALUES(detail)`,
      [name, ready ? 1 : 0, detail ?? null],
    );
  }
}
