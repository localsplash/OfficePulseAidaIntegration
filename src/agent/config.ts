import { ConfigError } from '../errors.js';
export interface AgentConfig {
  identityOrigin: string; identitySecret?: string; profileIds: Map<string, string>;
  startupTimeoutMs: number; routeAttribute: string;
  /** Background configuration refresh; never a call-path timeout. */
  configRefreshMs: number;
  /** Opt-in Identity runtime tenant check, run only by startup/refresh (#19). */
  identityTenantCheck: boolean;
}
export function agentConfig(env: NodeJS.ProcessEnv): AgentConfig | undefined {
  if (env.NATIVE_ADMISSION_ENABLED !== undefined && !['true', 'false'].includes(env.NATIVE_ADMISSION_ENABLED)) throw new ConfigError(['NATIVE_ADMISSION_ENABLED must be true or false']);
  if (env.NATIVE_ADMISSION_ENABLED !== 'true') return;
  const invalid = () => new ConfigError(['Native admission requires FASTAGI_BIND=127.0.0.1, voice, PBX inventory, HTTPS ID_BASE_URL, distinct LIVEKIT_AGENT_NAME and LIVEKIT_TRUNK_ENDPOINT; validate AGENT_PROFILE_IDS_JSON and startup settings']);
  if (env.FASTAGI_BIND !== '127.0.0.1' || env.VOICE_ENABLED !== 'true' || env.PBX_INVENTORY_ENABLED !== 'true' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(env.LIVEKIT_TRUNK_ENDPOINT ?? '') ||
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(env.LIVEKIT_AGENT_NAME ?? '') || env.LIVEKIT_AGENT_NAME === 'aida-prime') throw invalid();
  let url: URL; try { url = new URL(env.ID_BASE_URL ?? ''); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
  const profileIds = new Map<string, string>();
  try {
    const mapping = JSON.parse(env.AGENT_PROFILE_IDS_JSON ?? '{}');
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw invalid();
    for (const [id, profile] of Object.entries(mapping)) {
      if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(profile)) throw invalid();
      profileIds.set(id, profile);
    }
  } catch { throw invalid(); }
  const seconds = Number(env.AGENT_STARTUP_TIMEOUT_SECONDS ?? 30);
  const refreshSeconds = Number(env.AGENT_CONFIG_REFRESH_SECONDS ?? 300);
  const routeAttribute = env.AIDA_ROUTE_TOKEN_ATTRIBUTE ?? 'sip.aidaRouteToken';
  if (env.AGENT_IDENTITY_TENANT_CHECK !== undefined && !['true', 'false'].includes(env.AGENT_IDENTITY_TENANT_CHECK)) throw invalid();
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60 || !Number.isInteger(refreshSeconds) || refreshSeconds < 30 || refreshSeconds > 3600 ||
    !/^[A-Za-z][A-Za-z0-9_.-]{1,100}$/.test(routeAttribute)) throw invalid();
  return { identityOrigin: url.origin, identitySecret: env.ID_CLIENT_SECRET || env.OPS_IDENTITY_CLIENT_SECRET || undefined,
    profileIds, startupTimeoutMs: seconds * 1000, routeAttribute, configRefreshMs: refreshSeconds * 1000,
    identityTenantCheck: env.AGENT_IDENTITY_TENANT_CHECK === 'true' };
}
