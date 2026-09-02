import type { CallEventSink } from '../takeover/takeoverManager.js';
import type { RuntimeStore } from './store.js';
import type { Logger } from '../logging/logger.js';

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
  ) {}

  async postCallEvent(
    callSessionId: string,
    event: { eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<boolean> {
    try {
      await this.runtime.appendCallEvent(callSessionId, {
        eventType: event.eventType,
        payload: event.payload,
      });
      return true;
    } catch (err) {
      this.logger.warn('call event persistence failed', { callSessionId, eventType: event.eventType, err });
      return false;
    }
  }
}
