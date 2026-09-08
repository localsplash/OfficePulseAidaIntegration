import { ConfigError } from './errors.js';
import { parseCidr } from './net/cidr.js';
import { parsePbxTenantScopes, type PbxTenantScopes } from './pbx/inventory.js';
import type { RuntimeMysqlConfig } from './runtime/mysqlRuntimeStore.js';

export type RuntimeEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  env: RuntimeEnv;
  /** Explicit administration-only mode; calling requires configured voice connectors. */
  voiceEnabled: boolean;
  pbxInventoryScopes: PbxTenantScopes;
  pbxInventoryMysql?: RuntimeMysqlConfig;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  officePulseInstanceId: string;
  fastAgi: {
    port: number;
    bind: string;
    maxConnections: number;
    sessionTimeoutMs: number;
  };
  http: {
    port: number;
    publicPort: number;
    bind: string;
    maxBodyBytes: number;
    rateLimitPerMinute: number;
    trustedServerCidrs: string[];
    trustedProxyCidrs: string[];
  };
  ari: {
    url: string;
    username: string;
    password: string;
    app: string;
  };
  /** `aidacalls_db`: runtime state this service exclusively owns. */
  runtimeMysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** Read-only scoped PlatformConfig access; no local PBX graph. */
  nocodb: {
    baseUrl: string;
    apiToken: string;
    baseName: string;
    timeoutMs: number;
  };
  livekit: {
    url: string;
    apiKey: string;
    apiSecret: string;
    agentName: string;
    /** SIP host of the existing LiveKit Cloud trunk (room@host). */
    sipHost: string;
    timeoutMs: number;
  };
  pusher?: {
    appId: string;
    key: string;
    secret: string;
    cluster: string;
    timeoutMs: number;
  };
  takeover: {
    ringTimeoutSeconds: number;
    drainTimeoutMs: number;
    defaultMohClass: string;
    /** PJSIP endpoint name of the existing LiveKit Cloud SIP trunk. */
    livekitTrunkEndpoint?: string;
  };
}

function str(env: NodeJS.ProcessEnv, key: string, problems: string[], fallback?: string): string {
  const v = env[key] ?? fallback;
  if (v === undefined || v === '') {
    problems.push(`${key} is required`);
    return '';
  }
  return v;
}

function optStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function int(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  problems: string[],
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${key} must be an integer in [${min}, ${max}], got '${raw}'`);
    return fallback;
  }
  return n;
}

function cidrList(env: NodeJS.ProcessEnv, key: string, problems: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return [];
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const item of items) {
    try {
      parseCidr(item);
    } catch {
      problems.push(`${key} contains invalid CIDR '${item}'`);
    }
  }
  return items;
}

/**
 * Load and validate all configuration from the environment. Throws
 * ConfigError listing every problem at once so a broken deployment fails
 * fast at startup instead of at first call.
 *
 * Voice connectors require their own credentials only when VOICE_ENABLED=true.
 * PlatformConfig and the runtime database remain independent of PBX inventory.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const runtimeEnv = (env.NODE_ENV as RuntimeEnv) || 'development';
  if (!['production', 'development', 'test'].includes(runtimeEnv)) {
    problems.push(`NODE_ENV must be production, development, or test; got '${env.NODE_ENV}'`);
  }
  const isProd = runtimeEnv === 'production';
  if (env.VOICE_ENABLED !== undefined && !['true', 'false'].includes(env.VOICE_ENABLED)) {
    problems.push('VOICE_ENABLED must be true or false');
  }
  const voiceEnabled = env.VOICE_ENABLED !== 'false';
  if (env.PBX_INVENTORY_ENABLED !== undefined && !['true', 'false'].includes(env.PBX_INVENTORY_ENABLED)) {
    problems.push('PBX_INVENTORY_ENABLED must be true or false');
  }
  /** In production a value must be supplied; elsewhere a dev default stands in. */
  const required = (devFallback: string): string | undefined => (isProd ? undefined : devFallback);

  const logLevel = (env.LOG_LEVEL as AppConfig['logLevel']) || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug|info|warn|error, got '${env.LOG_LEVEL}'`);
  }

  const trustedServerCidrs = cidrList(env, 'TRUSTED_SERVER_CIDRS', problems);
  const trustedProxyCidrs = cidrList(env, 'TRUSTED_PROXY_CIDRS', problems);
  if (isProd && trustedServerCidrs.length === 0) {
    problems.push('TRUSTED_SERVER_CIDRS must be non-empty in production');
  }

  const voice = (key: string, fallback: string): string =>
    voiceEnabled ? str(env, key, problems, required(fallback)) : '';

  const pusherAppId = optStr(env, 'PUSHER_APP_ID');

  const config: AppConfig = {
    env: runtimeEnv,
    voiceEnabled,
    pbxInventoryScopes: parsePbxTenantScopes(env.PBX_INVENTORY_TENANTS_JSON),
    pbxInventoryMysql: env.PBX_INVENTORY_ENABLED === 'true' ? {
      host: str(env, 'MYSQL_HOST', problems, required('127.0.0.1')),
      port: int(env, 'MYSQL_PORT', 3306, problems, 1, 65535),
      database: str(env, 'MYSQL_DATABASE', problems, required('asterisk')),
      user: str(env, 'PBX_INVENTORY_MYSQL_USER', problems),
      password: str(env, 'PBX_INVENTORY_MYSQL_PASSWORD', problems),
    } : undefined,
    logLevel,
    officePulseInstanceId: str(env, 'OFFICEPULSE_INSTANCE_ID', problems, required('officepulse-dev')),
    fastAgi: {
      port: int(env, 'FASTAGI_PORT', 4573, problems, 1, 65535),
      bind: env.FASTAGI_BIND ?? '0.0.0.0',
      maxConnections: int(env, 'FASTAGI_MAX_CONNECTIONS', 50, problems),
      sessionTimeoutMs: int(env, 'FASTAGI_SESSION_TIMEOUT_MS', 10_000, problems, 100),
    },
    http: {
      port: int(env, 'HTTP_PORT', 8085, problems, 1, 65535),
      publicPort: int(env, 'PUBLIC_HTTP_PORT', 8086, problems, 1, 65535),
      bind: env.HTTP_BIND ?? '0.0.0.0',
      maxBodyBytes: int(env, 'HTTP_MAX_BODY_BYTES', 64 * 1024, problems, 256),
      rateLimitPerMinute: int(env, 'HTTP_RATE_LIMIT_PER_MINUTE', 300, problems),
      trustedServerCidrs,
      trustedProxyCidrs,
    },
    ari: {
      url: voice('ARI_URL', 'http://127.0.0.1:8088/ari'),
      username: voice('ARI_USERNAME', 'aida'),
      password: voice('ARI_PASSWORD', 'dev-only'),
      app: env.ARI_APP ?? 'aida',
    },
    runtimeMysql: {
      host: str(env, 'RUNTIME_MYSQL_HOST', problems, required('127.0.0.1')),
      port: int(env, 'RUNTIME_MYSQL_PORT', 3306, problems, 1, 65535),
      user: str(env, 'RUNTIME_MYSQL_USER', problems, required('aida')),
      password: str(env, 'RUNTIME_MYSQL_PASSWORD', problems, required('dev-only')),
      database: env.RUNTIME_MYSQL_DATABASE ?? 'aidacalls_db',
    },
    nocodb: {
      baseUrl: str(env, 'NOCODB_BASE_URL', problems, required('http://127.0.0.1:8080')),
      apiToken: str(env, 'NOCODB_API_TOKEN', problems, required('dev-only')),
      baseName: env.NOCODB_BASE_NAME ?? 'PlatformConfig',
      timeoutMs: int(env, 'NOCODB_TIMEOUT_MS', 4_000, problems, 100),
    },
    livekit: {
      url: voice('LIVEKIT_URL', 'ws://127.0.0.1:7880'),
      apiKey: voice('LIVEKIT_API_KEY', 'devkey'),
      apiSecret: voice('LIVEKIT_API_SECRET', 'dev-only-secret'),
      agentName: env.LIVEKIT_AGENT_NAME ?? 'aida-prime',
      sipHost: voice('LIVEKIT_SIP_HOST', 'sip.livekit.local'),
      timeoutMs: int(env, 'LIVEKIT_TIMEOUT_MS', 5_000, problems, 100),
    },
    pusher: pusherAppId
      ? {
          appId: pusherAppId,
          key: str(env, 'PUSHER_KEY', problems),
          secret: str(env, 'PUSHER_SECRET', problems),
          cluster: str(env, 'PUSHER_CLUSTER', problems),
          timeoutMs: int(env, 'PUSHER_TIMEOUT_MS', 3_000, problems, 100),
        }
      : undefined,
    takeover: {
      ringTimeoutSeconds: int(env, 'TAKEOVER_RING_TIMEOUT_SECONDS', 20, problems, 5, 120),
      drainTimeoutMs: int(env, 'TAKEOVER_DRAIN_TIMEOUT_MS', 10_000, problems, 100, 10_000),
      defaultMohClass: env.TAKEOVER_DEFAULT_MOH_CLASS ?? 'default',
      livekitTrunkEndpoint: optStr(env, 'LIVEKIT_TRUNK_ENDPOINT'),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
