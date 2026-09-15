import { Room, RoomEvent } from '@livekit/rtc-node';
import { signAccessToken } from '../livekit/token.js';
import { exact, object } from './contract.js';
import type { BootstrapAuthority } from './authority.js';
import type { Logger } from '../logging/logger.js';

export interface RoomMonitor {
  start(callId: string, deadline: number): Promise<void>;
  stop(callId: string): Promise<void>;
  close(): Promise<void>;
}
/** Receives lifecycle data only. Never subscribes to media or retains/logs transcript bytes. */
export class AgentMonitor implements RoomMonitor {
  private readonly rooms = new Map<string, { room: Room; timer: NodeJS.Timeout; busy: boolean; deadline: number; conversation: boolean }>();
  constructor(private readonly opts: { authority: BootstrapAuthority; url: string; apiKey: string; apiSecret: string;
    fallback: (id: string) => Promise<void>; roomFactory?: () => Room;
    /** Diagnoses connect/fallback failures. LiveKit errors carry no profile or credential text. */
    logger?: Pick<Logger, 'warn'> }) {}
  isMonitoring(id: string): boolean { return this.rooms.has(id); }
  async start(id: string, deadline: number): Promise<void> {
    if (this.rooms.has(id)) return;
    const room = this.opts.roomFactory?.() ?? new Room();
    const entry = { room, timer: undefined as unknown as NodeJS.Timeout, busy: false, deadline, conversation: false };
    this.rooms.set(id, entry);
    const fail = () => { void this.fail(id).catch(() => {}); };
    room.on(RoomEvent.DataReceived, (bytes, sender, kind, topic) => {
      if (topic === 'transcript' && bytes.length <= 16384 && sender && kind === 0) {
        void this.conversation(id, bytes, sender.sid ?? '').catch(fail);
        return;
      }
      if (topic !== 'aida.event.agent_ready' || bytes.length > 2048 || kind !== 0 || !sender) return;
      void this.ready(id, bytes, sender.identity, sender.sid ?? '').catch(fail);
    });
    room.on(RoomEvent.Disconnected, fail);
    room.on(RoomEvent.Reconnecting, fail); // ready is never inferred or replayed after a connection gap
    entry.timer = setInterval(() => { void this.check(id).catch(fail); }, 1000);
    entry.timer.unref();
    try {
      const token = signAccessToken(this.opts.apiKey, this.opts.apiSecret, { identity: `officepulse-monitor-${id}`, ttlSeconds: 120,
        video: { roomJoin: true, room: `aida-${id}`, canPublish: false, canPublishData: false, canSubscribe: false } });
      // Connection has a separate bound; late success is disconnected after failed setup.
      let timeout: NodeJS.Timeout | undefined;
      try { await Promise.race([room.connect(this.opts.url, token, { autoSubscribe: false, dynacast: false }).then(async () => { if (!this.rooms.has(id)) await room.disconnect(); }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('monitor unavailable')), 5000); })]); }
      finally { if (timeout) clearTimeout(timeout); }
    } catch (error) {
      this.opts.logger?.warn('monitor room connection failed', { callSessionId: id,
        error: error instanceof Error ? error.name : 'unknown',
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined });
      await this.stop(id); throw new Error('monitor unavailable');
    }
  }
  async ready(id: string, bytes: Uint8Array, identity: string, sid: string): Promise<void> {
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(Buffer.from(bytes).toString('utf8')));
      exact(value, ['type', 'schemaVersion', 'callSessionId', 'agentIdentity', 'agentParticipantSid']);
    } catch { return; }
    if (value.type !== 'aida.event.agent_ready' || value.schemaVersion !== 1 || value.callSessionId !== id || value.agentIdentity !== identity || value.agentParticipantSid !== sid) return;
    const a = await this.opts.authority.opts.store.get(id);
    if (!a || a.status !== 'admitted' || a.agentIdentity !== identity || a.agentSid !== sid) return;
    const entry = this.rooms.get(id);
    if (!entry || Date.now() >= entry.deadline) { await this.fail(id); return; }
    await this.opts.authority.participants(a);
    await this.opts.authority.opts.store.transition(id, 'ready', 'agent-ready');
  }
  async conversation(id: string, bytes: Uint8Array, sid: string): Promise<void> {
    const entry = this.rooms.get(id); if (!entry || entry.conversation) return;
    const a = await this.opts.authority.opts.store.get(id);
    if (a?.status !== 'ready' || a.agentSid !== sid) return;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { return; }
    if (event.type !== 'transcript' || event.callId !== id || !['caller','assistant'].includes(String(event.speaker)) || typeof event.text !== 'string' || !event.text.trim()) return;
    await this.opts.authority.participants(a);
    entry.conversation = true;
    try { await this.opts.authority.opts.runtime.appendCallEvent(id, { eventType: 'conversation-observed' }); }
    catch (error) { entry.conversation = false; throw error; }
  }
  private async check(id: string): Promise<void> {
    const entry = this.rooms.get(id);
    if (!entry || entry.busy) return;
    entry.busy = true;
    try {
      const { store, runtime, native } = this.opts.authority.opts;
      const [a, c] = await Promise.all([store.get(id), runtime.getCallSession(id)]);
      if (!a || !c || c.endedAt) { await this.stop(id); return; }
      if (c.state === 'human-active' || a.status === 'ended') { await this.stop(id); return; }
      if (a.status === 'fallback') { await this.opts.fallback(id); await this.stop(id); return; }
      if (a.status !== 'ready' && Date.now() >= entry.deadline) { await this.fail(id); return; }
      if (a.status === 'ready' || a.status === 'admitted') {
        await this.opts.authority.participants(a);
        if (!await native.authorized(a.tenantId, c.didE164, c.destinationId!, c.config.profileId!)) await this.fail(id);
      }
    } finally { entry.busy = false; }
  }
  private async fail(id: string): Promise<void> {
    if (!this.rooms.has(id)) return;
    // Telephony fallback must run even when diagnostics storage is unavailable.
    await this.opts.authority.opts.store.transition(id, 'fallback', 'agent-fallback').catch(() => {});
    try { await this.opts.fallback(id); }
    catch (error) {
      this.opts.logger?.warn('telephony fallback failed', { callSessionId: id, error: error instanceof Error ? error.name : 'unknown' });
    } finally { await this.stop(id); }
  }
  async stop(id: string): Promise<void> {
    const entry = this.rooms.get(id); if (!entry) return;
    this.rooms.delete(id); clearInterval(entry.timer); entry.room.removeAllListeners();
    await entry.room.disconnect().catch(() => {});
  }
  async close(): Promise<void> { await Promise.all([...this.rooms.keys()].map(id => this.stop(id))); }
}
