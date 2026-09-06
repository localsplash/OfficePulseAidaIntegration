import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import type { NocoConfigRepository, ResolvedRoute } from '../nocodb/configRepository.js';
import type { RuntimeStore, Disposition } from '../runtime/store.js';
import type { LiveKitApi } from '../livekit/client.js';
import type { Notifier } from '../notify/pusher.js';
import type { FallbackResolver, ResolvedFallback } from './fallbackResolver.js';

/**
 * The call orchestrator: what AidaControl would have decided, decided here
 * (issue #9). One synchronous entry point, `bootstrapInboundCall`, is
 * called by FastAGI while the caller waits, so every step is bounded and
 * every failure degrades to the DID's own local destination.
 *
 * Order matters and is deliberate:
 *   1. resolve route + profile from NocoDB (the only cloud read),
 *   2. persist the call session with the configuration PINNED,
 *   3. create the LiveKit room and dispatch `aida-prime`,
 *   4. notify the handset (best effort — never blocks the caller),
 *   5. hand Asterisk the routing variables.
 *
 * A failure at 1 or 3 produces FALLBACK, not an error: the caller keeps
 * their call. Only an explicitly disabled route produces REJECT.
 */

export interface BootstrapRequest {
  officePulseInstanceId: string;
  asteriskLinkedId: string;
  callerNumber?: string;
  didE164: string;
}

export interface BootstrapDecision {
  disposition: Disposition;
  callSessionId?: string;
  roomName?: string;
  sipDestination?: string;
  fallback?: ResolvedFallback;
  /** Why a FALLBACK happened; surfaced in logs and call events, not to the caller. */
  fallbackReason?: string;
}

export interface CallOrchestratorOptions {
  config: NocoConfigRepository;
  runtime: RuntimeStore;
  livekit: LiveKitApi;
  notifier?: Notifier;
  fallbackResolver: FallbackResolver;
  logger: Logger;
  /** SIP host of the existing LiveKit trunk; room@host is dialled by ARI. */
  livekitSipHost: string;
  defaultLocale: string;
  tenantEnabled?: (id: number) => Promise<boolean>;
}

/** Room names are derived from the call session id: unique, no PII. */
export function roomNameFor(callSessionId: string): string {
  return `aida-${callSessionId}`;
}

export class CallOrchestrator {
  constructor(private readonly opts: CallOrchestratorOptions) {}

  async bootstrapInboundCall(request: BootstrapRequest): Promise<BootstrapDecision> {
    const log = this.opts.logger.child({ linkedid: request.asteriskLinkedId });

    // A retried FastAGI leg for a call we already bootstrapped must reuse
    // the original decision rather than open a second room.
    const existing = await this.safeLookupExisting(request.asteriskLinkedId);
    if (existing) {
      log.info('reusing existing call session for retried bootstrap', { callSessionId: existing.id });
      return {
        disposition: existing.disposition,
        callSessionId: existing.id,
        roomName: existing.roomName,
        sipDestination: existing.roomName ? this.sipDestination(existing.roomName) : undefined,
        fallback:
          existing.disposition === 'SCREEN' ? undefined : await this.opts.fallbackResolver.resolveForDid(request.didE164),
      };
    }

    let route: ResolvedRoute | undefined;
    try {
      route = await this.opts.config.resolveInboundRoute(request.didE164);
    } catch (err) {
      log.warn('configuration read failed; taking local fallback', { err });
      return this.fallbackDecision(request, 'nocodb-unavailable');
    }

    if (!route) {
      log.info('no enabled route for DID; taking local fallback');
      return this.fallbackDecision(request, 'no-enabled-route');
    }
    if (this.opts.tenantEnabled) {
      const id = Number(route.tenant.id);
      if (!Number.isSafeInteger(id) || id <= 0 || !(await this.opts.tenantEnabled(id))) return { disposition: 'REJECT' };
    }
    if (!route.didRoute.screeningEnabled) {
      // Screening deliberately off: go straight to the destination, which
      // is the route's own — not the emergency default.
      log.info('screening disabled for DID; routing directly to destination');
      return this.fallbackDecision(request, 'screening-disabled', route);
    }

    const callSessionId = randomUUID();
    const roomName = roomNameFor(callSessionId);

    let session;
    try {
      const result = await this.opts.runtime.createCallSession({
        id: callSessionId,
        asteriskLinkedId: request.asteriskLinkedId,
        officePulseInstanceId: request.officePulseInstanceId,
        tenantId: route.tenant.id,
        didE164: request.didE164,
        callerNumber: request.callerNumber,
        // Pin exactly what this call used, so behaviour stays explainable
        // even after an administrator edits the configuration mid-call.
        config: {
          didRouteId: route.didRoute.id,
          didRouteRevision: route.didRoute.revision,
          profileId: route.profile.id,
          profileRevision: route.profile.revision,
          tenantRevision: route.tenant.revision,
        },
        roomName,
        destinationType: route.didRoute.destinationType,
        destinationId: route.didRoute.destinationId,
        disposition: 'SCREEN',
        state: 'bootstrapping',
      });
      session = result.session;
      if (!result.created) {
        // Another leg won the race; reuse its room rather than dispatching twice.
        log.info('call session already existed; reusing', { callSessionId: session.id });
        return {
          disposition: session.disposition,
          callSessionId: session.id,
          roomName: session.roomName,
          sipDestination: session.roomName ? this.sipDestination(session.roomName) : undefined,
        };
      }
    } catch (err) {
      log.error('runtime store unavailable; taking local fallback', { err });
      return this.fallbackDecision(request, 'runtime-store-unavailable', route);
    }

    try {
      await this.opts.livekit.createRoom(roomName);
      await this.opts.livekit.dispatchAidaPrime(roomName, {
        callSessionId,
        tenantId: route.tenant.id,
        businessName: route.profile.businessName,
        prompt: route.profile.prompt,
        tone: route.profile.tone,
        objective: route.profile.objective,
        openingStatement: route.profile.openingStatement,
        transferStatement: route.profile.transferStatement,
        failedTransferStatement: route.profile.failedTransferStatement,
        locale: this.opts.defaultLocale,
        didE164: request.didE164,
      });
    } catch (err) {
      log.error('livekit dispatch failed; taking local fallback', { callSessionId, err });
      await this.recordFallback(callSessionId, 'livekit-unavailable');
      return this.fallbackDecision(request, 'livekit-unavailable', route);
    }

    await this.safeAppendEvent(callSessionId, 'bootstrapped', {
      didRouteId: route.didRoute.id,
      profileId: route.profile.id,
      profileRevision: route.profile.revision,
    });
    await this.opts.runtime.updateCallSession(callSessionId, { state: 'screening' }).catch(() => {});
    await this.notifyDevices(route, callSessionId);

    log.info('call bootstrapped for screening', { callSessionId, roomName });
    return {
      disposition: 'SCREEN',
      callSessionId,
      roomName,
      sipDestination: this.sipDestination(roomName),
    };
  }

