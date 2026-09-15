import type { NocoReadApi } from '../nocodb/api.js';
import type { Logger } from '../logging/logger.js';
import { profileSnapshot, type ProfileSnapshot } from './contract.js';

/**
 * Business configuration loaded outside the call path (issue #19).
 *
 * Admission, Agent credential consumption and active-call monitoring read
 * only this in-memory cache, so a PlatformConfig/Identity outage after a
 * successful load cannot interrupt or delay a call. Refresh runs on its own
 * timer; a failed refresh keeps the last good values rather than evicting them.
 */
export interface CachedProfile {
  profileId: string; profileRevision: number; businessName: string; prompt: string;
  tone?: string; objective?: string; openingStatement?: string; transferStatement?: string; failedTransferStatement?: string;
}
export interface ProfileLookup {
  /** Synchronous by contract: a caller cannot accidentally reintroduce call-path I/O. */
  get(tenantId: string): CachedProfile | undefined;
}
export interface ProfileSource {
  /** Resolves the single effective enabled profile, or undefined when absent/disabled/ambiguous. */
  profile(tenantId: string): Promise<CachedProfile | undefined>;
}
export type TenantEnabledCheck = (tenantId: string) => Promise<boolean>;

const OPTIONAL = ['tone', 'objective', 'openingStatement', 'transferStatement', 'failedTransferStatement'] as const;
/** Builds the per-call response from cached text. Mutable profile text is never re-resolved mid-call. */
export function cachedProfileSnapshot(entry: CachedProfile, call: { callSessionId: string; tenantId: string; didE164: string }): ProfileSnapshot {
  return profileSnapshot({ schemaVersion: 1, callSessionId: call.callSessionId, tenantId: call.tenantId, didE164: call.didE164,
    businessName: entry.businessName, prompt: entry.prompt, locale: 'en-US',
    ...Object.fromEntries(OPTIONAL.filter(key => entry[key] !== undefined).map(key => [key, entry[key]])) });
}

/** PlatformConfig reader used only by startup and background refresh. */
export function nocoProfileSource(noco: NocoReadApi, profileIds: ReadonlyMap<string, string>): ProfileSource {
  return { async profile(tenantId: string): Promise<CachedProfile | undefined> {
    const selected = profileIds.get(tenantId);
    const rows = await noco.listRecords('aida_tbl_AssistantProfile', [
      { field: 'iTenantId', op: 'eq', value: Number(tenantId) }, ...(selected ? [{ field: 'id', op: 'eq' as const, value: selected }] : []),
      { field: 'enabled', op: 'eq', value: true },
    ], 2);
    if (rows.length !== 1) return; // multiple enabled profiles require an explicit selection
    const r = rows[0]!;
    if (String(r.iTenantId) !== tenantId || ![true, 1, '1'].includes(r.enabled as boolean) ||
      !/^[A-Za-z0-9_.-]{1,60}$/.test(String(r.id)) || !Number.isSafeInteger(Number(r.revision))) return;
    const entry: CachedProfile = { profileId: String(r.id), profileRevision: Number(r.revision),
      businessName: String(r.business_name ?? ''), prompt: String(r.prompt ?? ''),
      ...Object.fromEntries(([['tone', r.tone], ['objective', r.objective], ['openingStatement', r.opening_statement],
        ['transferStatement', r.transfer_statement], ['failedTransferStatement', r.failed_transfer_statement]] as const)
        .filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) };
    // Validate with the Agent's strict allowlist now, so a call never fails on stored text.
    try { cachedProfileSnapshot(entry, { callSessionId: '00000000-0000-4000-8000-000000000000', tenantId, didE164: '+10000000000' }); }
    catch { return; }
    return entry;
  } };
}

export interface AgentConfigCacheOptions {
  tenantIds: readonly string[];
  source: ProfileSource;
  /** Optional Identity runtime check; never consulted on the call path. */
  tenantEnabled?: TenantEnabledCheck;
  refreshMs?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
}
export interface CacheStatus {
  configuredTenants: number; loadedTenants: string[]; complete: boolean;
  lastAttemptAt?: string; lastCompleteAt?: string; lastError?: string;
}
export class AgentConfigCache implements ProfileLookup {
  private readonly entries = new Map<string, CachedProfile>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private lastAttemptAt?: number; private lastCompleteAt?: number; private lastError?: string;
  constructor(private readonly opts: AgentConfigCacheOptions) { this.now = opts.now ?? Date.now; }
  get(tenantId: string): CachedProfile | undefined { return this.entries.get(tenantId); }
  status(): CacheStatus {
    const iso = (at?: number) => at === undefined ? undefined : new Date(at).toISOString();
    return { configuredTenants: this.opts.tenantIds.length, loadedTenants: [...this.entries.keys()].sort(),
      complete: this.opts.tenantIds.length > 0 && this.opts.tenantIds.every(id => this.entries.has(id)),
      ...(this.lastAttemptAt ? { lastAttemptAt: iso(this.lastAttemptAt) } : {}),
      ...(this.lastCompleteAt ? { lastCompleteAt: iso(this.lastCompleteAt) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  /**
   * One refresh pass. A thrown source/Identity error keeps the previous entry
   * (outage tolerance); an authoritative negative answer removes it, so a
   * revoked tenant or profile still fails closed at the next pass.
   */
  async refresh(): Promise<boolean> {
    this.lastAttemptAt = this.now();
    let failures = 0; let lastError: string | undefined;
    for (const tenantId of this.opts.tenantIds) {
      try {
        if (this.opts.tenantEnabled && !await this.opts.tenantEnabled(tenantId)) {
          if (this.entries.delete(tenantId)) this.opts.logger?.warn('tenant configuration revoked', { tenantId, reason: 'tenant-disabled' });
          continue;
        }
        const entry = await this.opts.source.profile(tenantId);
        if (!entry) {
          if (this.entries.delete(tenantId)) this.opts.logger?.warn('tenant configuration revoked', { tenantId, reason: 'no-single-enabled-profile' });
          continue;
        }
        const previous = this.entries.get(tenantId);
        this.entries.set(tenantId, entry);
        if (previous?.profileId !== entry.profileId || previous.profileRevision !== entry.profileRevision) {
          this.opts.logger?.info('tenant configuration cached', { tenantId, profileId: entry.profileId, profileRevision: entry.profileRevision });
        }
      } catch (error) {
        failures++;
        // Never attach the upstream body: it carries business prompt text.
        lastError = error instanceof Error ? error.name : 'unknown';
        this.opts.logger?.warn('configuration refresh failed; serving cached values', { tenantId, error: lastError, cached: this.entries.has(tenantId) });
      }
    }
    this.lastError = lastError;
    const complete = this.opts.tenantIds.length > 0 && failures === 0 && this.opts.tenantIds.every(id => this.entries.has(id));
    if (complete) this.lastCompleteAt = this.now();
    return complete;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.opts.refreshMs ?? 300_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
