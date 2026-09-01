import { createHash, createHmac } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import { UpstreamError } from '../errors.js';

/**
 * Pusher call-arrival notification (issue #9). NOTIFICATION ONLY: the
 * payload carries identifiers and a timestamp so AidaHandset knows to fetch
 * the call — never call content, caller identity, or any credential.
 *
 * Notification failure never affects call handling; the caller is already
 * being served by the time this is published.
 */

export interface CallAlert {
  eventId: string;
  callSessionId: string;
  occurredAt: string;
}

export interface Notifier {
  publishCallStarted(deviceId: string, alert: CallAlert): Promise<boolean>;
  ping(): Promise<boolean>;
}

export interface PusherOptions {
  appId: string;
  key: string;
  secret: string;
  cluster: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/** Per-device private channel; no tenant id or extension number in the name. */
export function deviceChannel(deviceId: string): string {
  return `private-aida-device-${deviceId}`;
}

export class PusherNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PusherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async publishCallStarted(deviceId: string, alert: CallAlert): Promise<boolean> {
    const body = JSON.stringify({
      name: 'aida.call.started',
      channel: deviceChannel(deviceId),
      data: JSON.stringify(alert),
    });
    try {
      await this.request('POST', `/apps/${this.opts.appId}/events`, body);
      return true;
    } catch (err) {
      this.opts.logger.warn('call arrival notification failed', { callSessionId: alert.callSessionId, err });
      return false;
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<void> {
    const params = new URLSearchParams({
      auth_key: this.opts.key,
      auth_timestamp: String(Math.floor(Date.now() / 1000)),
      auth_version: '1.0',
      // body_md5 is part of the signature only when a body is sent.
      ...(body !== undefined ? { body_md5: createHash('md5').update(body).digest('hex') } : {}),
    });
    // Pusher signs "METHOD\npath\nsorted-query" with the app secret.
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const query = new URLSearchParams(sorted).toString();
    const signature = createHmac('sha256', this.opts.secret).update(`${method}\n${path}\n${query}`).digest('hex');
    const url = `https://api-${this.opts.cluster}.pusher.com${path}?${query}&auth_signature=${signature}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new UpstreamError(`Pusher ${path} returned ${res.status}`, 'pusher');
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`Pusher ${path} timed out after ${this.opts.timeoutMs}ms`, 'pusher');
      }
      throw new UpstreamError(`Pusher ${path} unreachable: ${(err as Error).message}`, 'pusher');
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<boolean> {
    try {
      // Channel listing is the cheapest authenticated read.
      await this.request('GET', `/apps/${this.opts.appId}/channels`);
      return true;
    } catch {
      return false;
    }
  }
}
