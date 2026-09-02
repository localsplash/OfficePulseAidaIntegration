import type { Logger } from '../logging/logger.js';
import type { RuntimeStore } from '../runtime/store.js';
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

interface LiveKitWebhookEvent {
  id?: string;
  event?: string;
  room?: { name?: string; sid?: string };
  participant?: { sid?: string; identity?: string; kind?: string };
}

/**
 * Receives LiveKit Cloud webhooks (issue #9).
 *
 * Two independent guards: the signature must verify against the raw body,
 * and the delivery id must be unseen. LiveKit retries deliveries, so a
 * duplicate is expected traffic — it is acknowledged with 200 and dropped,
 * never processed twice.
 *
 * The room name carries the call session id; participant SIDs are recorded
 * so the current agent participant is always known. Transcripts travel
 * over LiveKit Data and are never persisted here.
 */
export class LiveKitWebhookHandler {
  constructor(private readonly opts: LiveKitWebhookHandlerOptions) {}

  async handle(rawBody: Buffer, authorization: string | undefined): Promise<WebhookOutcome> {
    const verification = verifyWebhook(rawBody, authorization, this.opts.apiKey, this.opts.apiSecret);
    if (!verification.valid) {
      this.opts.logger.warn('livekit webhook rejected', { reason: verification.reason });
      return { accepted: false, reason: verification.reason };
    }

    let event: LiveKitWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as LiveKitWebhookEvent;
    } catch {
      return { accepted: false, reason: 'unparseable body' };
    }

    const eventType = event.event ?? 'unknown';
    const deliveryId = event.id ?? `${eventType}:${event.room?.sid ?? ''}:${event.participant?.sid ?? ''}`;
    const callSessionId = callSessionIdFromRoom(event.room?.name);

    const fresh = await this.opts.runtime.recordWebhookDelivery('livekit', deliveryId, eventType, callSessionId);
    if (!fresh) return { accepted: true, duplicate: true, event: eventType };

    if (!callSessionId) {
      // A room we did not create; acknowledge without inventing state.
      this.opts.logger.info('livekit webhook for unknown room ignored', { eventType });
      return { accepted: true, event: eventType };
    }

    try {
      await this.apply(callSessionId, eventType, event);
    } catch (err) {
      this.opts.logger.warn('livekit webhook processing failed', { callSessionId, eventType, err });
    }
    return { accepted: true, event: eventType };
  }

  private async apply(callSessionId: string, eventType: string, event: LiveKitWebhookEvent): Promise<void> {
    const participant = event.participant;
    switch (eventType) {
      case 'participant_joined':
        if (participant?.sid) {
          await this.opts.runtime.upsertParticipant(callSessionId, {
            participantSid: participant.sid,
            identity: participant.identity,
            kind: participant.kind ?? 'standard',
          });
          // The agent's participant SID is the handle for later data sends.
          if (isAgent(participant)) {
            await this.opts.runtime.updateCallSession(callSessionId, { agentParticipantSid: participant.sid });
          }
        }
        break;
      case 'participant_left':
        if (participant?.sid) await this.opts.runtime.markParticipantLeft(callSessionId, participant.sid);
        break;
      case 'room_finished':
        await this.opts.runtime.updateCallSession(callSessionId, {
          state: 'room-finished',
          endedAt: new Date().toISOString(),
        });
        break;
      default:
        break;
    }
    await this.opts.runtime.appendCallEvent(callSessionId, {
      eventType: `livekit.${eventType}`,
      payload: {
        participantSid: participant?.sid,
        identity: participant?.identity,
      },
    });
  }
}

function isAgent(participant: { identity?: string; kind?: string }): boolean {
  return participant.kind?.toUpperCase() === 'AGENT' || (participant.identity ?? '').startsWith('agent-');
}

/** Rooms are named `aida-<callSessionId>` by the orchestrator. */
export function callSessionIdFromRoom(roomName: string | undefined): string | undefined {
  if (!roomName || !roomName.startsWith('aida-')) return undefined;
  const id = roomName.slice('aida-'.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}
