import { setTimeout } from 'node:timers/promises';
import { NocoDbReadClient, type NocoReadApi } from '../nocodb/api.js';

/** Resolve settings before constructing database/ARI/LiveKit clients. No silent fallback. */
export async function platformEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  try { return await readEnvironment(env); }
  catch { await setTimeout(5000); return readEnvironment(env); }
}

async function readEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.PLATFORM_CONFIG_MODE === 'environment') return { ...env };
  if (!env.NOCODB_BASE_URL || !env.NOCODB_API_TOKEN) throw new Error('NOCODB_BASE_URL and NOCODB_API_TOKEN are required');
  const api = new NocoDbReadClient({ baseUrl: env.NOCODB_BASE_URL, apiToken: env.NOCODB_API_TOKEN, timeoutMs: 5000, baseName: 'PlatformConfig' });
  return resolvePlatformSettings(env, api);
}

export async function resolvePlatformSettings(env: NodeJS.ProcessEnv, api: NocoReadApi): Promise<NodeJS.ProcessEnv> {
  const merged: NodeJS.ProcessEnv = {};
  for (const scope of ['*', 'aida', 'officepulse']) {
    const rows = await api.listRecords('cfg_tbl_Setting', [{ field: 'app', op: 'eq', value: scope }], 1000);
    const seen = new Set<string>();
    for (const row of rows) {
      const key = String(row.settingKey ?? '');
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid PlatformConfig setting key');
      if (seen.has(key)) throw new Error(`duplicate PlatformConfig setting ${scope}/${key}`);
      seen.add(key);
      const value = String(row.settingValue ?? '').trim();
      if (value) merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) if (value?.trim()) merged[key] = value;
  // Platform trust is a setting, while reverse-proxy trust is a separate explicit policy.
  merged.TRUSTED_SERVER_CIDRS ??= merged.trustedCIDR;
  return merged;
}
