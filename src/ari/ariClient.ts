import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logging/logger.js';
import { UpstreamError } from '../errors.js';
import type { AriApi, AriBridge, AriChannel, AriEvent, OriginateParams } from './types.js';

export interface AriClientOptions {
  url: string;
  username: string;
  password: string;
  app: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  wsFactory?: (url: string) => WebSocket;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  onConnectionState?: (connected: boolean) => void;
}

/**
 * Private ARI client: REST over HTTP basic auth plus the events WebSocket
 * with automatic exponential-backoff reconnect. Events are re-emitted by
 * type ('StasisStart', 'ChannelDestroyed', …) and as a catch-all 'event'.
 * A 'connected' event fires after each (re)connect so owners can run
 * reconciliation.
 */
export class AriClient extends EventEmitter implements AriApi {
  private ws?: WebSocket;
  private stopped = false;
  private reconnectDelayMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AriClientOptions) {
    super();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.reconnectDelayMs = opts.reconnectMinMs ?? 500;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  private wsUrl(): string {
    const base = new URL(this.opts.url);
    const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = base.pathname.replace(/\/$/, '');
    return `${wsProto}//${base.host}${path}/events?app=${encodeURIComponent(this.opts.app)}&api_key=${encodeURIComponent(
      `${this.opts.username}:${this.opts.password}`,
    )}&subscribeAll=true`;
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.opts.wsFactory ?? ((url: string) => new WebSocket(url));
    let ws: WebSocket;
    try {
      ws = factory(this.wsUrl());
    } catch (err) {
      this.opts.logger.warn('ari websocket construction failed', { err });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = this.opts.reconnectMinMs ?? 500;
      this.opts.logger.info('ari websocket connected');
      this.opts.onConnectionState?.(true);
      this.emit('connected');
    });

    ws.on('message', (data) => {
      let event: AriEvent;
      try {
        event = JSON.parse(String(data)) as AriEvent;
      } catch {
        this.opts.logger.warn('ari event parse failure');
        return;
      }
      if (typeof event.type === 'string') this.emit(event.type, event);
      this.emit('event', event);
    });

    const onDown = (): void => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.opts.onConnectionState?.(false);
      this.emit('disconnected');
      this.scheduleReconnect();
    };
    ws.on('close', onDown);
    ws.on('error', (err) => {
      this.opts.logger.warn('ari websocket error', { err });
      ws.close();
      onDown();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.opts.reconnectMaxMs ?? 15_000);
    this.opts.logger.info('ari reconnect scheduled', { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private async request<T>(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
    const url = new URL(this.opts.url.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const auth = Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new UpstreamError(`ARI ${method} ${path} unreachable: ${(err as Error).message}`);
    }
    if (res.status >= 400) {
      throw new UpstreamError(`ARI ${method} ${path} returned ${res.status}`);
    }
    const text = await res.text();
    return (text.trim() === '' ? undefined : JSON.parse(text)) as T;
  }

  async originate(params: OriginateParams): Promise<AriChannel> {
    const query: Record<string, string> = {
      endpoint: params.endpoint,
      app: this.opts.app,
      appArgs: params.appArgs,
    };
    if (params.callerId) query.callerId = params.callerId;
    if (params.timeoutSeconds !== undefined) query.timeout = String(params.timeoutSeconds);
    return this.request<AriChannel>('POST', '/channels', query, params.variables ? { variables: params.variables } : undefined);
  }

  async answer(channelId: string): Promise<void> {
    await this.request('POST', `/channels/${encodeURIComponent(channelId)}/answer`);
  }

  async hangup(channelId: string, reason = 'normal'): Promise<void> {
    await this.request('DELETE', `/channels/${encodeURIComponent(channelId)}`, { reason });
  }

  async createBridge(type: string): Promise<AriBridge> {
    return this.request<AriBridge>('POST', '/bridges', { type });
  }

  async addToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.request('POST', `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, { channel: channelId });
  }

  async removeFromBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.request('POST', `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`, { channel: channelId });
  }

  async startBridgeMoh(bridgeId: string, mohClass: string): Promise<void> {
    await this.request('POST', `/bridges/${encodeURIComponent(bridgeId)}/moh`, { mohClass });
  }

  async stopBridgeMoh(bridgeId: string): Promise<void> {
    await this.request('DELETE', `/bridges/${encodeURIComponent(bridgeId)}/moh`);
  }

  async getChannelVar(channelId: string, name: string): Promise<string | undefined> {
    try {
      const out = await this.request<{ value?: string }>('GET', `/channels/${encodeURIComponent(channelId)}/variable`, {
        variable: name,
      });
      return out?.value === '' ? undefined : out?.value;
    } catch {
      return undefined;
    }
  }

  async setChannelVar(channelId: string, name: string, value: string): Promise<void> {
    await this.request('POST', `/channels/${encodeURIComponent(channelId)}/variable`, { variable: name, value });
  }

  async listChannels(): Promise<AriChannel[]> {
    return (await this.request<AriChannel[]>('GET', '/channels')) ?? [];
  }

  async listBridges(): Promise<AriBridge[]> {
    return (await this.request<AriBridge[]>('GET', '/bridges')) ?? [];
  }
}
