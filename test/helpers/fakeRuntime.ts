import { randomUUID } from 'node:crypto';
import type {
  CallEventRecord,
  CallSessionRecord,
  ControlCommandRecord,
  NewCallSession,
  RuntimeStore,
} from '../../src/runtime/store.js';

/**
 * In-memory RuntimeStore with the same uniqueness semantics as the MySQL
 * schema: one session per linkedid, one command per idempotency key, one
 * webhook per delivery id. Set `failOn` to force a named method to throw.
 */
export class FakeRuntimeStore implements RuntimeStore {
  sessions = new Map<string, CallSessionRecord>();
  events = new Map<string, CallEventRecord[]>();
  commands = new Map<string, ControlCommandRecord>();
  participants = new Map<string, Map<string, { identity?: string; kind: string; left: boolean }>>();
  deliveries = new Set<string>();
  dependencies = new Map<string, { ready: boolean; detail?: string }>();
  failOn: string | null = null;
  pingResult = true;

  private guard(name: string): void {
    if (this.failOn === name) throw new Error(`forced failure in ${name}`);
  }

  async createCallSession(session: NewCallSession): Promise<{ session: CallSessionRecord; created: boolean }> {
    this.guard('createCallSession');
    for (const existing of this.sessions.values()) {
      if (existing.asteriskLinkedId === session.asteriskLinkedId) return { session: existing, created: false };
    }
    const record: CallSessionRecord = {
      ...session,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(record.id, record);
    return { session: record, created: true };
  }

  async getCallSession(callSessionId: string): Promise<CallSessionRecord | undefined> {
    this.guard('getCallSession');
    return this.sessions.get(callSessionId);
  }

  async getCallSessionByLinkedId(linkedId: string): Promise<CallSessionRecord | undefined> {
    this.guard('getCallSessionByLinkedId');
    for (const session of this.sessions.values()) {
      if (session.asteriskLinkedId === linkedId) return session;
    }
    return undefined;
  }

  async updateCallSession(
    callSessionId: string,
    fields: Partial<Pick<CallSessionRecord, 'roomName' | 'agentParticipantSid' | 'state' | 'disposition' | 'endedAt'>>,
  ): Promise<void> {
    this.guard('updateCallSession');
    const session = this.sessions.get(callSessionId);
    if (session) Object.assign(session, fields, { version: session.version + 1 });
  }

  async appendCallEvent(
    callSessionId: string,
    event: { eventType: string; payload?: Record<string, unknown> },
  ): Promise<CallEventRecord> {
    this.guard('appendCallEvent');
    const list = this.events.get(callSessionId) ?? [];
    const record: CallEventRecord = {
      eventType: event.eventType,
      payload: event.payload,
      sequenceNumber: list.length + 1,
      createdAt: new Date().toISOString(),
    };
    list.push(record);
    this.events.set(callSessionId, list);
    return record;
  }

  async listCallEvents(callSessionId: string): Promise<CallEventRecord[]> {
    return this.events.get(callSessionId) ?? [];
  }

  async claimControlCommand(
    command: ControlCommandRecord,
  ): Promise<{ claimed: boolean; existing?: ControlCommandRecord }> {
    this.guard('claimControlCommand');
    const key = `${command.callSessionId}|${command.idempotencyKey}`;
    const existing = this.commands.get(key);
    if (existing) return { claimed: false, existing };
    this.commands.set(key, { ...command });
    return { claimed: true };
  }

  async completeControlCommand(
    callSessionId: string,
    idempotencyKey: string,
    status: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const command = this.commands.get(`${callSessionId}|${idempotencyKey}`);
    if (command) {
      command.status = status;
      command.result = result;
    }
  }

  async upsertParticipant(
    callSessionId: string,
    participant: { participantSid: string; identity?: string; kind: string },
  ): Promise<void> {
    const map = this.participants.get(callSessionId) ?? new Map();
    map.set(participant.participantSid, { identity: participant.identity, kind: participant.kind, left: false });
    this.participants.set(callSessionId, map);
  }

  async markParticipantLeft(callSessionId: string, participantSid: string): Promise<void> {
    const entry = this.participants.get(callSessionId)?.get(participantSid);
    if (entry) entry.left = true;
  }

  async recordWebhookDelivery(source: string, deliveryId: string): Promise<boolean> {
    const key = `${source}|${deliveryId}`;
    if (this.deliveries.has(key)) return false;
    this.deliveries.add(key);
    return true;
  }

  async setDependencyStatus(name: string, ready: boolean, detail?: string): Promise<void> {
    this.dependencies.set(name, { ready, detail });
  }

  async ping(): Promise<boolean> {
    return this.pingResult;
  }

  /** Convenience for tests that assert on the recorded event sequence. */
  eventTypes(callSessionId: string): string[] {
    return (this.events.get(callSessionId) ?? []).map((e) => e.eventType);
  }

  /** Seeds a session directly, bypassing the orchestrator. */
  seedSession(overrides: Partial<CallSessionRecord> = {}): CallSessionRecord {
    const session: CallSessionRecord = {
      id: overrides.id ?? randomUUID(),
      asteriskLinkedId: overrides.asteriskLinkedId ?? 'linked-1',
      officePulseInstanceId: 'op-test',
      tenantId: overrides.tenantId ?? 'tenant-1',
      didE164: overrides.didE164 ?? '+15559870001',
      config: overrides.config ?? {},
      disposition: overrides.disposition ?? 'SCREEN',
      state: overrides.state ?? 'screening',
      version: 1,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    this.sessions.set(session.id, session);
    return session;
  }
}
