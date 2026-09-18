import { setTimeout } from 'node:timers/promises';
import { NocoDbReadClient, type NocoReadApi, type NocoRecord } from '../nocodb/api.js';

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
  // Identity's origin is Identity's own record; a copied value can drift to another environment (#20).
  if (merged.ID_BASE_URL) throw new Error('ID_BASE_URL is retired in PlatformConfig mode; Identity APP_BASE_URL (app=identity) is authoritative — remove the override');
  const identity = await identityBaseUrl(api);
  if (identity) merged.ID_BASE_URL = identity;
  return merged;
}

/** `app=identity` is mandatory: other applications carry the same key and none of their URLs may stand in for Identity's. */
async function identityBaseUrl(api: NocoReadApi): Promise<string | undefined> {
  let rows: NocoRecord[];
  try { rows = await api.listRecords('cfg_tbl_Setting', [{ field: 'app', op: 'eq', value: 'identity' }, { field: 'settingKey', op: 'eq', value: 'APP_BASE_URL' }], 5); }
  catch (err) { throw new Error(`Identity APP_BASE_URL lookup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); }
  if (rows.length > 1) throw new Error('duplicate PlatformConfig setting identity/APP_BASE_URL');
  const value = String(rows[0]?.settingValue ?? '').trim();
  if (!value) return; // absent or blank: admission reports the missing record rather than guessing a host
  const malformed = () => new Error('Identity APP_BASE_URL in PlatformConfig must be an HTTPS origin');
  let url: URL; try { url = new URL(value); } catch { throw malformed(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw malformed();
  return url.origin;
}
