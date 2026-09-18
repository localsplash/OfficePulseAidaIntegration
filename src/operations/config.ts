import { ConfigError } from '../errors.js';

export interface OperationsConfig {
  port: number;
  publicUrl: string;
  identityUrl: string;
  identitySecret?: string;
  apiUrl: string;
  ari?: { url: string; username: string; password: string };
}

export function operationsConfig(env: NodeJS.ProcessEnv): OperationsConfig | undefined {
  if (env.OPS_ENABLED !== undefined && !['true', 'false'].includes(env.OPS_ENABLED))
    throw new ConfigError(['OPS_ENABLED must be true or false']);
  if (env.OPS_ENABLED !== 'true') return undefined;
  const origin = (key: string, missing?: string) => {
    if (missing && !env[key]) throw new ConfigError([missing]);
    try {
      const url = new URL(env[key] ?? '');
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new ConfigError([`${key} must be an HTTPS origin`]); }
  };
  const port = Number(env.OPS_HTTP_PORT ?? '8087');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(['OPS_HTTP_PORT is invalid']);
  const ariFields = ['OPS_ARI_URL', 'OPS_ARI_USERNAME', 'OPS_ARI_PASSWORD'];
  let ari: OperationsConfig['ari'];
  if (ariFields.some(key => !!env[key])) {
    if (ariFields.some(key => !env[key])) throw new ConfigError(['All OPS_ARI_* settings are required for live PBX diagnostics']);
    let url: URL;
    try { url = new URL(env.OPS_ARI_URL!); }
    catch { throw new ConfigError(['OPS_ARI_URL must be an HTTP(S) service URL without credentials']); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new ConfigError(['OPS_ARI_URL must be an HTTP(S) service URL without credentials']);
    ari = { url: url.toString(), username: env.OPS_ARI_USERNAME!, password: env.OPS_ARI_PASSWORD! };
  }
  // Identity's origin is resolved centrally into ID_BASE_URL (#20); an explicit OPS_IDENTITY_URL keeps precedence.
  const identityUrl = origin(env.OPS_IDENTITY_URL ? 'OPS_IDENTITY_URL' : 'ID_BASE_URL',
    'OPS_IDENTITY_URL is unset and no Identity origin was resolved: set the PlatformConfig record identity/APP_BASE_URL (ID_BASE_URL only with PLATFORM_CONFIG_MODE=environment)');
  return { port, publicUrl: origin('OPS_PUBLIC_URL'), identityUrl,
    apiUrl: origin('OPS_API_URL'), identitySecret: env.OPS_IDENTITY_CLIENT_SECRET || undefined, ari };
}
