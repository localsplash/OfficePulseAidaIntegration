import { createHash } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import type { RuntimeStore, LiveKitWebhookUpdate } from '../runtime/store.js';
import { verifyWebhook } from './token.js';

export interface WebhookOutcome {
  accepted: boolean;
  reason?: string;
  duplicate?: boolean;
  event?: string;
}

export interface LiveKitWebhookHandlerOptions {
  apiKey: string;
  apiSecret: string;
  runtime: RuntimeStore;
  logger: Logger;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Verify the signed raw body before storage; acknowledge only committed effects. */
export class LiveKitWebhookHandler {
  constructor(private readonly opts: LiveKitWebhookHandlerOptions) {}

  async handle(rawBody: Buffer, authorization: string | undefined): Promise<WebhookOutcome> {
    const verification = verifyWebhook(rawBody, authorization, this.opts.apiKey, this.opts.apiSecret);
    if (!verification.valid) {
      this.opts.logger.warn('livekit webhook rejected', { reason: verification.reason });
      return { accepted: false, reason: verification.reason };
    }

    let event: Record<string, unknown> | undefined;
    try { event = object(JSON.parse(rawBody.toString('utf8'))); }
    catch { return { accepted: false, reason: 'unparseable body' }; }
    if (!event) return { accepted: false, reason: 'body must be an event object' };
    const eventType = text(event.event);
    const deliveryId = text(event.id) ?? createHash('sha256').update(rawBody).digest('hex');
    if (!eventType || eventType.length > 52 || deliveryId.length > 120) {
      return { accepted: false, reason: 'invalid event type or delivery id' };
    }
    const roomName = text(object(event.room)?.name);
    const callSessionId = callSessionIdFromRoom(roomName);
    if (!callSessionId || !roomName) {
      this.opts.logger.info('livekit webhook for unknown room ignored', { eventType });
      return { accepted: true, event: eventType };
    }

    const rawParticipant = object(event.participant);
    const sid = text(rawParticipant?.sid);
    const identity = text(rawParticipant?.identity);
    const kind = text(rawParticipant?.kind) ?? 'standard';
    if ((sid?.length ?? 0) > 80 || (identity?.length ?? 0) > 120 || kind.length > 20) {
      return { accepted: false, reason: 'invalid participant fields' };
    }
    const delivery: LiveKitWebhookUpdate = {
      deliveryId, eventType, callSessionId, roomName,
      ...(sid ? { participant: { sid, identity, kind,
        isAgent: kind.toUpperCase() === 'AGENT' || (identity ?? '').startsWith('agent-') } } : {}),
    };
    if (!this.opts.runtime.applyLiveKitWebhook) {
      throw new Error('Runtime store must support atomic LiveKit webhook processing');
    }
    // A storage/effect failure propagates to HTTP 5xx so LiveKit retries. No
    // receipt commits independently and no failure is converted to success.
    const result = await this.opts.runtime.applyLiveKitWebhook(delivery);
    if (result === 'unknown-room') this.opts.logger.info('livekit webhook for unknown room ignored', { eventType });
    return { accepted: true, event: eventType, ...(result === 'duplicate' ? { duplicate: true } : {}) };
  }
}

/** Rooms are named `aida-<callSessionId>` by the orchestrator. */
export function callSessionIdFromRoom(roomName: string | undefined): string | undefined {
  if (!roomName?.startsWith('aida-')) return undefined;
  const id = roomName.slice('aida-'.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}
