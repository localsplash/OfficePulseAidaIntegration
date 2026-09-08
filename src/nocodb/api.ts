import { UpstreamError } from '../errors.js';

/** Read-only NocoDB client used for scoped PlatformConfig settings discovery. */

export const AIDA_BASE_NAME = 'PlatformConfig';



export type NocoRecord = Record<string, unknown>;

export interface NocoWhere {
  field: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}

export interface NocoReadApi {
  listRecords(table: string, where: NocoWhere[], limit?: number): Promise<NocoRecord[]>;
  /** Reachability probe for readiness reporting. */
  ping(): Promise<boolean>;
}

export class BaseResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseResolutionError';
  }
}

function whereClause(where: readonly NocoWhere[]): string {
  return where.map((w) => `(${w.field},${w.op},${String(w.value)})`).join('~and');
}

export interface NocoDbReadClientOptions {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Overrides the settings base name; default is PlatformConfig. */
  baseName?: string;
}

export class NocoDbReadClient implements NocoReadApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseName: string;
  private baseIdPromise?: Promise<string>;
  private tableIdsPromise?: Promise<Map<string, string>>;
  private resolvedAt = 0;

  constructor(private readonly opts: NocoDbReadClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseName = opts.baseName ?? AIDA_BASE_NAME;
  }

  /**
   * Drops memoized base/table ids. Called when a lookup fails so a base
   * recreated or re-shared by AidaAdmin is picked up without a restart.
   */
  invalidate(): void {
    this.baseIdPromise = undefined;
    this.tableIdsPromise = undefined;
  }

  private async request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(new URL(path, this.opts.baseUrl), {
        headers: { 'xc-token': this.opts.apiToken, 'content-type': 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Bodies can echo request content; never attach them to the error.
        throw new UpstreamError(`NocoDB ${path.split('?')[0]} returned ${res.status}`, 'nocodb');
      }
      return res.status === 204 ? null : await res.json();
    } catch (err) {
      this.invalidate();
      if (err instanceof UpstreamError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`NocoDB request timed out after ${this.opts.timeoutMs}ms`, 'nocodb');
      }
      throw new UpstreamError(`NocoDB unreachable: ${(err as Error).message}`, 'nocodb');
    } finally {
      clearTimeout(timer);
    }
  }

  private async listPages<T>(path: string, maximum = 10_000): Promise<T[]> {
    const rows: T[] = [];
    let next = path;
    for (let page = 0; page < 100; page++) {
      const body = await this.request(next) as { list?: T[]; pageInfo?: { isLastPage?: boolean; totalRows?: number } };
      const batch = body.list ?? [];
      rows.push(...batch);
      if (rows.length >= maximum || batch.length === 0 || body.pageInfo?.isLastPage === true ||
        (body.pageInfo?.isLastPage === undefined && (!body.pageInfo?.totalRows || rows.length >= body.pageInfo.totalRows))) return rows.slice(0, maximum);
      const url = new URL(path, this.opts.baseUrl);
      url.searchParams.set('offset', String(rows.length));
      next = url.pathname + url.search;
    }
    throw new UpstreamError('NocoDB pagination exceeded safety bound', 'nocodb');
  }

  private resolveBaseId(): Promise<string> {
    this.baseIdPromise ??= (async () => {
      const bases = await this.listPages<{ id: string; title: string }>('/api/v2/meta/bases');
      const matches = bases.filter(
        (base) => base.title.trim().toLowerCase() === this.baseName.toLowerCase(),
      );
      if (matches.length === 0) {
        throw new BaseResolutionError(
          `NocoDB has no base named ${this.baseName}. The platform deployment owns and creates it; this service only reads it.`,
        );
      }
      if (matches.length > 1) {
        throw new BaseResolutionError(
          `NocoDB has ${matches.length} bases named ${this.baseName}. Exactly one is required — an operator must rename or remove the duplicates.`,
        );
      }
      return (matches[0] as { id: string }).id;
    })().catch((err) => {
      this.baseIdPromise = undefined; // never memoize a failure
      throw err;
    });
    return this.baseIdPromise;
  }

  private resolveTableIds(): Promise<Map<string, string>> {
    this.tableIdsPromise ??= (async () => {
      const baseId = await this.resolveBaseId();
      const tables = await this.listPages<{ id: string; table_name: string; title?: string }>(`/api/v2/meta/bases/${baseId}/tables`);
      const ids = new Map<string, string>();
      for (const table of tables) for (const name of new Set([table.table_name, table.title].filter((n): n is string => !!n))) {
        if (ids.has(name) && ids.get(name) !== table.id) throw new BaseResolutionError(`duplicate NocoDB table ${name}`);
        ids.set(name, table.id);
      }
      return ids;
    })().catch((err) => {
      this.tableIdsPromise = undefined;
      throw err;
    });
    return this.tableIdsPromise;
  }

  async listRecords(table: string, where: NocoWhere[], limit = 200): Promise<NocoRecord[]> {
    if (Date.now() - this.resolvedAt >= 30_000) { this.invalidate(); this.resolvedAt = Date.now(); }
    const tableIds = await this.resolveTableIds();
    const tableId = tableIds.get(table);
    if (!tableId) {
      this.invalidate(); // the base may have gained the table since we looked
      throw new UpstreamError(`NocoDB base ${this.baseName} has no table '${table}'`, 'nocodb');
    }
    const params = new URLSearchParams({ limit: String(Math.min(limit, 200)) });
    if (where.some((w) => !/^[A-Za-z0-9_]+$/.test(w.field) || !/^[A-Za-z0-9@+_*.:\-]{1,255}$/.test(String(w.value)))) throw new Error('invalid configuration lookup');
    if (where.length > 0) params.set('where', whereClause(where));
    const rows = await this.listPages<NocoRecord>(`/api/v2/tables/${tableId}/records?${params}`, limit);
    return rows;
  }

  async ping(): Promise<boolean> {
    try {
      await this.resolveTableIds();
      return true;
    } catch {
      this.invalidate();
      return false;
    }
  }
}
