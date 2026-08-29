import { EventEmitter } from 'node:events';
import type { AriApi, AriBridge, AriChannel, OriginateParams } from '../../src/ari/types.js';

/**
 * Fake ARI transport for takeover tests. Records every operation and
 * lets the test drive events (StasisStart, ChannelDestroyed, …) exactly
 * as the real WebSocket would.
 */
export class FakeAri extends EventEmitter implements AriApi {
  originates: OriginateParams[] = [];
  hangups: Array<{ channelId: string; reason?: string }> = [];
  bridges = new Map<string, { type: string; channels: Set<string> }>();
  mohStarts: Array<{ bridgeId: string; mohClass: string }> = [];
  mohStops: string[] = [];
  answered: string[] = [];
  removedFromBridge: Array<{ bridgeId: string; channelId: string }> = [];
  channelVars = new Map<string, Map<string, string>>();
  liveChannels = new Map<string, AriChannel>();
  /** Channels returned by originate(), in call order. */
  originatedChannels: AriChannel[] = [];
  private nextId = 1;

  setVar(channelId: string, name: string, value: string): void {
    if (!this.channelVars.has(channelId)) this.channelVars.set(channelId, new Map());
    this.channelVars.get(channelId)?.set(name, value);
  }

  makeChannel(id: string, state = 'Up', callerNumber?: string): AriChannel {
    const channel: AriChannel = { id, name: `TEST/${id}`, state, caller: { number: callerNumber } };
    this.liveChannels.set(id, channel);
    return channel;
  }

  async originate(params: OriginateParams): Promise<AriChannel> {
    this.originates.push(params);
    const id = `orig-${this.nextId++}`;
    for (const [name, value] of Object.entries(params.variables ?? {})) this.setVar(id, name, value);
    const channel = this.makeChannel(id, 'Down');
    this.originatedChannels.push(channel);
    return channel;
  }

  async answer(channelId: string): Promise<void> {
    this.answered.push(channelId);
  }

  async hangup(channelId: string, reason?: string): Promise<void> {
    this.hangups.push({ channelId, reason });
  }

  async createBridge(type: string): Promise<AriBridge> {
    const id = `bridge-${this.nextId++}`;
    this.bridges.set(id, { type, channels: new Set() });
    return { id, bridge_type: type, channels: [] };
  }

  async addToBridge(bridgeId: string, channelId: string): Promise<void> {
    this.bridges.get(bridgeId)?.channels.add(channelId);
  }

  async removeFromBridge(bridgeId: string, channelId: string): Promise<void> {
    this.removedFromBridge.push({ bridgeId, channelId });
    this.bridges.get(bridgeId)?.channels.delete(channelId);
  }

  async startBridgeMoh(bridgeId: string, mohClass: string): Promise<void> {
    this.mohStarts.push({ bridgeId, mohClass });
  }

  async stopBridgeMoh(bridgeId: string): Promise<void> {
    this.mohStops.push(bridgeId);
  }

  async getChannelVar(channelId: string, name: string): Promise<string | undefined> {
    return this.channelVars.get(channelId)?.get(name);
  }

  async setChannelVar(channelId: string, name: string, value: string): Promise<void> {
    this.setVar(channelId, name, value);
  }

  async listChannels(): Promise<AriChannel[]> {
    return [...this.liveChannels.values()];
  }

  async listBridges(): Promise<AriBridge[]> {
    return [...this.bridges.entries()].map(([id, b]) => ({ id, bridge_type: b.type, channels: [...b.channels] }));
  }

  // ---- event drivers -------------------------------------------------

  emitStasisStart(args: string[], channel: AriChannel): void {
    this.emit('StasisStart', { type: 'StasisStart', args, channel });
  }

  emitStateChange(channel: AriChannel, state: string): void {
    channel.state = state;
    this.emit('ChannelStateChange', { type: 'ChannelStateChange', channel: { ...channel, state } });
  }

  emitDestroyed(channel: AriChannel, cause: number): void {
    this.liveChannels.delete(channel.id);
    this.emit('ChannelDestroyed', { type: 'ChannelDestroyed', cause, channel });
  }
}

/** Event sink recording everything the manager reports to AidaControl. */
export class FakeEventSink {
  events: Array<{ callSessionId: string; eventType: string; idempotencyKey: string; payload?: Record<string, unknown> }> = [];

  async postCallEvent(
    callSessionId: string,
    event: { eventType: string; occurredAt: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<boolean> {
    this.events.push({ callSessionId, eventType: event.eventType, idempotencyKey: event.idempotencyKey, payload: event.payload });
    return true;
  }

  types(): string[] {
    return this.events.map((e) => e.eventType);
  }
}
