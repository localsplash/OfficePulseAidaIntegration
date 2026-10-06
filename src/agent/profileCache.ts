import type { NocoReadApi } from '../nocodb/api.js';
import type { Logger } from '../logging/logger.js';
import { profileSnapshot, type ProfileSnapshot } from './contract.js';

/**
 * Business configuration loaded outside the call path (issue #19), keyed by
 * routing scope and DID (#22/#23): persisted `aida_tbl_ProfileAssignment`
 * rows managed through AidaAdmin replace the retired per-tenant map.
 *
 * Admission, Agent credential consumption and active-call monitoring read
 * only this in-memory cache, so a PlatformConfig/Identity outage after a
 * successful load cannot interrupt or delay a call. Refresh runs on its own
 * timer; a failed refresh keeps the last good values rather than evicting them.
 */
export interface CachedProfile {
  /** Customer identity pinned on the call for authorization; never a routing key. */
  tenantId: string; pbxInstanceId: string; context: string;
  /** E.164 for a DID-specific assignment; '' is the context default. */
  did: string;
  profileId: string; profileRevision: number; businessName: string; prompt: string;
  tone?: string; objective?: string; openingStatement?: string; transferStatement?: string; failedTransferStatement?: string;
}
export interface ProfileAssignment { tenantId: string; pbxInstanceId: string; context: string; did: string; profileId: string }
export interface ProfileLookup {
  /** Synchronous by contract: a caller cannot accidentally reintroduce call-path I/O. */
  get(context: string, did: string): CachedProfile | undefined;
}
export interface ProfileSource {
  /** Enabled assignment rows of this PBX instance. Throws on outage; never returns a partial list. */
  assignments(): Promise<ProfileAssignment[]>;
  /** The assigned profile, or undefined when absent/disabled/tenant-mismatched/invalid (an authoritative negative). Throws on outage. */
  profile(assignment: ProfileAssignment): Promise<CachedProfile | undefined>;
}
export type TenantEnabledCheck = (tenantId: string) => Promise<boolean>;
/** Cache key: context and DID joined with a NUL separator; '' selects the context default. */
export const assignmentKey = (context: string, did: string): string => `${context}\0${did}`;
const enabled = (value: unknown): boolean => [true, 1, '1'].includes(value as boolean);
const OPTIONAL = ['tone', 'objective', 'openingStatement', 'transferStatement', 'failedTransferStatement'] as const;
/** Builds the per-call response from cached text. Mutable profile text is never re-resolved mid-call. */
export function cachedProfileSnapshot(entry: CachedProfile, call: { callSessionId: string; didE164: string }): ProfileSnapshot {
  return profileSnapshot({ schemaVersion: 2, callSessionId: call.callSessionId, pbxInstanceId: entry.pbxInstanceId, context: entry.context, tenantId: entry.tenantId,
    didE164: call.didE164, businessName: entry.businessName, prompt: entry.prompt, locale: 'en-US',
    ...Object.fromEntries(OPTIONAL.filter(key => entry[key] !== undefined).map(key => [key, entry[key]])) });
}

/** PlatformConfig reader used only by startup and background refresh. */
export function nocoProfileSource(noco: NocoReadApi, pbxInstanceId: string): ProfileSource {
  return {
    async assignments(): Promise<ProfileAssignment[]> {
      const rows = await noco.listRecords('aida_tbl_ProfileAssignment', [{ field: 'pbx_instance_id', op: 'eq', value: pbxInstanceId }], 1000);
      // Enablement is evaluated here, not pushed into the query: the column is
      // stored as 1/0, and a `(enabled,eq,true)` filter silently matches nothing.
      // NocoDB returns null for an empty did; '' is the context default.
      return rows.filter(r => enabled(r.enabled) && String(r.pbx_instance_id) === pbxInstanceId).map(r => ({
        tenantId: String(r.iTenantId ?? ''), pbxInstanceId, context: String(r.context ?? ''), did: r.did == null ? '' : String(r.did), profileId: String(r.profile_id ?? '') }));
    },
    async profile(a: ProfileAssignment): Promise<CachedProfile | undefined> {
      const rows = await noco.listRecords('aida_tbl_AssistantProfile', [{ field: 'id', op: 'eq', value: a.profileId }], 2);
      if (rows.length !== 1) return; // absent, or an ambiguous duplicate id
      const r = rows[0]!;
      // The profile must belong to the assignment's customer; a mismatch is a misconfiguration, not a routing choice.
      if (String(r.id) !== a.profileId || !enabled(r.enabled) || String(r.iTenantId) !== a.tenantId || !Number.isSafeInteger(Number(r.revision))) return;
      const entry: CachedProfile = { tenantId: a.tenantId, pbxInstanceId: a.pbxInstanceId, context: a.context, did: a.did,
        profileId: a.profileId, profileRevision: Number(r.revision),
        businessName: String(r.business_name ?? ''), prompt: String(r.prompt ?? ''),
        ...Object.fromEntries(([['tone', r.tone], ['objective', r.objective], ['openingStatement', r.opening_statement],
          ['transferStatement', r.transfer_statement], ['failedTransferStatement', r.failed_transfer_statement]] as const)
          .filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) };
      // Validate with the Agent's strict allowlist now, so a call never fails on stored text.
      try { cachedProfileSnapshot(entry, { callSessionId: '00000000-0000-4000-8000-000000000000', didE164: '+10000000000' }); }
      catch { return; }
      return entry;
    },
  };
}

