// Observed historical destination labels are diagnostic data, never new routing intent.
export type DestinationType = string;

/**
 * The `aidacalls_db` runtime database this service exclusively writes
 * (issue #9). Deliberately has no transcript surface.
 */

export type Disposition = 'SCREEN' | 'FALLBACK' | 'REJECT';

export interface PinnedConfig {
  didRouteId?: string;
  didRouteRevision?: number;
  profileId?: string;
  profileRevision?: number;
  tenantRevision?: number;
}

export interface CallSessionRecord {
  id: string;
  asteriskLinkedId: string;
  officePulseInstanceId: string;
  tenantId: string;
  didE164: string;
  callerNumber?: string;
  config: PinnedConfig;
  roomName?: string;
  agentParticipantSid?: string;
  destinationType?: DestinationType;
  destinationId?: string;
  disposition: Disposition;
  state: string;
  version: number;
  createdAt: string;
  endedAt?: string;
}

export interface NewCallSession {
  id: string;
  asteriskLinkedId: string;
  officePulseInstanceId: string;
  tenantId: string;
  didE164: string;
  callerNumber?: string;
  config: PinnedConfig;
  roomName?: string;
  destinationType?: DestinationType;
  destinationId?: string;
  disposition: Disposition;
  state: string;
}

export interface CallEventRecord {
  eventType: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  sequenceNumber: number;
}

export interface ControlCommandRecord {
  callSessionId: string;
  idempotencyKey: string;
  commandType: string;
  payload?: Record<string, unknown>;
  status: string;
  result?: Record<string, unknown>;
}


/** Validated LiveKit delivery; receipts and all projections commit together. */
export interface LiveKitWebhookUpdate {
  deliveryId: string;
  eventType: string;
  callSessionId: string;
  roomName: string;
  participant?: { sid: string; identity?: string; kind: string; isAgent: boolean };
}
export type LiveKitWebhookResult = 'applied' | 'duplicate' | 'unknown-room';

export interface RuntimeStore {
  /**
   * Insert a call session, or return the existing one when this Asterisk
   * linkedid already has a session — a retried FastAGI leg must never
   * create a second session or a second LiveKit room.
   */
  createCallSession(session: NewCallSession): Promise<{ session: CallSessionRecord; created: boolean }>;
  getCallSession(callSessionId: string): Promise<CallSessionRecord | undefined>;
  getCallSessionByLinkedId(linkedId: string): Promise<CallSessionRecord | undefined>;
  updateCallSession(
    callSessionId: string,
    fields: Partial<Pick<CallSessionRecord, 'roomName' | 'agentParticipantSid' | 'state' | 'disposition' | 'endedAt'>>,
  ): Promise<void>;

  /** Appends with a per-session sequence number; returns the stored event. */
  appendCallEvent(
    callSessionId: string,
    event: { eventType: string; payload?: Record<string, unknown> },
  ): Promise<CallEventRecord>;
  listCallEvents(callSessionId: string): Promise<CallEventRecord[]>;
  /** Durable lifecycle projection and receipt in one transaction (production store). */
  applyCallEvent?(callSessionId: string, event: {
    eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown>;
  }, state?: string): Promise<void>;

  /**
   * Claim a command by (session, idempotency key). `claimed: false` means
   * this is a duplicate and the recorded outcome is returned instead.
   */
  claimControlCommand(
    command: ControlCommandRecord,
    expectedVersion?: number,
  ): Promise<{ claimed: boolean; existing?: ControlCommandRecord }>;
  completeControlCommand(
    callSessionId: string,
    idempotencyKey: string,
    status: string,
    result?: Record<string, unknown>,
  ): Promise<void>;

  /** Required by the LiveKit handler; optional only for stores unused by that surface. */
  applyLiveKitWebhook?(delivery: LiveKitWebhookUpdate): Promise<LiveKitWebhookResult>;

  /** Records a participant; a repeated SID updates rather than duplicates. */
  upsertParticipant(
    callSessionId: string,
    participant: { participantSid: string; identity?: string; kind: string },
  ): Promise<void>;
  markParticipantLeft(callSessionId: string, participantSid: string): Promise<void>;

  /** `false` means this delivery id was already processed — drop it. */
  recordWebhookDelivery(
    source: string,
    deliveryId: string,
    eventType: string,
    callSessionId?: string,
  ): Promise<boolean>;


  setDependencyStatus(name: string, ready: boolean, detail?: string): Promise<void>;

  ping(): Promise<boolean>;
}
