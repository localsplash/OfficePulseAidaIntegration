import type { OperationsConfig } from './config.js';

const text = (value: unknown): string => typeof value === 'string' ? value.slice(0,240) : '';
export interface LivePbx {
  snapshot(): Promise<unknown>;
}
/** Fixed GETs only. The deployed ARI account must also have read_only=yes. */
export class AriDiagnostics implements LivePbx {
  constructor(private readonly config?: OperationsConfig['ari']) {}
  async snapshot(): Promise<unknown> {
    if (!this.config) return { available: false, message: 'Live PBX diagnostics are not configured.' };
    const config = this.config;
    const get = async (path: string) => {
      const response = await fetch(config.url.replace(/\/$/, '') + path, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64') },
      });
      if (!response.ok) throw new Error('PBX diagnostics unavailable');
      return response.json() as Promise<any>;
    };
    try {
      const [info, endpoints, channels] = await Promise.all([get('/asterisk/info'), get('/endpoints'), get('/channels')]);
      if (!Array.isArray(endpoints) || !Array.isArray(channels)) throw new Error('Invalid ARI response');
      return { available: true, version: text(info?.system?.version), startedAt: text(info?.status?.startup_time),
        observedAt: new Date().toISOString(), truncated: endpoints.length > 1000 || channels.length > 1000,
        endpoints: endpoints.slice(0,1000).map(e => ({ technology: text(e.technology), name: text(e.resource),
          state: text(e.state), channelCount: Array.isArray(e.channel_ids) ? e.channel_ids.length : 0 })),
        channels: channels.slice(0,1000).map(c => ({ id: text(c.id), name: text(c.name), state: text(c.state),
          caller: text(c.caller?.number), connected: text(c.connected?.number), createdAt: text(c.creationtime) })),
      };
    } catch { return { available: false, message: 'Cannot read live Asterisk status. Check the read-only ARI connection.' }; }
  }
}
