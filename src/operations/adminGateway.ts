import { randomUUID } from 'node:crypto';
import type { ApiRequest, ApiResponse, Route } from '../http/httpServer.js';
import type { RuntimeStore } from '../runtime/store.js';
import { ValidationError } from '../errors.js';

interface CompiledRoute extends Route { regex: RegExp; paramNames: string[] }

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const regex = route.pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) { paramNames.push(segment.slice(1));return '([^/]+)'; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { ...route, regex: new RegExp(`^${regex}$`), paramNames };
}

/** In-process, explicitly allowlisted bridge from a Super Admin browser to private Admin routes. */
export class OperationsAdminGateway {
  private readonly routes: CompiledRoute[];
  constructor(routes: readonly Route[], private readonly runtime: Pick<RuntimeStore, 'getCallSession'>) {
    this.routes = routes.filter(route => route.pattern.startsWith('/v1/admin/') && route.operationsAccess).map(compile);
  }

  async dispatch(input: {
    method: string; path: string; query: URLSearchParams; body: unknown;
    headers: Record<string, string | undefined>; clientIp: string; tenantIds: ReadonlySet<string>;
    operator: { userId: number; email: string | null };
  }): Promise<ApiResponse | undefined> {
    const route = this.routes.find(candidate => candidate.method === input.method && candidate.regex.test(input.path));
    if (!route) return undefined;
    const match = route.regex.exec(input.path)!;
    const params: Record<string, string> = {};
    try { route.paramNames.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1] ?? ''); }); }
    catch { throw new ValidationError('route parameter is not valid URL encoding'); }

    const access = route.operationsAccess!;
    if (access.scope === 'tenant-query') {
      const values = input.query.getAll(access.query);
      if (values.length !== 1 || !input.tenantIds.has(values[0]!)) return { status: 403, body: { error: 'Tenant access denied.' } };
    } else {
      const call = await this.runtime.getCallSession(params[access.param] ?? '');
      // Do not disclose whether a call belonging to another tenant exists.
      if (!call || !input.tenantIds.has(String(call.tenantId))) return { status: 404, body: { error: 'Call not found.' } };
    }

    const request: ApiRequest = { method: input.method, path: input.path, query: input.query, params,
      body: input.body, headers: input.headers, clientIp: input.clientIp, correlationId: randomUUID(), operator: input.operator };
    return route.handler(request);
  }
}
