import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger.js';
import type { Readiness } from '../readiness.js';
import { RateLimiter } from './rateLimit.js';
import { ipInCidrs, resolveClientIp } from '../net/cidr.js';
import { ConfigError, ValidationError } from '../errors.js';

export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  clientIp: string;
  correlationId: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

export type RouteHandler = (req: ApiRequest) => Promise<ApiResponse> | ApiResponse;

export interface Route {
  method: string;
  /** Path pattern like /v1/provisioning/extensions/:extensionId */
  pattern: string;
  handler: RouteHandler;
  /** CIDR-protected private route (default true for /v1/*). */
  trusted?: boolean;
}

export interface HttpApiOptions {
  logger: Logger;
  readiness: Readiness;
  trustedServerCidrs: readonly string[];
  trustedProxyCidrs: readonly string[];
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  routes: Route[];
  now?: () => number;
}

interface CompiledRoute extends Route {
  regex: RegExp;
  paramNames: string[];
}

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const regexSrc = route.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^${regexSrc}$`), paramNames };
}

/**
 * Private HTTP API server. Enforces, in order: client-IP resolution
 * (trusted-proxy aware), CIDR allowlist on /v1 routes, per-client rate
 * limiting, and a request body size cap — before any handler runs.
 * /healthz and /readyz stay unauthenticated for local orchestration.
 */
export class HttpApi {
  private readonly server: http.Server;
  private readonly routes: CompiledRoute[];
  private readonly limiter: RateLimiter;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly opts: HttpApiOptions) {
    this.routes = opts.routes.map(compile);
    this.limiter = new RateLimiter(opts.rateLimitPerMinute, opts.now);
    this.server = http.createServer((req, res) => {
      void this.dispatch(req, res);
    });
    this.sweepTimer = setInterval(() => this.limiter.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  listen(port: number, bind: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, bind, () => {
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
    clearInterval(this.sweepTimer);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown, correlationId: string): void {
    const payload = JSON.stringify(body ?? {});
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-aida-correlation-id': correlationId,
    });
    res.end(payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.opts.maxBodyBytes) {
        const err = new Error('request body too large') as Error & { status: number };
        err.status = 413;
        throw err;
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError('request body must be valid JSON');
    }
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const correlationId =
      (typeof req.headers['x-aida-correlation-id'] === 'string' && req.headers['x-aida-correlation-id']) || randomUUID();
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const log = this.opts.logger.child({ correlationId, method, path });

    try {
      if (path === '/healthz') {
        this.send(res, 200, { status: 'ok' }, correlationId);
        return;
      }
      if (path === '/readyz') {
        const ready = this.opts.readiness.allReady();
        this.send(res, ready ? 200 : 503, { ready, components: this.opts.readiness.snapshot() }, correlationId);
        return;
      }

      const xff = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined;
      const clientIp = resolveClientIp(req.socket.remoteAddress, xff, this.opts.trustedProxyCidrs);
      if (clientIp === null) {
        log.warn('request from unresolvable peer denied', { peer: req.socket.remoteAddress });
        this.send(res, 403, { error: 'forbidden' }, correlationId);
        return;
      }
      if (!ipInCidrs(clientIp, this.opts.trustedServerCidrs)) {
        log.warn('request outside trusted CIDRs denied', { clientIp });
        this.send(res, 403, { error: 'forbidden' }, correlationId);
        return;
      }
      if (!this.limiter.allow(clientIp)) {
        this.send(res, 429, { error: 'rate limit exceeded' }, correlationId);
        return;
      }

      for (const route of this.routes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(path);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1] ?? '');
        });
        const body = await this.readBody(req);
        const out = await route.handler({ method, path, params, body, clientIp, correlationId });
        this.send(res, out.status, out.body, correlationId);
        return;
      }

      this.send(res, 404, { error: 'not found' }, correlationId);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : 'internal error';
      if (status >= 500) {
        log.error('request failed', { err, status });
      } else {
        log.warn('request rejected', { err, status });
      }
      if (err instanceof ConfigError) {
        this.send(res, 500, { error: 'configuration error' }, correlationId);
        return;
      }
      const details = err instanceof ValidationError ? err.details : undefined;
      this.send(res, status, { error: status >= 500 ? 'internal error' : message, details }, correlationId);
    }
  }
}