  private sipDestination(roomName: string): string {
    return `${roomName}@${this.opts.livekitSipHost}`;
  }

  private async safeLookupExisting(linkedId: string): ReturnType<RuntimeStore['getCallSessionByLinkedId']> {
    try {
      return await this.opts.runtime.getCallSessionByLinkedId(linkedId);
    } catch {
      return undefined;
    }
  }

  /**
   * Builds the FALLBACK decision. When the route resolved we use its own
   * destination; otherwise we fall back to the DID projection, which is
   * still this DID's destination and still tenant-scoped.
   */
  private async fallbackDecision(
    request: BootstrapRequest,
    reason: string,
    route?: ResolvedRoute,
  ): Promise<BootstrapDecision> {
    let fallback: ResolvedFallback | undefined;
    if (route) {
      fallback = await this.opts.fallbackResolver.resolveDestination(
        route.didRoute.destinationType,
        route.didRoute.destinationId,
        route.tenant.id,
      );
    }
    fallback ??= await this.opts.fallbackResolver.resolveForDid(request.didE164);
    return { disposition: 'FALLBACK', fallback, fallbackReason: reason };
  }

  private async recordFallback(callSessionId: string, reason: string): Promise<void> {
    await this.opts.runtime
      .updateCallSession(callSessionId, { disposition: 'FALLBACK', state: 'fallback' })
      .catch(() => {});
    await this.safeAppendEvent(callSessionId, 'fallback', { reason });
  }

  private async safeAppendEvent(
    callSessionId: string,
    eventType: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.opts.runtime.appendCallEvent(callSessionId, { eventType, payload });
    } catch (err) {
      this.opts.logger.warn('call event persistence failed', { callSessionId, eventType, err });
    }
  }

  /**
   * Best-effort handset notification. A device that never learns about the
   * call is a degraded experience; a caller who waits on Pusher is a
   * broken one — so failures here are logged and dropped.
   */
  private async notifyDevices(route: ResolvedRoute, callSessionId: string): Promise<void> {
    if (!this.opts.notifier) return;
    try {
      const deviceIds = await this.resolveDeviceIds(route);
      const alert = { eventId: randomUUID(), callSessionId, occurredAt: new Date().toISOString() };
      await Promise.all(
        deviceIds.map((deviceId) => this.opts.notifier?.publishCallStarted(deviceId, alert) ?? Promise.resolve(false)),
      );
    } catch (err) {
      this.opts.logger.warn('call arrival notification skipped', { callSessionId, err });
    }
  }

  /** Managed handsets that should ring for this route's destination. */
  private async resolveDeviceIds(route: ResolvedRoute): Promise<string[]> {
    if (route.didRoute.destinationType !== 'EXTENSION') return [];
    const extension = await this.opts.config.getExtension(route.didRoute.destinationId);
    if (!extension?.deviceId || extension.tenantId !== route.tenant.id) return [];
    return [extension.deviceId];
  }
}
