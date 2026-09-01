import { UpstreamError } from '../errors.js';

/**
 * Read-only NocoDB v2 client for the AidaAdmin configuration base.
 *
 * Writer/reader split (issue #9): AidaAdmin owns and writes this base;
 * OfficePulseAidaIntegration only reads it. This client therefore exposes
 * no create/update/delete surface at all — the absence is the safeguard.
 *
 * The base is addressed by NAME and discovered at runtime, matching how
 * AidaAdmin creates it. Unlike AidaAdmin, a missing base is NEVER created
 * here: this service is not the writer, and an auto-created empty base
 * would silently report that every DID is unrouted.
 */

export const AIDA_BASE_NAME = 'AidaAdmin';

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
  /** Overrides the base name; the deployment default is 'AidaAdmin'. */
  baseName?: string;
}

export class NocoDbReadClient implements NocoReadApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseName: string;
  private baseIdPromise?: Promise<string>;
  private tableIdsPromise?: Promise<Map<string, string>>;

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
      if (err instanceof UpstreamError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new UpstreamError(`NocoDB request timed out after ${this.opts.timeoutMs}ms`, 'nocodb');
      }
      throw new UpstreamError(`NocoDB unreachable: ${(err as Error).message}`, 'nocodb');
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveBaseId(): Promise<string> {
    this.baseIdPromise ??= (async () => {
      const body = (await this.request('/api/v2/meta/bases')) as { list?: Array<{ id: string; title: string }> };
      const matches = (body.list ?? []).filter(
        (base) => base.title.trim().toLowerCase() === this.baseName.toLowerCase(),
      );
      if (matches.length === 0) {
        throw new BaseResolutionError(
          `NocoDB has no base named ${this.baseName}. AidaAdmin owns and creates it; this service only reads it.`,
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
      const body = (await this.request(`/api/v2/meta/bases/${baseId}/tables`)) as {
        list?: Array<{ id: string; table_name: string }>;
      };
      return new Map((body.list ?? []).map((t) => [t.table_name, t.id]));
    })().catch((err) => {
      this.tableIdsPromise = undefined;
      throw err;
    });
    return this.tableIdsPromise;
  }

  async listRecords(table: string, where: NocoWhere[], limit = 200): Promise<NocoRecord[]> {
    const tableIds = await this.resolveTableIds();
    const tableId = tableIds.get(table);
    if (!tableId) {
      this.invalidate(); // the base may have gained the table since we looked
      throw new UpstreamError(`NocoDB base ${this.baseName} has no table '${table}'`, 'nocodb');
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (where.length > 0) params.set('where', whereClause(where));
    const body = (await this.request(`/api/v2/tables/${tableId}/records?${params}`)) as {
      list?: NocoRecord[];
    };
    return body.list ?? [];
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
