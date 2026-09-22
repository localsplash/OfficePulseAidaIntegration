import { randomUUID } from 'node:crypto';
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
  destinationType: 'EXTENSION' | 'QUEUE';
  context: string;
  exten: string;
  ringTimeoutSeconds?: number;
  musicOnHoldClass?: string;
  deviceId?: string;
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
  callerEntered?: boolean;
  fallbackWork?: Promise<void>;
  callerNumber?: string;
  livekitChannelId?: string;
  bridgeId?: string;
  humanChannelId?: string;
  humanAnswered: boolean;
  mohActive: boolean;
  mohTimer?: NodeJS.Timeout;
  drainTimer?: NodeJS.Timeout;
  ending?: boolean;
  screeningClosed?: boolean;
  screeningCleanup?: Promise<void>;
  activeCommandKey?: string;
  completedCommands: Map<string, TakeoverAck>;
  eventSeq: number;
  ringingReported: boolean;
  fallbackInProgress?: boolean;
  fellBack?: boolean;
  fallbackTarget?: { context: string; exten: string };
}

export interface TakeoverManagerOptions {
  ari: AriApi;
  events: CallEventSink;
  logger: Logger;
  drainTimeoutMs: number;
  /** Announcement window while dialing; MOH waits, the originate does not. */
  announcementTimeoutMs?: number;
  /** Disconnect the monitor and delete this call's LiveKit room; never the telephone bridge. */
  closeScreening?: (callSessionId: string) => Promise<void>;
  defaultRingTimeoutSeconds: number;
  defaultMohClass: string;
  /** PJSIP endpoint name of the existing LiveKit Cloud SIP trunk. */
  livekitTrunkEndpoint?: string;
  nativeAdmission?: {
    validate(callId: string, linkedId: string | undefined, routeToken: string | undefined): Promise<boolean>;
    failed(callId: string): Promise<void>;
    ended(callId: string): Promise<void>;
    fallbackTarget(callId: string): Promise<{ context: string; exten: string } | undefined>;
  };
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

