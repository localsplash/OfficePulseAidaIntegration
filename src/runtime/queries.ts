import type { CallEventRecord, CallSessionRecord } from './store.js';

/**
 * Read-only views of `aidacalls_db` for AidaAdmin's calls, dependencies and
 * issues screens. AidaAdmin reads them over the private API instead of with
 * its own database login, so this service stays the only one that touches
 * its schema.
 */

/** Calls without an end older than this are presumed lost, not live. */
export const ORPHAN_HORIZON_HOURS = 6;

/**
 * `active` has not ended and is younger than the orphan horizon; `orphaned`
 * has not ended but is older than it; `recent` has ended, newest end first.
 */
export const CALL_LIST_STATES = ['active', 'recent', 'orphaned', 'all'] as const;
export type CallListState = (typeof CALL_LIST_STATES)[number];

export interface CallListFilter {
  state: CallListState;
  /** Omitted only when every tenant is wanted. */
  tenantId?: string;
  limit?: number;
}

export interface ControlCommandView {
  idempotencyKey: string;
  commandType: string;
  payload?: Record<string, unknown>;
  status: string;
  result?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

export interface ParticipantView {
  participantSid: string;
  identity?: string;
  kind: string;
  joinedAt: string;
  leftAt?: string;
}

export interface WebhookDeliveryView {
  source: string;
  deliveryId: string;
  eventType: string;
  callSessionId?: string;
  receivedAt: string;
}

export interface DependencyStatusView {
  name: string;
  ready: boolean;
  detail?: string;
  changedAt: string;
}

/** Which call a cross-call issue row belongs to. */
export interface IssueOwner { callSessionId: string; tenantId: string }

export interface RuntimeQueries {
  listCallSessions(filter: CallListFilter): Promise<CallSessionRecord[]>;
  listControlCommands(callSessionId: string): Promise<ControlCommandView[]>;
  listParticipants(callSessionId: string): Promise<ParticipantView[]>;
  listWebhookDeliveries(limit?: number): Promise<WebhookDeliveryView[]>;
  listDependencyStatus(): Promise<DependencyStatusView[]>;
  /** Failed control commands across calls, newest first. */
  listFailedCommands(sinceHours: number, tenantId?: string): Promise<Array<ControlCommandView & IssueOwner>>;
  /** Events of the given types across calls, newest first. */
  listEventsOfType(eventTypes: string[], sinceHours: number, tenantId?: string): Promise<Array<CallEventRecord & IssueOwner>>;
}

/** A whole-number bound that is safe to inline into SQL. */
export function clampInt(value: number | undefined, fallback: number, max: number): number {
  const n = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, 1), max);
}

export const CALL_LIST_LIMIT = { fallback: 50, max: 500 };
export const WEBHOOK_LIST_LIMIT = { fallback: 100, max: 500 };
export const ISSUE_HOURS = { fallback: 24, max: 720 };
/** Cross-call issue lists are capped; the screens show the newest. */
export const ISSUE_ROW_LIMIT = 200;
