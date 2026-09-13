import type { Admission, AdmissionStore } from './store.js';
import { CredentialRejected, InvalidShape, UUID, TOKEN, digest, sameHash, parseBinding, type BootstrapBinding } from './contract.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { NativeAuthority } from './native.js';
import type { Route } from '../http/httpServer.js';

export interface Participant { sid: string; identity: string; kind?: string | number; attributes?: Record<string, string> }
export interface AgentLiveKit {
  listParticipants(room: string): Promise<Participant[]>;
  dispatchAgent(room: string, metadata: { callSessionId: string; bootstrapToken: string }): Promise<string>;
  dispatchIdentity(room: string, dispatchId: string): Promise<string | undefined>;
  createRoom(room: string): Promise<void>;
}
export const isKind = (p: Participant, kind: 'SIP' | 'AGENT') => p.kind === kind || p.kind === (kind === 'SIP' ? 3 : 4);
export class BootstrapAuthority {
  constructor(readonly opts: { store: AdmissionStore; runtime: RuntimeStore; native: NativeAuthority;
    livekit: AgentLiveKit; routeAttribute: string; instanceId: string }) {}
  async participants(a: Admission, binding?: BootstrapBinding): Promise<{ sip: Participant; agent: Participant }> {
    const [participants, intended] = await Promise.all([this.opts.livekit.listParticipants(a.roomName), this.opts.livekit.dispatchIdentity(a.roomName, a.dispatchId!)]);
    const sips = participants.filter(p => isKind(p, 'SIP')); const agents = participants.filter(p => isKind(p, 'AGENT'));
    const sip = sips[0]; const agent = agents[0];
    if (sips.length !== 1 || agents.length !== 1 || !sip || !agent || !intended || agent.identity !== intended ||
      !TOKEN.test(sip.attributes?.[this.opts.routeAttribute] ?? '') || !sameHash(digest(sip.attributes![this.opts.routeAttribute]!), a.routeHash) ||
      (binding && (sip.identity !== binding.sipParticipantIdentity || sip.sid !== binding.sipParticipantSid)) ||
      (a.sipSid && (sip.sid !== a.sipSid || sip.identity !== a.sipIdentity || agent.sid !== a.agentSid || agent.identity !== a.agentIdentity))) throw new CredentialRejected();
    return { sip, agent };
  }
  async authorize(id: string, token: string, b: BootstrapBinding) {
    const a = await this.opts.store.get(id);
    if (!a || a.status !== 'dispatched' || !a.dispatchId || a.instanceId !== this.opts.instanceId ||
      a.expiresAt <= Date.now() || !sameHash(a.bootstrapHash, digest(token)) || !sameHash(a.routeHash, digest(b.routeToken)) || b.roomName !== a.roomName || a.roomName !== `aida-${id}`) throw new CredentialRejected();
    const call = await this.opts.runtime.getCallSession(id);
    if (!call || call.endedAt || call.tenantId !== a.tenantId || call.asteriskLinkedId !== a.linkedId || call.disposition !== 'SCREEN' ||
      !await this.opts.native.authorized(a.tenantId, call.didE164, call.destinationId!, call.config.profileId!)) throw new CredentialRejected();
    const { sip, agent } = await this.participants(a, b);
    const profile = await this.opts.store.consume(a, { bootstrapHash: digest(token), routeHash: digest(b.routeToken),
      sipIdentity: sip.identity, sipSid: sip.sid, agentIdentity: agent.identity, agentSid: agent.sid });
    return { callSessionId: id, roomName: a.roomName, sipParticipantIdentity: sip.identity, sipParticipantSid: sip.sid, profileSnapshot: profile };
  }
  route(enabled: boolean): Route {
    return { method: 'POST', pattern: '/v1/agent/calls/:callSessionId/bootstrap', trusted: false, rawBody: true,
      handler: async req => {
        if (!enabled) return { status: 503, body: { error: 'authority_unavailable' } };
        try {
          if (!(req.headers['content-type'] ?? '').match(/^application\/json(?:\s*;\s*charset=utf-8)?$/i) || req.headers['content-encoding']) throw new InvalidShape();
          const b = parseBinding(req.rawBody ?? Buffer.alloc(0));
          const id = req.params.callSessionId ?? '';
          const token = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(req.headers.authorization ?? '')?.[1];
          if (!UUID.test(id) || !token) throw new CredentialRejected();
          return { status: 200, body: await this.authorize(id, token, b) };
        } catch (error) {
          if (error instanceof InvalidShape) return { status: 400, body: { error: 'invalid_request' } };
          if (error instanceof CredentialRejected) return { status: 401, body: { error: 'credential_rejected' } };
          // Never pass SDK/SQL errors to HTTP logging: they may contain profile/token parameters.
          return { status: 503, body: { error: 'authority_unavailable' } };
        }
      } };
  }
}
