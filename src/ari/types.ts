/** Minimal typed surface of the Asterisk REST Interface used by the POC. */

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller?: { name?: string; number?: string };
  dialplan?: { context?: string; exten?: string };
}

export interface AriBridge {
  id: string;
  bridge_type: string;
  channels: string[];
}

export interface AriEventBase {
  type: string;
  application?: string;
  timestamp?: string;
}

export interface StasisStartEvent extends AriEventBase {
  type: 'StasisStart';
  args: string[];
  channel: AriChannel;
}

export interface StasisEndEvent extends AriEventBase {
  type: 'StasisEnd';
  channel: AriChannel;
}

export interface ChannelStateChangeEvent extends AriEventBase {
  type: 'ChannelStateChange';
  channel: AriChannel;
}

export interface ChannelDestroyedEvent extends AriEventBase {
  type: 'ChannelDestroyed';
  cause: number;
  cause_txt?: string;
  channel: AriChannel;
}

export interface ChannelEnteredBridgeEvent extends AriEventBase {
  type: 'ChannelEnteredBridge';
  bridge: AriBridge;
  channel: AriChannel;
}

export interface ChannelLeftBridgeEvent extends AriEventBase {
  type: 'ChannelLeftBridge';
  bridge: AriBridge;
  channel: AriChannel;
}

export type AriEvent =
  | StasisStartEvent
  | StasisEndEvent
  | ChannelStateChangeEvent
  | ChannelDestroyedEvent
  | ChannelEnteredBridgeEvent
  | ChannelLeftBridgeEvent
  | (AriEventBase & Record<string, unknown>);

export interface OriginateParams {
  endpoint: string;
  appArgs: string;
  callerId?: string;
  timeoutSeconds?: number;
  variables?: Record<string, string>;
}

/**
 * The transport-level ARI operations the takeover manager needs.
 * Implemented by AriClient over REST/WebSocket; tests inject a fake.
 */
export interface AriApi {
  originate(params: OriginateParams): Promise<AriChannel>;
  answer(channelId: string): Promise<void>;
  hangup(channelId: string, reason?: string): Promise<void>;
  createBridge(type: string): Promise<AriBridge>;
  addToBridge(bridgeId: string, channelId: string): Promise<void>;
  removeFromBridge(bridgeId: string, channelId: string): Promise<void>;
  startBridgeMoh(bridgeId: string, mohClass: string): Promise<void>;
  stopBridgeMoh(bridgeId: string): Promise<void>;
  getChannelVar(channelId: string, name: string): Promise<string | undefined>;
  setChannelVar(channelId: string, name: string, value: string): Promise<void>;
  listChannels(): Promise<AriChannel[]>;
  listBridges(): Promise<AriBridge[]>;
  on(event: string, listener: (ev: AriEvent) => void): void;
  off(event: string, listener: (ev: AriEvent) => void): void;
}
