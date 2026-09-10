import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { OperationsConfig } from './config.js';
import type { OperationsIdentity } from './identity.js';
import type { InventoryReader, PbxTenantScopes } from '../pbx/inventory.js';
import type { RuntimeStore } from '../runtime/store.js';
import type { Readiness } from '../readiness.js';
import type { LivePbx } from './live.js';
import { html, css, javascript } from './view.js';
import { RateLimiter } from '../http/rateLimit.js';
import type { Route } from '../http/httpServer.js';
import { ValidationError } from '../errors.js';
import { OperationsAdminGateway } from './adminGateway.js';
import { serveOperationsDocumentation } from '../http/documentation.js';

const SESSION = '__Host-officepulse.sid';
const STATE = '__Host-officepulse.state';
const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
function readCookie(req: http.IncomingMessage, name: string): string {
  const matches = (req.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : '';
}
const csrf = (token: string) => createHash('sha256').update('officepulse-csrf:' + token).digest('hex');

export interface OperationsDependencies {
  identity: OperationsIdentity;
  readiness: Readiness;
  live: LivePbx;
  inventory?: InventoryReader;
  scopes: PbxTenantScopes;
  runtime: Pick<RuntimeStore, 'getCallSession' | 'listCallEvents'>;
  adminRoutes?: readonly Route[];
  now?: () => number;
}

/** Human browser boundary. Every data request revalidates central Super Admin access. */
export class OperationsServer {
  private readonly server: http.Server;
  private readonly states = new Map<string, number>();
  private readonly limiter = new RateLimiter(600);
  private readonly timer: NodeJS.Timeout;
  private readonly gateway: OperationsAdminGateway;
  constructor(private readonly config: OperationsConfig, private readonly deps: OperationsDependencies) {
    this.gateway = new OperationsAdminGateway(deps.adminRoutes ?? [], deps.runtime);
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.send(res, 503, { error: 'Operations dependency unavailable. Please retry.' });
      else res.end();
    }); });
    this.timer = setInterval(() => { this.sweep(); this.limiter.sweep(); }, 60_000);
    this.timer.unref();
  }
  private sweep() {
    for (const [state, expires] of this.states) if (expires <= (this.deps.now?.() ?? Date.now())) this.states.delete(state);
  }
  listen(port: number, bind: string): Promise<void> {
    return new Promise((resolve,reject) => { this.server.once('error',reject); this.server.listen(port,bind,() => { this.server.removeListener('error',reject);resolve(); }); });
  }
  address(): { port: number } { return this.server.address() as { port: number }; }
  async close(): Promise<void> { clearInterval(this.timer);this.states.clear();this.server.closeIdleConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve())); }
  private send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
    res.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }
  private redirect(res: http.ServerResponse, location: string) { res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });res.end(); }
  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 65_536) { const error = new Error('Request body is too large.') as Error & {status:number};error.status=413;throw error; }
      chunks.push(chunk as Buffer);
    }
    const raw=Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return undefined;
    try { return JSON.parse(raw); } catch { throw new ValidationError('Request body must be valid JSON.'); }
  }
  private sendGatewayError(res: http.ServerResponse, error: unknown) {
    const status=(error as {status?:number}).status ?? 500;
    const details=error instanceof ValidationError ? error.details : undefined;
    return this.send(res,status,{error:status >= 500 ? 'Internal API error.' : (error as Error).message,...(details?.length ? {details}: {})});
  }
  private validCsrf(req: http.IncomingMessage, token: string): boolean {
    const presented=req.headers['x-csrf-token'];
    return req.headers.origin===this.config.publicUrl && typeof presented==='string' && /^[a-f0-9]{64}$/.test(presented)
      && timingSafeEqual(Buffer.from(presented),Buffer.from(csrf(token)));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.config.publicUrl);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/') return this.send(res,200,html,'text/html');
    if (req.method === 'GET' && path === '/ops.css') return this.send(res,200,css,'text/css');
    if (req.method === 'GET' && path === '/ops.js') return this.send(res,200,javascript,'text/javascript');
    if (!this.limiter.allow(req.socket.remoteAddress ?? 'unknown')) return this.send(res,429,{error:'Please wait before retrying.'});
    const callback = this.config.publicUrl + '/ops/auth/callback';
    if (req.method === 'GET' && path === '/ops/auth/login') {
      this.sweep();
      if (this.states.size >= 10000) return this.send(res,503,{error:'Sign-in is temporarily busy.'});
      const state = randomBytes(32).toString('base64url');
      this.states.set(state,(this.deps.now?.() ?? Date.now())+300_000);
      res.setHeader('set-cookie',cookie(STATE,state,300));
      const target = new URL('/authorize',this.config.identityUrl);
      target.searchParams.set('redirect_uri',callback);target.searchParams.set('state',state);
      return this.redirect(res,target.toString());
    }
    if (req.method === 'GET' && path === '/ops/auth/callback') {
      const state = url.searchParams.get('state') ?? '', code = url.searchParams.get('code') ?? '';
      const expires = this.states.get(state) ?? 0;
      res.setHeader('set-cookie',cookie(STATE,'',0));
      if (!state || !code || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || readCookie(req,STATE) !== state || expires <= (this.deps.now?.() ?? Date.now()))
        return this.redirect(res,'/?login=error');
      this.states.delete(state);
      try {
        const token = await this.deps.identity.redeem(code,callback);
        const actor = await this.deps.identity.introspect(token);
        if (!actor.active || actor.user?.superAdmin !== true) {
          await this.deps.identity.revoke(token);
          return this.redirect(res,'/?login=denied');
        }
        res.setHeader('set-cookie',[cookie(STATE,'',0),cookie(SESSION,token,28800)]);
        return this.redirect(res,'/');
      } catch { return this.redirect(res,'/?login=error'); }
    }
    if (!path.startsWith('/ops/api/') && path !== '/ops/auth/logout' && !path.startsWith('/ops/docs') && path !== '/ops/openapi.json') return this.send(res,404,{error:'Not found'});
    const token = readCookie(req,SESSION);
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) return this.send(res,401,{error:'Sign in to continue.'});
    const actor = await this.deps.identity.introspect(token);
    if (!actor.active) { res.setHeader('set-cookie',cookie(SESSION,'',0));return this.send(res,401,{error:'Your session has ended. Sign in again.'}); }
    if (actor.user?.superAdmin !== true) return this.send(res,403,{error:'OfficePulse operations requires Super Admin access.'});
    if (await serveOperationsDocumentation(path,res)) return;
    if (path === '/ops/auth/logout' && req.method === 'POST') {
      if (!this.validCsrf(req,token)) return this.send(res,403,{error:'Invalid sign-out request.'});
      await this.deps.identity.revoke(token);
      res.setHeader('set-cookie',cookie(SESSION,'',0));return this.send(res,200,{ok:true});
    }
    const tenants = (actor.tenants ?? []).filter(t => t.bEnabled);
    if (path === '/ops/api/session' && req.method === 'GET') return this.send(res,200,{user:actor.user,csrfToken:csrf(token),
      tenants:tenants.map(t=>({id:t.iTenantId,name:t.name,mapped:this.deps.scopes.has(String(t.iTenantId))})),apiUrl:this.config.apiUrl});
    if (path === '/ops/api/status' && req.method === 'GET') return this.send(res,200,{dependencies:this.deps.readiness.snapshot(),pbx:await this.deps.live.snapshot(),observedAt:new Date().toISOString()});
    if (path.startsWith('/ops/api/v1/admin/')) {
      const method=(req.method ?? 'GET').toUpperCase();
      if (!['GET','HEAD','OPTIONS'].includes(method) && !this.validCsrf(req,token)) return this.send(res,403,{error:'Invalid API request origin or CSRF token.'});
      try {
        const result=await this.gateway.dispatch({method,path:path.slice('/ops/api'.length),query:url.searchParams,
          body:await this.readJson(req),headers:req.headers as Record<string,string|undefined>,clientIp:req.socket.remoteAddress ?? 'unknown',
          tenantIds:new Set(tenants.map(tenant=>String(tenant.iTenantId))),
          operator:{userId:actor.user.iUserId,email:actor.user.email}});
        return result ? this.send(res,result.status,result.body ?? {}) : this.send(res,404,{error:'API route is not enabled for browser access.'});
      } catch (error) { return this.sendGatewayError(res,error); }
    }
    if (req.method !== 'GET') return this.send(res,405,{error:'This operations route does not accept mutations.'});
    const match = /^\/ops\/api\/tenants\/([1-9][0-9]*)\/(extensions|queues|calls\/([A-Za-z0-9_.:-]{1,160}))$/.exec(path);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return this.send(res,404,{error:'Not found'});
    const tenantId=match[1]!,kind=match[2]!;
    if (!tenants.some(t=>String(t.iTenantId)===tenantId)) return this.send(res,403,{error:'Tenant access denied.'});
    if (kind.startsWith('calls/')) {
      const call=await this.deps.runtime.getCallSession(match[3]!);
      if (!call || String(call.tenantId)!==tenantId) return this.send(res,404,{error:'No observed integration call found for this tenant and ID.'});
      const events=await this.deps.runtime.listCallEvents(call.id);
      return this.send(res,200,{call:{id:call.id,tenantId:call.tenantId,state:call.state,disposition:call.disposition,
        callerNumber:call.callerNumber,didE164:call.didE164,createdAt:call.createdAt,endedAt:call.endedAt},
        events:events.map(e=>({eventType:e.eventType,sequenceNumber:e.sequenceNumber,createdAt:e.createdAt}))});
    }
    const scope=this.deps.scopes.get(tenantId);
    if (!scope || !this.deps.inventory) return this.send(res,503,{error:'Native PBX inventory is not mapped for this tenant.'});
    try {
      const result=kind==='extensions'?await this.deps.inventory.extensions(scope):await this.deps.inventory.queues(scope);
      return this.send(res,200,{source:'asterisk',iTenantId:Number(tenantId),[kind]:result});
    } catch { return this.send(res,503,{error:'Cannot read native PBX inventory. Check the PBX connection and tenant scope.'}); }
  }
}
