import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import { UpstreamError } from '../errors.js';

export type BootstrapDisposition = 'SCREEN' | 'FALLBACK' | 'REJECT';

export interface BootstrapCallParams {
  officePulseInstanceId: string;
  asteriskLinkedId: string;
  callerNumber?: string;
  didE164: string;
}

export interface BootstrapCallResult {
  disposition: BootstrapDisposition;
  callSessionId?: string;
  roomName?: string;
  sipDestination?: string;
  routeToken?: string;
  destinationType?: 'EXTENSION' | 'RING_GROUP';
  destinationId?: string;
}

export interface CallEvent {
  eventType: string;
  occurredAt: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

export type FetchLike = typeof fetch;

export interface AidaControlClientOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: FetchLike;
}

const DISPOSITIONS: ReadonlySet<string> = new Set(['SCREEN', 'FALLBACK', 'REJECT']);

/**
 * Client for AidaControl's OfficePulse integration surface. Trust is
 * network-level (this host's IPv4 must be in AidaControl's
 * AIDACONTROL_TRUSTED_SERVER_CIDRS); every request carries a correlation
 * id, and mutating calls carry an idempotency key so retries are safe.
 */
export class AidaControlClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: AidaControlClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * bootstrapCall: synchronous inbound-routing decision. Deadline-bounded
   * — the caller is on the line, so we never wait longer than timeoutMs.
   * Idempotency key is the Asterisk linkedid: a retried AGI for the same
   * call must not create a second call session.
   */
  async bootstrapCall(params: BootstrapCallParams, opts?: { correlationId?: string }): Promise<BootstrapCallResult> {
    const body = await this.request('POST', '/v1/integrations/officepulse/calls/bootstrap', params, {
      idempotencyKey: params.asteriskLinkedId,
      correlationId: opts?.correlationId,
    });
    const result = body as Partial<BootstrapCallResult>;
    if (typeof result?.disposition !== 'string' || !DISPOSITIONS.has(result.disposition)) {
      throw new UpstreamError(`malformed bootstrap response: bad disposition`);
    }
    if (result.disposition === 'SCREEN') {
      for (const field of ['callSessionId', 'roomName', 'sipDestination', 'routeToken'] as const) {
        if (typeof result[field] !== 'string' || result[field] === '') {
          throw new UpstreamError(`malformed bootstrap response: SCREEN missing ${field}`);
        }
      }
    }
    return result as BootstrapCallResult;
  }

  /**
   * Report a call lifecycle event (ringing, answered, bridged, failed,
   * hangup, drained…). Best-effort with one retry: event delivery failure
   * must never affect call handling, so errors are logged, not thrown.
   */
  async postCallEvent(callSessionId: string, event: CallEvent): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.request('POST', `/v1/integrations/officepulse/calls/${encodeURIComponent(callSessionId)}/events`, event, {
          idempotencyKey: event.idempotencyKey,
        });
        return true;
      } catch (err) {
        this.opts.logger.warn('call event delivery failed', { callSessionId, eventType: event.eventType, attempt, err });
        if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
      }
    }
    return false;
  }

  /** Lightweight reachability probe for readiness reporting. */
  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await this.fetchImpl(new URL('/healthz', this.opts.baseUrl), { signal: controller.signal });
        return res.status < 500;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    meta: { idempotencyKey?: string; correlationId?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-aida-correlation-id': meta.correlationId ?? randomUUID(),
    };
    if (meta.idempotencyKey) headers['x-idempotency-key'] = meta.idempotencyKey;
    try {
      const res = await this.fetchImpl(new URL(path, this.opts.baseUrl), {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status >= 400) {
        throw new UpstreamError(`AidaControl ${method} ${path} returned ${res.status}`);
      }
      const text = await res.text();
      if (text.trim() === '') return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError(`AidaControl ${method} ${path} returned non-JSON body`);
      }
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`AidaControl ${method} ${path} timed out after ${this.opts.timeoutMs}ms`);
      }
      throw new UpstreamError(`AidaControl ${method} ${path} unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
