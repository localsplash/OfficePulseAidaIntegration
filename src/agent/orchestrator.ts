import { randomUUID } from 'node:crypto';
import { credential, digest } from './contract.js';
import type { BootstrapDecider, BootstrapRequest, BootstrapDecision } from '../agi/bootstrapHandler.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { AdmissionStore } from './store.js';
import type { NativeAuthority } from './native.js';
import type { AgentLiveKit } from './authority.js';
import type { RoomMonitor } from './monitor.js';
import type { Logger } from '../logging/logger.js';

export class NativeCallOrchestrator implements BootstrapDecider {
  constructor(private readonly opts: { runtime: RuntimeStore; store: AdmissionStore; native: NativeAuthority; livekit: AgentLiveKit;
    monitor: RoomMonitor; instanceId: string; startupTimeoutMs: number; setupTimeoutMs?: number; observeCaller?: (id: string, channelId: string) => void; available: () => boolean;
    /** Records which setup step fell back. Never receives upstream messages, which can carry profile or credential parameters. */
    logger?: Pick<Logger, 'warn'> }) {}
  async bootstrapInboundCall(r: BootstrapRequest): Promise<BootstrapDecision> {
    let id: string | undefined;
    let stage = 'available';
    const setupDeadline = Date.now() + (this.opts.setupTimeoutMs ?? 9500);
    const withinSetup = () => { if (Date.now() >= setupDeadline) throw new Error('FastAGI setup expired'); };
    try {
      if (!this.opts.available() || r.officePulseInstanceId !== this.opts.instanceId || !/^[A-Za-z0-9_.-]{1,80}$/.test(r.asteriskLinkedId)) throw new Error('unavailable');
      stage = 'resolve';
      const candidate = randomUUID();
      const ingressContext = r.ingressContext ?? '';
      const native = await this.opts.native.resolve({ didE164: r.didE164, ingressContext, fallbackQueue: r.fallbackQueue ?? '' }, candidate);
      withinSetup();
      if (!native || native.pbxInstanceId !== this.opts.instanceId) throw new Error('unauthorized');
      stage = 'create-session';
      const roomName = `aida-${candidate}`;
      // The call pins its routing scope {instance, context} and the ingress context; tenantId is customer identity only.
      const result = await this.opts.runtime.createCallSession({ id: candidate, asteriskLinkedId: r.asteriskLinkedId,
        officePulseInstanceId: r.officePulseInstanceId, pbxContext: native.context, ingressContext, tenantId: native.tenantId, didE164: r.didE164, callerNumber: r.callerNumber,
        config: { profileId: native.profileId, profileRevision: native.profileRevision }, roomName,
        destinationType: 'QUEUE', destinationId: native.queue, disposition: 'SCREEN', state: 'arrived' });
      // Retry cannot redispatch or reissue a secret. Invalidate ambiguous earlier admission.
      if (!result.created) {
        if (result.session.officePulseInstanceId === r.officePulseInstanceId && result.session.tenantId === native.tenantId) {
          await this.opts.store.transition(result.session.id, 'fallback', 'bootstrap-replayed');
        }
        throw new Error('duplicate');
      }
      stage = 'call-arrived';
      id = candidate;
      if (r.asteriskChannelId) this.opts.observeCaller?.(id, r.asteriskChannelId);
      withinSetup();
      // Sanitized evidence that Asterisk's own context/DID/CID reached bootstrap.
      // CID digits stay in the dedicated call_session column, never in event payloads.
      await this.opts.runtime.appendCallEvent(id, { eventType: 'call-arrived',
        payload: { ingressContext, context: native.context, queue: native.queue, callerIdPresent: r.callerNumber !== undefined } });
      stage = 'admission-record';
      const bootstrapToken = credential(); const routeToken = credential();
      const deadline = Date.now() + this.opts.startupTimeoutMs;
      await this.opts.store.create({ callId: id, tenantId: native.tenantId, roomName, instanceId: r.officePulseInstanceId,
        pbxInstanceId: native.pbxInstanceId, context: native.context, ingressContext,
        linkedId: r.asteriskLinkedId, bootstrapHash: digest(bootstrapToken), routeHash: digest(routeToken), profile: native.profile,
        expiresAt: Date.now() + 120_000, status: 'pending' });
      stage = 'livekit-create-room';
      await this.opts.livekit.createRoom(roomName);
      withinSetup();
      stage = 'monitor-connect';
      await this.opts.monitor.start(id, deadline);
      withinSetup();
      stage = 'livekit-dispatch';
      const dispatchId = await this.opts.livekit.dispatchAgent(roomName, { callSessionId: id, bootstrapToken, pbxInstanceId: native.pbxInstanceId, context: native.context });
      withinSetup();
      stage = 'dispatch-record';
      await this.opts.store.dispatched(id, dispatchId);
      await this.opts.runtime.appendCallEvent(id, { eventType: 'agent-dispatched' });
      if (Date.now() >= deadline) throw new Error('startup expired');
      // SIP enters before readiness is awaited; Agent needs that leg to authorize.
      return { disposition: 'SCREEN', callSessionId: id, roomName, sipDestination: roomName, routeToken,
        fallback: { context: 'aida-agent-queue-fallback', exten: native.queue, source: 'native-pbx' } };
    } catch (error) {
      this.opts.logger?.warn('native admission fell back', { stage, callSessionId: id,
        error: error instanceof Error ? error.name : 'unknown' });
      if (id) {
        await this.opts.store.transition(id, 'fallback', 'bootstrap-failed').catch(() => {});
        const call = await this.opts.runtime.getCallSession(id).catch(() => undefined);
        if (call && !call.endedAt) await this.opts.runtime.updateCallSession(id, { disposition: 'FALLBACK', state: 'fallback' }).catch(() => {});
        await this.opts.monitor.stop(id).catch(() => {});
      }
      return { disposition: 'FALLBACK', callSessionId: id, fallbackReason: 'native-admission-failed' };
    }
  }
}