  observeCaller(callSessionId: string, channelId: string): void {
    const session = this.ensureSession(callSessionId);
    session.callerChannelId = channelId;
    this.channelToSession.set(channelId, callSessionId);
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
      this.opts.logger.error('stasis event handling failed', { role, callSessionId });
      if (role === 'screen' && this.opts.nativeAdmission) {
        await this.opts.nativeAdmission.failed(callSessionId).catch(() => {});
        await this.fallback(callSessionId).catch(() => {});
      }
    }
  }

  /** Caller channel arrives from the dialplan SCREEN path. */
  private async onCallerEntered(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.ensureSession(callSessionId);
    if (session.callerEntered && session.callerChannelId === ev.channel.id) return; // duplicate event
    session.callerEntered = true;
    session.callerChannelId = ev.channel.id;
    session.callerNumber = ev.channel.caller?.number;
    this.channelToSession.set(ev.channel.id, callSessionId);
    const log = this.log(session);

    const ari = this.opts.ari;
    session.linkedid = (await ari.getChannelVar(ev.channel.id, 'CHANNEL(linkedid)')) ?? undefined;
    if (this.opts.nativeAdmission) {
      const queue = await ari.getChannelVar(ev.channel.id, 'AIDA_FALLBACK_EXTENSION');
      if (/^[a-zA-Z0-9_.-]{1,60}$/.test(queue ?? '')) session.fallbackTarget = { context: 'aida-agent-queue-fallback', exten: queue! };
    }
    const sipDestination = await ari.getChannelVar(ev.channel.id, CHANVAR.sipDestination);
    const routeToken = this.opts.nativeAdmission ? await ari.getChannelVar(ev.channel.id, 'AIDA_ROUTE_TOKEN') : undefined;
    if (this.opts.nativeAdmission && !await this.opts.nativeAdmission.validate(callSessionId, session.linkedid, routeToken)) throw new Error('call admission unavailable');
    if (this.opts.nativeAdmission && (!/^[A-Za-z0-9_-]{43,256}$/.test(routeToken ?? '') || sipDestination !== `aida-${callSessionId}`)) throw new Error('SIP binding unavailable');
    if (!sipDestination) {
      log.error('caller entered stasis without a SIP destination');
      await this.fallback(callSessionId);
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

    if (session.fellBack || !this.sessions.has(callSessionId)) return;
    const endpoint = this.opts.nativeAdmission ? `Local/${sipDestination}@aida-agent-sip/n` : this.opts.livekitTrunkEndpoint
      ? `PJSIP/${sipDestination}@${this.opts.livekitTrunkEndpoint}`
      : `PJSIP/${sipDestination}`;
    const livekit = await ari.originate({
      endpoint,
      appArgs: `livekit,${callSessionId}`,
      timeoutSeconds: 15,
      variables: {
        [CHANVAR.callSessionId]: callSessionId,
        [CHANVAR.role]: 'livekit',
        ...(routeToken ? { __AIDA_ROUTE_TOKEN: routeToken, __AIDA_LIVEKIT_TRUNK: this.opts.livekitTrunkEndpoint! } : {}),
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
    if (session.fellBack || !this.sessions.has(callSessionId)) { await this.safeAri(() => ari.hangup(livekit.id)); return; }
    session.livekitChannelId = livekit.id;
    this.channelToSession.set(livekit.id, callSessionId);
    log.info('screening leg originated', { livekitChannelId: livekit.id });
    await this.emitEvent(session, 'screening-started');
  }

  /** LiveKit leg answered — join it to the caller's bridge. */
  private async onLivekitUp(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.sessions.get(callSessionId);
    if (!session?.bridgeId || session.fellBack) { await this.safeAri(() => this.opts.ari.hangup(ev.channel.id)); return; }
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
    if (!session || session.ending || !session.callerChannelId || !session.bridgeId) {
      throw new NotFoundError(`no active screened call for session ${cmd.callSessionId}`);
    }

    const replay = session.completedCommands.get(cmd.idempotencyKey);
    if (replay) return replay;
    if (session.activeCommandKey === cmd.idempotencyKey) return { status: 'in-progress' };
    if (session.activeCommandKey !== undefined) {
      throw new ConflictError('takeover_in_progress');
    }
    if (session.humanAnswered) {
      throw new ConflictError('already_taken');
    }

    session.activeCommandKey = cmd.idempotencyKey;
    session.ringingReported = false;
    const log = this.log(session);
    const announcementDeadline = Date.now() + (this.opts.announcementTimeoutMs ?? 3000);
    await this.emitEvent(session, 'takeover-requested', { destinationType: cmd.destinationType, deadlineMs: announcementDeadline,
      ...(cmd.deviceId ? { deviceId: cmd.deviceId, endpointId: cmd.exten } : {}) });
    // Dial immediately while the agent announces. The answered handset joins
    // the same bridge and hears the outro still in progress.
    if (!this.sessions.has(cmd.callSessionId) || session.ending || session.fellBack || session.fallbackInProgress) return { status: 'failed' };
    // Busy/auto-answer events can precede the REST response. Correlate before dialing.
    const humanId = randomUUID();
    session.humanChannelId = humanId;
    this.channelToSession.set(humanId, cmd.callSessionId);
    try {
      const human = await this.opts.ari.originate({
        channelId: humanId,
        // ARI retains this ID for drain and hangup handling. Optimization would
        // destroy it as soon as media flows and replace it with the PJSIP leg.
        endpoint: `Local/${cmd.exten}@${cmd.context}/n`,
        appArgs: `human,${cmd.callSessionId},${cmd.idempotencyKey}`,
        callerId: session.callerNumber,
        timeoutSeconds: cmd.ringTimeoutSeconds ?? this.opts.defaultRingTimeoutSeconds,
        variables: {
          [CHANVAR.callSessionId]: cmd.callSessionId,
          [CHANVAR.role]: 'human',
          [CHANVAR.takeoverKey]: cmd.idempotencyKey,
          ...(cmd.context === 'aida-takeover' ? {
            __AIDA_TAKEOVER: '1',
            __AIDA_TAKEOVER_RING_SECONDS: String(cmd.ringTimeoutSeconds ?? this.opts.defaultRingTimeoutSeconds),
          } : {}),
        },
      });
      if (!this.sessions.has(cmd.callSessionId) || session.ending || session.fellBack || session.fallbackInProgress) {
        await this.safeAri(() => this.opts.ari.hangup(human.id));
        return { status: 'failed' };
      }
      if (session.humanChannelId !== humanId) return session.completedCommands.get(cmd.idempotencyKey) ?? { status: 'failed' };
      session.humanChannelId = human.id;
      this.channelToSession.set(human.id, cmd.callSessionId);
    } catch (err) {
      this.channelToSession.delete(humanId);
      if (session.humanChannelId === humanId) session.humanChannelId = undefined;
      session.activeCommandKey = undefined;
      log.error('takeover originate failed', { err });
      await this.emitEvent(session, 'takeover-failed', { reason: 'failed' });
      throw err;
    }

    // Only MOH waits for the announcement window, so it cannot mask the outro.
    const mohClass = cmd.musicOnHoldClass ?? this.opts.defaultMohClass;
    const startMoh = async () => {
      if (session.humanAnswered || session.ending || session.humanChannelId !== humanId || session.fellBack) return;
      session.mohActive = true;
      await this.safeAri(() => this.opts.ari.startBridgeMoh(session.bridgeId as string, mohClass));
      if (session.humanAnswered || session.ending || session.humanChannelId !== humanId || !this.sessions.has(cmd.callSessionId)) await this.stopMoh(session);
    };
    if (!session.humanAnswered) {
      const remaining = announcementDeadline - Date.now();
      if (remaining > 0) session.mohTimer = setTimeout(() => {
        session.mohTimer = undefined;
        void startMoh();
      }, remaining);
      else await startMoh();
    }

    log.info('takeover originated', { destinationType: cmd.destinationType });
    return { status: session.humanAnswered ? 'answered' : 'ringing' };
  }

  /** Human leg answered: bridge immediately, then drain Aida. */
  private async onHumanAnswered(callSessionId: string, ev: StasisStartEvent): Promise<void> {
    const session = this.sessions.get(callSessionId);
    if (!session?.bridgeId || session.ending) {
      // Caller vanished while the destination was ringing — nothing to
      // connect the human to; release the leg.
      await this.safeAri(() => this.opts.ari.hangup(ev.channel.id));
      return;
    }
    if (session.fallbackInProgress || session.fellBack) { await this.safeAri(() => this.opts.ari.hangup(ev.channel.id)); return; }
    if (session.humanAnswered) return; // duplicate event
    session.humanChannelId = ev.channel.id;
    session.humanAnswered = true;
    this.channelToSession.set(ev.channel.id, callSessionId);
    const log = this.log(session);

    // Hold treatment stops the moment the human answers so it cannot
    // leak into the bridged conversation.
    await this.stopMoh(session);
    if (session.ending || session.humanChannelId !== ev.channel.id) return;
    try { await this.opts.ari.addToBridge(session.bridgeId, ev.channel.id); }
    catch {
      session.humanAnswered = false;
      session.humanChannelId = undefined;
      this.channelToSession.delete(ev.channel.id);
      const failedKey = session.activeCommandKey ?? ev.args[2];
      if (failedKey) session.completedCommands.set(failedKey, { status: 'failed' });
      session.activeCommandKey = undefined;
      await this.safeAri(() => this.opts.ari.hangup(ev.channel.id));
      await this.emitEvent(session, 'takeover-failed', { reason: 'failed' });
      log.warn('human bridge failed; keeping aida with caller');
      return;
    }
    if (session.ending || session.humanChannelId !== ev.channel.id) return;
    log.info('human answered and bridged');

    const key = session.activeCommandKey ?? ev.args[2];
    if (key) {
      session.completedCommands.set(key, { status: 'answered' });
      session.activeCommandKey = undefined;
    }
    // Arm before publishing: a fast ACK or slow control delivery cannot lose
    // the drain deadline. Aida can finish the outro with both parties bridged.
    const deadlineMs = this.startDrain(session);
    await this.emitEvent(session, 'answered');
    if (!session.ending) await this.emitEvent(session, 'bridged', { deadlineMs });
  }

  private startDrain(session: CallSession): number {
    if (session.drainTimer) clearTimeout(session.drainTimer);
    const deadlineMs = Date.now() + this.opts.drainTimeoutMs;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = undefined;
      void this.removeAida(session, 'drain-deadline');
    }, this.opts.drainTimeoutMs);
    return deadlineMs;
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
    if (session.humanAnswered && !session.livekitChannelId) await this.closeScreening(session);
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
    if (livekitId) {
      session.livekitChannelId = undefined;
      this.channelToSession.delete(livekitId);
      if (session.bridgeId) {
        await this.safeAri(() => this.opts.ari.removeFromBridge(session.bridgeId as string, livekitId));
      }
      await this.safeAri(() => this.opts.ari.hangup(livekitId));
    }
    // Empty-room expiry cannot reap a room containing an orphan SIP leg.
    // DeleteRoom is also a backstop if the ARI leg was already lost.
    await this.closeScreening(session);
    if (session.ending) return;
    this.log(session).info('aida drained', { reason });
    await this.emitEvent(session, 'aida-drained', { reason });
  }

  private async closeScreening(session: CallSession): Promise<void> {
    if (session.screeningClosed) return;
    if (session.screeningCleanup) return session.screeningCleanup;
    session.screeningCleanup = (async () => {
      try {
        await this.opts.closeScreening?.(session.callSessionId);
        session.screeningClosed = true;
      } catch {
        this.log(session).warn('screening room cleanup failed');
      }
    })();
    try { await session.screeningCleanup; }
    finally { session.screeningCleanup = undefined; }
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
      if (session.humanAnswered) {
        if (session.drainTimer) clearTimeout(session.drainTimer);
        session.drainTimer = undefined;
        await this.removeAida(session, 'livekit-leg-ended');
      }
      if (!session.humanAnswered && !session.ending && !session.fellBack) {
        // Aida died mid-screening with no takeover done. The event is
        // recorded so an operator or handset can command a takeover. The
        // caller stays up (dialplan fallback only covers pre-Stasis).
        this.log(session).warn('aida leg lost during screening');
        await this.emitEvent(session, 'aida-lost');
        if (this.opts.nativeAdmission) {
          await this.opts.nativeAdmission.failed(callSessionId).catch(() => {});
          await this.fallback(callSessionId).catch(() => {});
        }
      }
      return;
    }
  }

  private async onHumanGone(session: CallSession, ev: ChannelDestroyedEvent): Promise<void> {
    const log = this.log(session);
    if (!session.humanAnswered) {
      // Ring failed: busy / rejected / no-answer. Caller stays with Aida.
      const reason: TakeoverFailureReason = CAUSE_TO_REASON[ev.cause] ?? 'failed';
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
    session.ending = true;
    const during = session.drainTimer ? 'drain' : 'bridged';
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = undefined;
    }
    // An answered handset owns the call, including during the drain window.
    // Hang up first: event storage or room cleanup must not keep the caller up.
    log.info('human hung up after takeover; ending call');
    if (session.callerChannelId) {
      await this.safeAri(() => this.opts.ari.hangup(session.callerChannelId as string));
    }
    if (session.livekitChannelId) await this.safeAri(() => this.opts.ari.hangup(session.livekitChannelId!));
    await this.closeScreening(session);
    await this.emitEvent(session, 'human-hangup', { during });
  }

  private async onCallerGone(session: CallSession): Promise<void> {
    session.ending = true;
    await this.stopMoh(session);
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
    await this.closeScreening(session);
    await this.emitEvent(session, 'hangup');
    await this.opts.nativeAdmission?.ended(session.callSessionId).catch(() => {});
    this.cleanupSession(session);
  }

  /** Return the existing caller to PBX dialplan. Never touch an established human bridge. */
  async fallback(callSessionId: string): Promise<void> {
    const session = this.sessions.get(callSessionId);
    if (!session?.callerChannelId || !session.callerEntered) return; // pre-Stasis failure is handled by the PBX wrapper
    if (session.fallbackWork) return session.fallbackWork;
    if (session.humanAnswered || session.ending || session.fellBack) return;
    session.fallbackInProgress = true;
    const callerId = session.callerChannelId;
    const work = (async () => {
      try {
        const target = session.fallbackTarget ?? (this.opts.nativeAdmission ? await this.opts.nativeAdmission.fallbackTarget(callSessionId) : { context: 'aida-post-bootstrap', exten: 's' });
        if (!target) throw new Error('native fallback unavailable');
        const ari = this.opts.ari;
        await this.stopMoh(session);
        await ari.setChannelVar(callerId, 'AIDA_DISPOSITION', 'FALLBACK');
        if (session.bridgeId) await ari.removeFromBridge(session.bridgeId, callerId);
        await ari.continueInDialplan(callerId, target.context, target.exten);
        session.fellBack = true;
        // Keep caller correlation until ChannelDestroyed records actual telephone completion.
        for (const id of [session.livekitChannelId, session.humanChannelId]) {
          if (id) { this.channelToSession.delete(id); await this.safeAri(() => ari.hangup(id)); }
        }
        session.livekitChannelId = undefined; session.humanChannelId = undefined;
        await this.closeScreening(session);
        await this.emitEvent(session, 'pbx-fallback');
      } finally { session.fallbackInProgress = false; session.fallbackWork = undefined; }
    })();
    session.fallbackWork = work;
    return work;
  }

  private cleanupSession(session: CallSession): void {
    if (session.drainTimer) clearTimeout(session.drainTimer);
    if (session.mohTimer) clearTimeout(session.mohTimer);
    for (const id of [session.callerChannelId, session.livekitChannelId, session.humanChannelId]) {
      if (id) this.channelToSession.delete(id);
    }
    this.sessions.delete(session.callSessionId);
  }

  private async stopMoh(session: CallSession): Promise<void> {
    if (session.mohTimer) {
      clearTimeout(session.mohTimer);
      session.mohTimer = undefined;
    }
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
        session.callerEntered = channel.dialplan?.app_name === 'Stasis';
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
    // A reconnect must not strand LiveKit alongside an established human call.
    for (const session of this.sessions.values()) {
      if (session.humanAnswered && session.livekitChannelId && !session.drainTimer) this.startDrain(session);
    }
    if (this.opts.nativeAdmission) for (const session of this.sessions.values()) {
      if (!session.humanAnswered) {
        await this.opts.nativeAdmission.failed(session.callSessionId).catch(() => {});
        await this.fallback(session.callSessionId).catch(() => {});
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
