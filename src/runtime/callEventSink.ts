import type { CallEventSink } from '../takeover/takeoverManager.js';
import type { RuntimeStore } from './store.js';
import type { Logger } from '../logging/logger.js';
import type { LiveKitApi } from '../livekit/client.js';
import { queueChannel, type Notifier } from '../notify/pusher.js';
import { eventStates, handsetState } from './callState.js';

/** Persist first. Optional notification failures must never affect telephone control. */
export class RuntimeCallEventSink implements CallEventSink {
  constructor(private readonly runtime: RuntimeStore, private readonly logger: Logger,
    private readonly livekit?: LiveKitApi, private readonly notifier?: Notifier) {}

  async postCallEvent(callSessionId: string,
    event: { eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown> }): Promise<boolean> {
    let changed = false;
    const state = eventStates[event.eventType];
    try {
      if (this.runtime.applyCallEvent) changed = (await this.runtime.applyCallEvent(callSessionId, event, state)).stateChanged;
      else {
        const before = await this.runtime.getCallSession(callSessionId);
        changed = !!state && !before?.endedAt && handsetState(before?.state ?? '') !== state;
        await this.runtime.appendCallEvent(callSessionId, { eventType: event.eventType, payload: event.payload });
        if (changed) await this.runtime.updateCallSession(callSessionId, { state, ...(state === 'ended' ? { endedAt: event.occurredAt } : {}) });
      }
    } catch (err) {
      this.logger.warn('call event persistence failed', { callSessionId, eventType: event.eventType, err }); return false;
    }
    if (changed && this.notifier) {
      // Even database reads/channel validation for optional alerts stay off the call path.
      void Promise.resolve().then(async () => {
        const call = await this.runtime.getCallSession(callSessionId);
        if (call?.destinationType === 'QUEUE' && call.pbxContext && call.destinationId) {
          await this.notifier!.publishCallState(queueChannel(call.officePulseInstanceId, call.pbxContext, call.destinationId), {
            v: 1, eventId: event.idempotencyKey, callSessionId, state: state!, occurredAt: event.occurredAt,
          });
        }
      }).catch(() => this.logger.warn('call notification failed', { callSessionId }));
    }
    if (this.livekit && ['bridged', 'takeover-failed'].includes(event.eventType)) {
      try {
        const call = await this.runtime.getCallSession(callSessionId);
        if (call?.roomName) await this.livekit.publishData(call.roomName, 'aida.control', {
          type: 'control', callId: callSessionId, commandId: event.idempotencyKey,
          action: event.eventType === 'bridged' ? 'human_answered' : 'transfer_failed', deadlineMs: Date.now() + 10_000,
        });
      } catch { this.logger.warn('agent control delivery failed', { callSessionId, eventType: event.eventType }); }
    }
    return true;
  }
}
