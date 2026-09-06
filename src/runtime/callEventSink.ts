import type { CallEventSink } from '../takeover/takeoverManager.js';
import type { RuntimeStore } from './store.js';
import type { Logger } from '../logging/logger.js';
import type { LiveKitApi } from '../livekit/client.js';

/**
 * Persists takeover-manager call events into the local runtime database.
 *
 * This replaces the AidaControl HTTP event post (issue #9): events are now
 * durable locally rather than fired at a service that no longer exists.
 * Delivery failure is logged, never thrown — an unrecorded event must not
 * disturb a live call.
 */
export class RuntimeCallEventSink implements CallEventSink {
  constructor(
    private readonly runtime: RuntimeStore,
    private readonly logger: Logger,
    private readonly livekit?: LiveKitApi,
  ) {}

  async postCallEvent(
    callSessionId: string,
    event: { eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<boolean> {
    try {
      const states: Record<string, string> = {
        'screening-started': 'screening', 'aida-connected': 'screening',
        'takeover-requested': 'ringing', ringing: 'ringing', bridged: 'human-active',
        'aida-drained': 'human-active', 'takeover-failed': 'screening', hangup: 'ended',
      };
      if (this.runtime.applyCallEvent) await this.runtime.applyCallEvent(callSessionId, event, states[event.eventType]);
      else {
        await this.runtime.appendCallEvent(callSessionId, { eventType: event.eventType, payload: event.payload });
        if (states[event.eventType]) await this.runtime.updateCallSession(callSessionId, {
          state: states[event.eventType],
          ...(event.eventType === 'hangup' ? { endedAt: event.occurredAt } : {}),
        });
      }
      if (this.livekit && ['bridged', 'takeover-failed'].includes(event.eventType)) {
        const call = await this.runtime.getCallSession(callSessionId);
        if (call?.roomName) await this.livekit.publishData(call.roomName, 'aida.control', {
          type: 'control', callId: callSessionId, commandId: event.idempotencyKey,
          action: event.eventType === 'bridged' ? 'human_answered' : 'transfer_failed',
          deadlineMs: Date.now() + 10_000,
        });
      }
      return true;
    } catch (err) {
      this.logger.warn('call event persistence failed', { callSessionId, eventType: event.eventType, err });
      return false;
    }
  }
}
