import net from 'node:net';
import { AgiSession } from './agiSession.js';
import type { Logger } from '../logging/logger.js';

export type AgiHandler = (session: AgiSession) => Promise<void>;

export interface FastAgiServerOptions {
  port: number;
  bind: string;
  maxConnections: number;
  sessionTimeoutMs: number;
  logger: Logger;
  handlers: Record<string, AgiHandler>;
}

/**
 * FastAGI TCP listener (private port 4573). Routes by agi_network_script
 * (the path of the agi:// URL in the dialplan) to a registered handler.
 *
 * Hardening: a hard cap on concurrent connections (excess connections are
 * refused immediately) and a per-session wall-clock deadline after which
 * the socket is destroyed — Asterisk then continues in the dialplan and
 * takes the local fallback path.
 */
export class FastAgiServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: FastAgiServerOptions) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.bind, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  address(): { port: number } | null {
    const addr = this.server.address();
    return addr && typeof addr === 'object' ? { port: addr.port } : null;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    if (this.sockets.size >= this.opts.maxConnections) {
      this.opts.logger.warn('fastagi connection refused: connection limit reached', {
        limit: this.opts.maxConnections,
      });
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);

    const deadline = setTimeout(() => {
      this.opts.logger.warn('fastagi session exceeded deadline; destroying socket');
      socket.destroy();
    }, this.opts.sessionTimeoutMs);

    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
    socket.on('error', () => {
      /* handled via close */
    });

    void this.serve(socket);
  }

  private async serve(socket: net.Socket): Promise<void> {
    let session: AgiSession | undefined;
    try {
      session = await AgiSession.create(socket, {
        envTimeoutMs: Math.min(this.opts.sessionTimeoutMs, 3000),
        commandTimeoutMs: Math.min(this.opts.sessionTimeoutMs, 3000),
      });
      const script = (session.env['agi_network_script'] ?? '').replace(/^\/+/, '');
      const handler = this.opts.handlers[script];
      if (!handler) {
        this.opts.logger.warn('fastagi request for unknown script', { script });
        session.end();
        return;
      }
      await handler(session);
    } catch (err) {
      this.opts.logger.warn('fastagi session failed', { err });
    } finally {
      try {
        session?.end();
      } catch {
        /* already closed */
      }
      socket.destroy();
    }
  }
}