export interface AgentConfigCacheOptions {
  source: ProfileSource;
  /** Optional Identity runtime check; never consulted on the call path. */
  tenantEnabled?: TenantEnabledCheck;
  refreshMs?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
}
export interface CacheStatus {
  configuredAssignments: number; loadedKeys: string[]; complete: boolean;
  lastAttemptAt?: string; lastCompleteAt?: string; lastError?: string;
}
const GRAMMAR = { tenantId: /^[1-9][0-9]*$/, context: /^[a-zA-Z0-9_.-]{1,40}$/, did: /^(?:|\+[1-9][0-9]{6,14})$/, profileId: /^[A-Za-z0-9_.-]{1,60}$/ } as const;
const valid = (a: ProfileAssignment): boolean => (Object.keys(GRAMMAR) as (keyof typeof GRAMMAR)[]).every(key => GRAMMAR[key].test(a[key])) && Number.isSafeInteger(Number(a.tenantId));
const scope = (key: string) => { const [context, did] = key.split('\0'); return { context, did: did || null }; };
export class AgentConfigCache implements ProfileLookup {
  private readonly entries = new Map<string, CachedProfile>();
  private configured = new Set<string>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private lastAttemptAt?: number; private lastCompleteAt?: number; private lastError?: string;
  constructor(private readonly opts: AgentConfigCacheOptions) { this.now = opts.now ?? Date.now; }
  get(context: string, did: string): CachedProfile | undefined { return this.entries.get(assignmentKey(context, did)); }
  status(): CacheStatus {
    const iso = (at?: number) => at === undefined ? undefined : new Date(at).toISOString();
    return { configuredAssignments: this.configured.size, loadedKeys: [...this.entries.keys()].sort(),
      complete: this.configured.size > 0 && [...this.configured].every(key => this.entries.has(key)),
      ...(this.lastAttemptAt ? { lastAttemptAt: iso(this.lastAttemptAt) } : {}),
      ...(this.lastCompleteAt ? { lastCompleteAt: iso(this.lastCompleteAt) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  /**
   * One refresh pass. A thrown source/Identity error keeps the previous entries
   * (outage tolerance); an authoritative negative answer removes a key, so a
   * revoked assignment, profile or tenant still fails closed at the next pass.
   */
  async refresh(): Promise<boolean> {
    this.lastAttemptAt = this.now();
    // Never attach an upstream body to a log or status: it carries business prompt text.
    const name = (error: unknown) => error instanceof Error ? error.name : 'unknown';
    let rows: ProfileAssignment[];
    try { rows = await this.opts.source.assignments(); }
    catch (error) {
      this.lastError = name(error);
      this.opts.logger?.warn('assignment refresh failed; serving cached values', { error: this.lastError, cached: this.entries.size });
      return false;
    }
    // Two enabled rows with one key are ambiguous: neither is trusted, and the key stays configured so readiness shows the gap.
    const wanted = new Map<string, ProfileAssignment | 'duplicate-assignment' | 'invalid-assignment'>();
    for (const a of rows) {
      const key = assignmentKey(a.context, a.did);
      wanted.set(key, wanted.has(key) ? 'duplicate-assignment' : valid(a) ? a : 'invalid-assignment');
    }
    this.configured = new Set(wanted.keys());
    const evict = (key: string, reason: string) => {
      if (this.entries.delete(key)) this.opts.logger?.warn('assignment configuration revoked', { ...scope(key), reason });
    };
    for (const key of [...this.entries.keys()]) if (!wanted.has(key)) evict(key, 'assignment-removed');
    let failures = 0; let lastError: string | undefined;
    // The optional Identity check runs once per distinct tenant among the assignments, never per key or per call.
    const tenants = new Map<string, boolean | undefined>();
    if (this.opts.tenantEnabled) for (const tenantId of new Set([...wanted.values()].flatMap(a => typeof a === 'string' ? [] : [a.tenantId]))) {
      try { tenants.set(tenantId, await this.opts.tenantEnabled(tenantId)); }
      catch (error) {
        failures++; lastError = name(error); tenants.set(tenantId, undefined);
        this.opts.logger?.warn('configuration refresh failed; serving cached values', { tenantId, error: lastError });
      }
    }
    for (const [key, a] of wanted) {
      if (typeof a === 'string') { evict(key, a); continue; }
      if (this.opts.tenantEnabled) {
        const alive = tenants.get(a.tenantId);
        if (alive === undefined) continue; // Identity outage: keep serving the previous entry
        if (!alive) { evict(key, 'tenant-disabled'); continue; }
      }
      try {
        const entry = await this.opts.source.profile(a);
        if (!entry) { evict(key, 'profile-unavailable'); continue; }
        const previous = this.entries.get(key);
        this.entries.set(key, entry);
        if (previous?.profileId !== entry.profileId || previous.profileRevision !== entry.profileRevision) {
          this.opts.logger?.info('assignment configuration cached', { ...scope(key), tenantId: entry.tenantId, profileId: entry.profileId, profileRevision: entry.profileRevision });
        }
      } catch (error) {
        failures++; lastError = name(error);
        this.opts.logger?.warn('configuration refresh failed; serving cached values', { ...scope(key), error: lastError, cached: this.entries.has(key) });
      }
    }
    this.lastError = lastError;
    const complete = failures === 0 && this.status().complete;
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
