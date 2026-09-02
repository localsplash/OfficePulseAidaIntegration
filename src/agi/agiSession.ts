import type net from 'node:net';

/**
 * One FastAGI session: parses the agi_* environment block Asterisk sends
 * on connect, then exchanges commands/responses over the same socket.
 *
 * Protocol notes:
 *  - Asterisk sends `agi_key: value` lines terminated by an empty line.
 *  - Each command we send gets one `NNN result=R [(data)]` response line.
 */

export interface AgiResponse {
  code: number;
  result: number;
  data?: string;
}

export class AgiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgiProtocolError';
  }
}

const RESPONSE_RE = /^(\d{3}) result=(-?\d+)(?: \((.*)\))?/;

function quoteAgiValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class AgiSession {
  readonly env: Readonly<Record<string, string>>;
  private buffer = '';
  private pending: Array<{ resolve: (r: AgiResponse) => void; reject: (e: Error) => void }> = [];
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    env: Record<string, string>,
    private readonly commandTimeoutMs: number,
  ) {
    this.env = env;
    socket.on('data', (chunk) => this.onData(chunk.toString('utf8')));
    socket.on('close', () => this.failPending(new AgiProtocolError('socket closed')));
    socket.on('error', () => this.failPending(new AgiProtocolError('socket error')));
  }

  /** Read the environment block, then hand back a live session. */
  static create(socket: net.Socket, opts: { envTimeoutMs: number; commandTimeoutMs: number }): Promise<AgiSession> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new AgiProtocolError('timeout reading AGI environment'));
      }, opts.envTimeoutMs);

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const end = buffer.indexOf('\n\n');
        if (end === -1) return;
        cleanup();
        const envBlock = buffer.slice(0, end);
        const rest = buffer.slice(end + 2);
        const env: Record<string, string> = {};
        for (const line of envBlock.split('\n')) {
          const sep = line.indexOf(':');
          if (sep === -1) continue;
          const key = line.slice(0, sep).trim();
          const value = line.slice(sep + 1).trim();
          if (key.startsWith('agi_')) env[key] = value;
        }
        if (Object.keys(env).length === 0) {
          reject(new AgiProtocolError('empty AGI environment'));
          socket.destroy();
          return;
        }
        const session = new AgiSession(socket, env, opts.commandTimeoutMs);
        if (rest.length > 0) session.onData(rest);
        resolve(session);
      };

      const onError = (): void => {
        cleanup();
        reject(new AgiProtocolError('socket error while reading AGI environment'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onError);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onError);
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      const waiter = this.pending.shift();
      if (!waiter) continue; // unsolicited line (e.g. HANGUP notification) — ignore
      const match = RESPONSE_RE.exec(line);
      if (!match) {
        waiter.reject(new AgiProtocolError(`unparseable AGI response: ${line.slice(0, 120)}`));
        continue;
      }
      waiter.resolve({ code: Number(match[1]), result: Number(match[2]), data: match[3] });
    }
  }

  private failPending(err: Error): void {
    this.closed = true;
    const waiters = this.pending;
    this.pending = [];
    for (const w of waiters) w.reject(err);
  }

  command(cmd: string): Promise<AgiResponse> {
    if (this.closed) return Promise.reject(new AgiProtocolError('session closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === wrappedResolve);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new AgiProtocolError(`timeout waiting for response to AGI command`));
      }, this.commandTimeoutMs);
      const wrappedResolve = (r: AgiResponse): void => {
        clearTimeout(timer);
        resolve(r);
      };
      const wrappedReject = (e: Error): void => {
        clearTimeout(timer);
        reject(e);
      };
      this.pending.push({ resolve: wrappedResolve, reject: wrappedReject });
      this.socket.write(cmd + '\n');
    });
  }

  async getVariable(name: string): Promise<string | undefined> {
    const res = await this.command(`GET VARIABLE ${name}`);
    if (res.code !== 200 || res.result !== 1) return undefined;
    return res.data ?? '';
  }

  async setVariable(name: string, value: string): Promise<void> {
    const res = await this.command(`SET VARIABLE ${name} ${quoteAgiValue(value)}`);
    if (res.code !== 200) throw new AgiProtocolError(`SET VARIABLE ${name} failed with code ${res.code}`);
  }

  async verbose(message: string): Promise<void> {
    await this.command(`VERBOSE ${quoteAgiValue(message)} 1`);
  }

  end(): void {
    this.closed = true;
    this.socket.end();
  }
}
