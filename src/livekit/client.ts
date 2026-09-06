import type { Logger } from '../logging/logger.js';
import { UpstreamError } from '../errors.js';
import { signAccessToken } from './token.js';

/**
 * LiveKit Cloud control surface owned by this service (issue #9): room
 * creation, `aida-prime` agent dispatch, and server-side data publishing.
 *
 * Media never traverses this service — Asterisk's existing SIP trunk
 * carries audio directly to LiveKit. Only control calls happen here.
 *
 * Model, STT, TTS, and voice defaults are INHERITED from the predefined
 * `aida-prime` agent and are deliberately never sent: the POC contract
 * keeps them out of per-call metadata.
 */

/** The only fields allowed into agent dispatch metadata. */
export interface CallMetadata {
  callSessionId: string;
  tenantId: string;
  businessName: string;
  prompt: string;
  tone?: string;
  objective?: string;
  openingStatement?: string;
  transferStatement?: string;
  failedTransferStatement?: string;
  locale: string;
  didE164: string;
}

export interface DispatchResult {
  roomName: string;
  dispatchId?: string;
}

export interface LiveKitApi {
  createRoom(roomName: string): Promise<void>;
  dispatchAidaPrime(roomName: string, metadata: CallMetadata): Promise<DispatchResult>;
  publishData(roomName: string, topic: string, payload: Record<string, unknown>): Promise<void>;
  listParticipants(roomName: string): Promise<Array<{ sid: string; identity: string; kind?: string }>>;
  ping(): Promise<boolean>;
}

export interface LiveKitClientOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Empty-room timeout in seconds; LiveKit reaps the room after this. */
  emptyTimeoutSeconds?: number;
}

/**
 * Restricts per-call metadata to the allowlist above. Anything else an
 * upstream table might grow — identity ids, secrets, internal notes —
 * cannot reach the agent through this path.
 */
export function buildCallMetadata(input: CallMetadata): CallMetadata {
  return {
    callSessionId: input.callSessionId,
    tenantId: input.tenantId,
    businessName: input.businessName,
    prompt: input.prompt,
    tone: input.tone,
    objective: input.objective,
    openingStatement: input.openingStatement,
    transferStatement: input.transferStatement,
    failedTransferStatement: input.failedTransferStatement,
    locale: input.locale,
    didE164: input.didE164,
  };
}

/** Base of the LiveKit HTTP (twirp) API derived from the ws:// project URL. */
function httpBase(url: string): string {
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '');
}

export class LiveKitClient implements LiveKitApi {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: LiveKitClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = httpBase(opts.url);
  }

  private token(video: Record<string, unknown>): string {
    return signAccessToken(this.opts.apiKey, this.opts.apiSecret, {
      identity: 'officepulse-integration',
      ttlSeconds: 300,
      video,
    });
  }

  private async twirp(service: string, method: string, body: unknown, video: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/twirp/livekit.${service}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token(video)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new UpstreamError(`LiveKit ${service}/${method} returned ${res.status}`, 'livekit');
      }
      const text = await res.text();
      return text.trim() === '' ? undefined : JSON.parse(text);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`LiveKit ${service}/${method} timed out after ${this.opts.timeoutMs}ms`, 'livekit');
      }
      throw new UpstreamError(`LiveKit ${service}/${method} unreachable: ${(err as Error).message}`, 'livekit');
    } finally {
      clearTimeout(timer);
    }
  }

  async createRoom(roomName: string): Promise<void> {
    await this.twirp(
      'RoomService',
      'CreateRoom',
      { name: roomName, empty_timeout: this.opts.emptyTimeoutSeconds ?? 300 },
      { roomCreate: true, roomList: true },
    );
  }

  async dispatchAidaPrime(roomName: string, metadata: CallMetadata): Promise<DispatchResult> {
    const result = (await this.twirp(
      'AgentDispatchService',
      'CreateDispatch',
      {
        room: roomName,
        agent_name: this.opts.agentName,
        metadata: JSON.stringify(buildCallMetadata(metadata)),
      },
      { roomAdmin: true, room: roomName, agent: true },
    )) as { id?: string } | undefined;
    this.opts.logger.info('aida-prime dispatched', { roomName, callSessionId: metadata.callSessionId });
    return { roomName, dispatchId: result?.id };
  }

  async publishData(roomName: string, topic: string, payload: Record<string, unknown>): Promise<void> {
    await this.twirp(
      'RoomService',
      'SendData',
      {
        room: roomName,
        data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        kind: 'RELIABLE',
        topic,
      },
      { roomAdmin: true, room: roomName },
    );
  }

  async listParticipants(roomName: string): Promise<Array<{ sid: string; identity: string; kind?: string }>> {
    const result = (await this.twirp('RoomService', 'ListParticipants', { room: roomName }, {
      roomAdmin: true,
      room: roomName,
    })) as { participants?: Array<{ sid: string; identity: string; kind?: string }> } | undefined;
    return result?.participants ?? [];
  }

  async ping(): Promise<boolean> {
    try {
      await this.twirp('RoomService', 'ListRooms', { names: [] }, { roomList: true });
      return true;
    } catch {
      return false;
    }
  }

  async listRooms(): Promise<string[]> {
    const result = await this.twirp('RoomService', 'ListRooms', {}, { roomList: true }) as { rooms?: Array<{ name: string }> };
    return (result?.rooms ?? []).map((room) => room.name);
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    await this.twirp('RoomService', 'RemoveParticipant', { room: roomName, identity }, { roomAdmin: true, room: roomName });
  }
}
