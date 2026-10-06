import { ConfigError } from '../errors.js';
export interface AgentConfig {
  identityOrigin: string; identitySecret?: string;
  startupTimeoutMs: number; routeAttribute: string;
  /** Background configuration refresh; never a call-path timeout. */
  configRefreshMs: number;
  /** Opt-in Identity runtime tenant check, run only by startup/refresh (#19). */
  identityTenantCheck: boolean;
}
export function agentConfig(env: NodeJS.ProcessEnv): AgentConfig | undefined {
  // Refused even with admission disabled (#23): the retired per-tenant map must not remain a hidden dependency.
  if (env.AGENT_PROFILE_IDS_JSON?.trim()) throw new ConfigError(['AGENT_PROFILE_IDS_JSON is retired: assistant profiles are assigned per context/DID in PlatformConfig aida_tbl_ProfileAssignment through AidaAdmin. See docs/AGENT_BOOTSTRAP.md']);
  if (env.NATIVE_ADMISSION_ENABLED !== undefined && !['true', 'false'].includes(env.NATIVE_ADMISSION_ENABLED)) throw new ConfigError(['NATIVE_ADMISSION_ENABLED must be true or false']);
  if (env.NATIVE_ADMISSION_ENABLED !== 'true') return;
  const invalid = () => new ConfigError(['Native admission requires FASTAGI_BIND=127.0.0.1, voice, PBX inventory, distinct LIVEKIT_AGENT_NAME and LIVEKIT_TRUNK_ENDPOINT; validate startup settings']);
  if (env.FASTAGI_BIND !== '127.0.0.1' || env.VOICE_ENABLED !== 'true' || env.PBX_INVENTORY_ENABLED !== 'true' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(env.LIVEKIT_TRUNK_ENDPOINT ?? '') ||
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(env.LIVEKIT_AGENT_NAME ?? '') || env.LIVEKIT_AGENT_NAME === 'aida-prime') throw invalid();
  // ID_BASE_URL is filled from the Identity application's own PlatformConfig record at startup (#20); only environment-only mode sets it by hand.
  const identity = () => new ConfigError(['Native admission requires an HTTPS Identity origin: set the PlatformConfig record identity/APP_BASE_URL (ID_BASE_URL only with PLATFORM_CONFIG_MODE=environment)']);
  let url: URL; try { url = new URL(env.ID_BASE_URL ?? ''); } catch { throw identity(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw identity();
  const seconds = Number(env.AGENT_STARTUP_TIMEOUT_SECONDS ?? 30);
  const refreshSeconds = Number(env.AGENT_CONFIG_REFRESH_SECONDS ?? 300);
  const routeAttribute = env.AIDA_ROUTE_TOKEN_ATTRIBUTE ?? 'sip.aidaRouteToken';
  if (env.AGENT_IDENTITY_TENANT_CHECK !== undefined && !['true', 'false'].includes(env.AGENT_IDENTITY_TENANT_CHECK)) throw invalid();
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60 || !Number.isInteger(refreshSeconds) || refreshSeconds < 30 || refreshSeconds > 3600 ||
    !/^[A-Za-z][A-Za-z0-9_.-]{1,100}$/.test(routeAttribute)) throw invalid();
  return { identityOrigin: url.origin, identitySecret: env.ID_CLIENT_SECRET || env.OPS_IDENTITY_CLIENT_SECRET || undefined,
    startupTimeoutMs: seconds * 1000, routeAttribute, configRefreshMs: refreshSeconds * 1000,
    identityTenantCheck: env.AGENT_IDENTITY_TENANT_CHECK === 'true' };
}
