import type { Logger } from '../logging/logger.js';
import { UpstreamError } from '../errors.js';

/**
 * Typed adapter for the existing HTTPS provisioning server that delivers
 * Grandstream/AidaHandset settings (POC issue 6). Base URL, auth, and
 * firewall reachability are environment-owned; this service only speaks
 * the interface.
 *
 * Secret handling: the SIP secret and the one-time enrollment token flow
 * through exactly one provisioning transaction here and are never logged
 * or returned to any caller.
 */

export interface SipDeviceProvisioningRequest {
  provisioningMac: string;
  deviceId: string;
  sipUsername: string;
  sipSecret: string;
  sipServer?: string;
  displayName?: string;
  provisioningProfile?: string;
}

export interface HandsetConfigDelivery {
  provisioningMac: string;
  deviceId: string;
  aidaControlUrl: string;
  pusherKey?: string;
  pusherCluster?: string;
  enrollmentToken: string;
  enrollmentExpiresAt?: string;
}

export interface ProvisioningOutcome {
  ok: boolean;
  stage: 'sip-device' | 'handset-config';
  detail?: string;
}

export interface DeviceProvisioningService {
  upsertSipDevice(req: SipDeviceProvisioningRequest): Promise<void>;
  deliverHandsetConfig(req: HandsetConfigDelivery): Promise<void>;
  ping(): Promise<boolean>;
}

export interface HttpDeviceProvisioningOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

export class HttpDeviceProvisioningService implements DeviceProvisioningService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpDeviceProvisioningOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async upsertSipDevice(req: SipDeviceProvisioningRequest): Promise<void> {
    await this.post('/v1/devices/sip', req, { mac: req.provisioningMac, deviceId: req.deviceId, stage: 'sip-device' });
  }

  async deliverHandsetConfig(req: HandsetConfigDelivery): Promise<void> {
    await this.post('/v1/devices/handset-config', req, {
      mac: req.provisioningMac,
      deviceId: req.deviceId,
      stage: 'handset-config',
    });
  }

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

  /**
   * POST with one bounded retry on transport failure / 5xx. 4xx responses
   * never retry — the request is wrong, not the transport. Log fields
   * exclude the body: secrets exist only inside the single request.
   */
  private async post(path: string, body: unknown, logMeta: Record<string, string>): Promise<void> {
    const maxAttempts = 2;
    let lastError: UpstreamError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await this.attemptPost(path, body, logMeta.stage ?? '');
      if (outcome === 'ok') return;
      if (!outcome.retryable) throw outcome.error; // client error: the request is wrong, not the transport
      lastError = outcome.error;
      this.opts.logger.warn('provisioning server call failed', { ...logMeta, attempt, err: lastError });
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 500));
    }
    throw lastError ?? new UpstreamError(`provisioning server ${path} failed`, logMeta.stage);
  }

  private async attemptPost(
    path: string,
    body: unknown,
    stage: string,
  ): Promise<'ok' | { retryable: boolean; error: UpstreamError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.opts.authToken) headers.authorization = `Bearer ${this.opts.authToken}`;
      const res = await this.fetchImpl(new URL(path, this.opts.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) return 'ok';
      return {
        retryable: res.status >= 500,
        error: new UpstreamError(`provisioning server ${path} returned ${res.status}`, stage),
      };
    } catch (err) {
      const error =
        (err as Error).name === 'AbortError'
          ? new UpstreamError(`provisioning server ${path} timed out after ${this.opts.timeoutMs}ms`, stage)
          : new UpstreamError(`provisioning server ${path} unreachable: ${(err as Error).message}`, stage);
      return { retryable: true, error };
    } finally {
      clearTimeout(timer);
    }
  }
}
