import type { Logger } from '../logging/logger.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { AriApi, AriEvent, ChannelDestroyedEvent, ChannelStateChangeEvent, StasisStartEvent } from '../ari/types.js';

/** Channel variables used to correlate ARI resources across restarts. */
export const CHANVAR = {
  callSessionId: 'AIDA_CALL_SESSION_ID',
  role: 'AIDA_ROLE',
  takeoverKey: 'AIDA_TAKEOVER_KEY',
  sipDestination: 'AIDA_SIP_DESTINATION',
} as const;

export type TakeoverFailureReason = 'busy' | 'rejected' | 'no-answer' | 'failed';

export interface TakeoverCommand {
  callSessionId: string;
  idempotencyKey: string;
  destinationType: 'EXTENSION' | 'RING_GROUP';
  context: string;
  exten: string;
  ringTimeoutSeconds?: number;
  musicOnHoldClass?: string;
}

export interface TakeoverAck {
  status: 'ringing' | 'in-progress' | 'answered' | TakeoverFailureReason;
}

export interface CallEventSink {
  postCallEvent(
    callSessionId: string,
    event: { eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<boolean>;
}

interface CallSession {
  callSessionId: string;
  linkedid?: string;
  callerChannelId?: string;
  callerNumber?: string;
  livekitChannelId?: string;
  bridgeId?: string;
  humanChannelId?: string;
  humanAnswered: boolean;
  mohActive: boolean;
  drainTimer?: NodeJS.Timeout;
  activeCommandKey?: string;
  completedCommands: Map<string, TakeoverAck>;
  eventSeq: number;
  ringingReported: boolean;
}

export interface TakeoverManagerOptions {
  ari: AriApi;
  events: CallEventSink;
  logger: Logger;
  drainTimeoutMs: number;
  defaultRingTimeoutSeconds: number;
  defaultMohClass: string;
  /** PJSIP endpoint name of the existing LiveKit Cloud SIP trunk. */
  livekitTrunkEndpoint?: string;
}

const CAUSE_TO_REASON: Record<number, TakeoverFailureReason> = {
  17: 'busy',
  21: 'rejected',
  18: 'no-answer',
  19: 'no-answer',
};

/**
 * Owns asynchronous multi-channel call control after FastAGI ends
 * (POC issue 4). Tracks caller / LiveKit / human channels and the mixing
 * bridge per call session, executes idempotent takeover originates, and
 * runs the bounded Aida drain after a human answers.
 *
 * Project invariant enforced here: no failure or cleanup path ever
 * removes the caller or the human from an established caller-human
 * bridge. Aida/LiveKit is the only leg drain removes.
 */
export class TakeoverManager {
  private readonly sessions = new Map<string, CallSession>();
  private readonly channelToSession = new Map<string, string>();

  constructor(private readonly opts: TakeoverManagerOptions) {
    opts.ari.on('StasisStart', (ev) => void this.onStasisStart(ev as StasisStartEvent));
    opts.ari.on('ChannelStateChange', (ev) => void this.onChannelStateChange(ev as ChannelStateChangeEvent));
    opts.ari.on('ChannelDestroyed', (ev) => void this.onChannelDestroyed(ev as ChannelDestroyedEvent));
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  getSession(callSessionId: string): Readonly<CallSession> | undefined {
    return this.sessions.get(callSessionId);
  }

  private log(session: CallSession): Logger {
    // Metrics/log correlation is by callSessionId/linkedid only — never
    // caller number or token material.
    return this.opts.logger.child({ callSessionId: session.callSessionId, linkedid: session.linkedid });
  }

  private ensureSession(callSessionId: string): CallSession {
    let session = this.sessions.get(callSessionId);
    if (!session) {
      session = {
        callSessionId,
        humanAnswered: false,
        mohActive: false,
        completedCommands: new Map(),
        eventSeq: 0,
        ringingReported: false,
      };
      this.sessions.set(callSessionId, session);
    }
    return session;
  }

  private async emitEvent(session: CallSession, eventType: string, payload?: Record<string, unknown>): Promise<void> {
    session.eventSeq += 1;
    await this.opts.events.postCallEvent(session.callSessionId, {
      eventType,
      occurredAt: new Date().toISOString(),
      idempotencyKey: `${session.callSessionId}:${session.eventSeq}:${eventType}`,
      payload,
    });
  }

  // ---------------------------------------------------------------- inbound

  private async onStasisStart(ev: StasisStartEvent): Promise<void> {
    const role = ev.args[0];
    const callSessionId = ev.args[1];
    if (!role || !callSessionId) return;
    try {
      if (role === 'screen') await this.onCallerEntered(callSessionId, ev);
      else if (role === 'human') await this.onHumanAnswered(callSessionId, ev);
      else if (role === 'livekit') await this.onLivekitUp(callSessionId, ev);
    } catch (err) {
      this.opts.logger.error('stasis event handling failed', { role, callSessionId, err });
    }
  }

  /** Caller channel arrives from the dialplan SCREEN path. */
  private async onCallerEntered(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.ensureSession(callSessionId);
    if (session.callerChannelId === ev.channel.id) return; // duplicate event
    session.callerChannelId = ev.channel.id;
    session.callerNumber = ev.channel.caller?.number;
    this.channelToSession.set(ev.channel.id, callSessionId);
    const log = this.log(session);

    const ari = this.opts.ari;
    session.linkedid = (await ari.getChannelVar(ev.channel.id, 'CHANNEL(linkedid)')) ?? undefined;
    const sipDestination = await ari.getChannelVar(ev.channel.id, CHANVAR.sipDestination);
    if (!sipDestination) {
      log.error('caller entered stasis without a SIP destination; hanging up to dialplan fallback');
      await this.safeAri(() => ari.hangup(ev.channel.id, 'congestion'));
      this.cleanupSession(session);
      return;
    }

    // Stamp correlation vars so a restarted process can rebuild this
    // session from live ARI resources (reconcile()).
    await this.safeAri(() => ari.setChannelVar(ev.channel.id, CHANVAR.callSessionId, callSessionId));
    await this.safeAri(() => ari.setChannelVar(ev.channel.id, CHANVAR.role, 'caller'));

    await ari.answer(ev.channel.id);
    const bridge = await ari.createBridge('mixing');
    session.bridgeId = bridge.id;
    await ari.addToBridge(bridge.id, ev.channel.id);

    const endpoint = this.opts.livekitTrunkEndpoint
      ? `PJSIP/${sipDestination}@${this.opts.livekitTrunkEndpoint}`
      : `PJSIP/${sipDestination}`;
    const livekit = await ari.originate({
      endpoint,
      appArgs: `livekit,${callSessionId}`,
      timeoutSeconds: 15,
      variables: {
        [CHANVAR.callSessionId]: callSessionId,
        [CHANVAR.role]: 'livekit',
        // Header mapping: the LiveKit SIP trunk maps this header onto a
        // SIP participant attribute, so the agent can correlate its leg.
        //
        // No route token travels here any more (issue #9). It existed to
        // prove AidaControl had authorized this leg for one room; this
        // service now creates that room and dispatches the agent into it
        // itself, over an authenticated server-side API, so a bearer token
        // carried through SIP headers would add exposure, not assurance.
        'PJSIP_HEADER(add,X-Aida-Call-Session)': callSessionId,
      },
    });
    session.livekitChannelId = livekit.id;
    this.channelToSession.set(livekit.id, callSessionId);
    log.info('screening leg originated', { livekitChannelId: livekit.id });
    await this.emitEvent(session, 'screening-started');
  }

  /** LiveKit leg answered — join it to the caller's bridge. */
  private async onLivekitUp(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.sessions.get(callSessionId);
    if (!session?.bridgeId) return;
    session.livekitChannelId = ev.channel.id;
    this.channelToSession.set(ev.channel.id, callSessionId);
    await this.safeAri(() => this.opts.ari.setChannelVar(ev.channel.id, CHANVAR.callSessionId, callSessionId));
    await this.safeAri(() => this.opts.ari.setChannelVar(ev.channel.id, CHANVAR.role, 'livekit'));
    await this.opts.ari.addToBridge(session.bridgeId, ev.channel.id);
    this.log(session).info('aida joined bridge');
    await this.emitEvent(session, 'aida-connected');
  }

  // --------------------------------------------------------------- takeover

  /**
   * Idempotent takeover: exactly one originate per accepted command.
   * Replays (same idempotency key) return the recorded outcome; a
   * different concurrent command conflicts.
   */
  async takeover(cmd: TakeoverCommand): Promise<TakeoverAck> {
    const session = this.sessions.get(cmd.callSessionId);
    if (!session || !session.callerChannelId || !session.bridgeId) {
      throw new NotFoundError(`no active screened call for session ${cmd.callSessionId}`);
    }

    const replay = session.completedCommands.get(cmd.idempotencyKey);
    if (replay) return replay;
    if (session.activeCommandKey === cmd.idempotencyKey) return { status: 'in-progress' };
    if (session.activeCommandKey !== undefined) {
      throw new ConflictError(`takeover already in progress for session ${cmd.callSessionId}`);
    }
    if (session.humanAnswered) {
      throw new ConflictError(`session ${cmd.callSessionId} already taken over`);
    }

    session.activeCommandKey = cmd.idempotencyKey;
    session.ringingReported = false;
    const log = this.log(session);
    try {
      const human = await this.opts.ari.originate({
        endpoint: `Local/${cmd.exten}@${cmd.context}`,
        appArgs: `human,${cmd.callSessionId},${cmd.idempotencyKey}`,
        callerId: session.callerNumber,
        timeoutSeconds: cmd.ringTimeoutSeconds ?? this.opts.defaultRingTimeoutSeconds,
        variables: {
          [CHANVAR.callSessionId]: cmd.callSessionId,
          [CHANVAR.role]: 'human',
          [CHANVAR.takeoverKey]: cmd.idempotencyKey,
        },
      });
      session.humanChannelId = human.id;
      this.channelToSession.set(human.id, cmd.callSessionId);
    } catch (err) {
      session.activeCommandKey = undefined;
      log.error('takeover originate failed', { err });
      throw err;
    }

    // Hold treatment while the destination rings; organization-selectable
    // MOH class comes with the command (from ring group / DID route).
    const mohClass = cmd.musicOnHoldClass ?? this.opts.defaultMohClass;
    await this.safeAri(() => this.opts.ari.startBridgeMoh(session.bridgeId as string, mohClass));
    session.mohActive = true;

    log.info('takeover originated', { destinationType: cmd.destinationType });
    await this.emitEvent(session, 'takeover-requested', { destinationType: cmd.destinationType });
    return { status: 'ringing' };
  }

  /** Human leg answered: bridge immediately, then drain Aida. */
  private async onHumanAnswered(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.sessions.get(callSessionId);
    if (!session?.bridgeId) {
      // Caller vanished while the destination was ringing — nothing to
      // connect the human to; release the leg.
      await this.safeAri(() => this.opts.ari.hangup(ev.channel.id));
      return;
    }
    if (session.humanAnswered) return; // duplicate event
    session.humanChannelId = ev.channel.id;
    session.humanAnswered = true;
    this.channelToSession.set(ev.channel.id, callSessionId);
    const log = this.log(session);

    // Hold treatment stops the moment the human answers so it cannot
    // leak into the bridged conversation.
    await this.stopMoh(session);
    await this.opts.ari.addToBridge(session.bridgeId, ev.channel.id);
    log.info('human answered and bridged');

    const key = session.activeCommandKey ?? ev.args[2];
    if (key) {
      session.completedCommands.set(key, { status: 'answered' });
      session.activeCommandKey = undefined;
    }
    await this.emitEvent(session, 'answered');
    await this.emitEvent(session, 'bridged');

    // Local bounded drain: Aida gets at most drainTimeoutMs to wrap up;
    // A drain-ack command can complete it earlier.
    session.drainTimer = setTimeout(() => {
      session.drainTimer = undefined;
      void this.removeAida(session, 'drain-deadline');
    }, this.opts.drainTimeoutMs);
  }

  /** The drain was acknowledged — remove Aida now. */
  async acknowledgeDrain(callSessionId: string): Promise<{ status: string }> {
    const session = this.sessions.get(callSessionId);
    if (!session) throw new NotFoundError(`no session ${callSessionId}`);
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = undefined;
      await this.removeAida(session, 'drain-ack');
      return { status: 'drained' };
    }
    return { status: session.livekitChannelId ? 'not-draining' : 'already-drained' };
  }

  /**
   * Remove ONLY the LiveKit/Aida leg. Guarded: if the human is no longer
   * present the drain is aborted so the caller is never left alone.
   */
  private async removeAida(session: CallSession, reason: string): Promise<void> {
    if (!session.humanAnswered || !session.humanChannelId) {
      this.log(session).warn('drain aborted: human no longer present; keeping Aida with caller', { reason });
      return;
    }
    const livekitId = session.livekitChannelId;
    if (!livekitId) return;
    session.livekitChannelId = undefined;
    if (session.bridgeId) {
      await this.safeAri(() => this.opts.ari.removeFromBridge(session.bridgeId as string, livekitId));
    }
    await this.safeAri(() => this.opts.ari.hangup(livekitId));
    this.channelToSession.delete(livekitId);
    this.log(session).info('aida drained', { reason });
    await this.emitEvent(session, 'aida-drained', { reason });
  }

  // ----------------------------------------------------------------- events

  private async onChannelStateChange(ev: ChannelStateChangeEvent): Promise<void> {
    const callSessionId = this.channelToSession.get(ev.channel.id);
    if (!callSessionId) return;
    const session = this.sessions.get(callSessionId);
    if (!session) return;
    if (ev.channel.id === session.humanChannelId && ev.channel.state === 'Ringing' && !session.ringingReported) {
      session.ringingReported = true;
      await this.emitEvent(session, 'ringing');
    }
  }

  private async onChannelDestroyed(ev: ChannelDestroyedEvent): Promise<void> {
    const callSessionId = this.channelToSession.get(ev.channel.id);
    if (!callSessionId) return;
    const session = this.sessions.get(callSessionId);
    if (!session) return;
    this.channelToSession.delete(ev.channel.id);

    if (ev.channel.id === session.humanChannelId) {
      await this.onHumanGone(session, ev);
      return;
    }
    if (ev.channel.id === session.callerChannelId) {
      await this.onCallerGone(session);
      return;
    }
    if (ev.channel.id === session.livekitChannelId) {
      session.livekitChannelId = undefined;
      if (!session.humanAnswered) {
        // Aida died mid-screening with no takeover done. The event is
        // recorded so an operator or handset can command a takeover. The
        // caller stays up (dialplan fallback only covers pre-Stasis).
        this.log(session).warn('aida leg lost during screening');
        await this.emitEvent(session, 'aida-lost');
      }
      return;
    }
  }

  private async onHumanGone(session: CallSession, ev: ChannelDestroyedEvent): Promise<void> {
    const log = this.log(session);
    if (!session.humanAnswered) {
      // Ring failed: busy / rejected / no-answer. Caller stays with Aida.
      const reason: TakeoverFailureReason = CAUSE_TO_REASON[ev.cause] ?? 'no-answer';
      session.humanChannelId = undefined;
      await this.stopMoh(session);
      const key = session.activeCommandKey;
      if (key) {
        session.completedCommands.set(key, { status: reason });
        session.activeCommandKey = undefined;
      }
      log.info('takeover failed; caller remains with aida', { reason, cause: ev.cause });
      await this.emitEvent(session, 'takeover-failed', { reason, cause: ev.cause });
      return;
    }

    session.humanChannelId = undefined;
    session.humanAnswered = false;
    if (session.drainTimer) {
      // Human hung up during the drain window: cancel the drain and keep
      // Aida bridged so the caller is never stranded.
      clearTimeout(session.drainTimer);
      session.drainTimer = undefined;
      log.warn('human hung up during drain; keeping aida with caller');
      await this.emitEvent(session, 'human-hangup', { during: 'drain' });
      return;
    }
    // Takeover was complete (Aida already gone): human hangup ends the call.
    log.info('human hung up after takeover; ending call');
    await this.emitEvent(session, 'human-hangup', { during: 'bridged' });
    if (session.callerChannelId) {
      await this.safeAri(() => this.opts.ari.hangup(session.callerChannelId as string));
    }
  }

  private async onCallerGone(session: CallSession): Promise<void> {
    this.log(session).info('caller hung up');
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = undefined;
    }
    for (const legId of [session.livekitChannelId, session.humanChannelId]) {
      if (legId) {
        await this.safeAri(() => this.opts.ari.hangup(legId));
        this.channelToSession.delete(legId);
      }
    }
    await this.emitEvent(session, 'hangup');
    this.cleanupSession(session);
  }

  private cleanupSession(session: CallSession): void {
    if (session.drainTimer) clearTimeout(session.drainTimer);
    for (const id of [session.callerChannelId, session.livekitChannelId, session.humanChannelId]) {
      if (id) this.channelToSession.delete(id);
    }
    this.sessions.delete(session.callSessionId);
  }

  private async stopMoh(session: CallSession): Promise<void> {
    if (!session.mohActive || !session.bridgeId) return;
    session.mohActive = false;
    await this.safeAri(() => this.opts.ari.stopBridgeMoh(session.bridgeId as string));
  }

  // --------------------------------------------------------- reconciliation

  /**
   * Rebuild in-memory state from live ARI resources after a restart or
   * WebSocket reconnect. Accepted commands rediscovered from channel
   * variables are recorded as completed so a replayed command never
   * originates a duplicate human leg.
   */
  async reconcile(): Promise<void> {
    const [channels, bridges] = await Promise.all([this.opts.ari.listChannels(), this.opts.ari.listBridges()]);
    for (const channel of channels) {
      const callSessionId = await this.opts.ari.getChannelVar(channel.id, CHANVAR.callSessionId);
      if (!callSessionId) continue;
      const role = await this.opts.ari.getChannelVar(channel.id, CHANVAR.role);
      const session = this.ensureSession(callSessionId);
      this.channelToSession.set(channel.id, callSessionId);
      if (role === 'livekit') session.livekitChannelId = channel.id;
      else if (role === 'human') {
        session.humanChannelId = channel.id;
        session.humanAnswered = channel.state === 'Up';
        const key = await this.opts.ari.getChannelVar(channel.id, CHANVAR.takeoverKey);
        if (key) {
          session.completedCommands.set(key, { status: session.humanAnswered ? 'answered' : 'in-progress' });
          if (!session.humanAnswered) session.activeCommandKey = key;
        }
      } else {
        session.callerChannelId = channel.id;
        session.callerNumber = channel.caller?.number;
      }
    }
    for (const bridge of bridges) {
      for (const channelId of bridge.channels) {
        const callSessionId = this.channelToSession.get(channelId);
        if (callSessionId) {
          const session = this.sessions.get(callSessionId);
          if (session) session.bridgeId = bridge.id;
        }
      }
    }
    this.opts.logger.info('takeover state reconciled', { sessions: this.sessions.size });
  }

  private async safeAri(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.opts.logger.warn('ari operation failed', { err });
    }
  }
}
