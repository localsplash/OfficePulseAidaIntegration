import { ConfigError } from './errors.js';
import { parseCidr } from './net/cidr.js';

export type RuntimeEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  env: RuntimeEnv;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  officePulseInstanceId: string;
  fastAgi: {
    port: number;
    bind: string;
    /** Hostname Asterisk uses to reach this service; used in provisioned AGI() rows. */
    advertisedHost: string;
    maxConnections: number;
    sessionTimeoutMs: number;
  };
  http: {
    port: number;
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
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  aidaControl: {
    baseUrl: string;
    timeoutMs: number;
  };
  provisioningServer?: {
    baseUrl: string;
    authToken?: string;
    timeoutMs: number;
  };
  handsetConfig: {
    aidaControlUrl: string;
    pusherKey?: string;
    pusherCluster?: string;
  };
  dialplan: {
    /** Static include context handling post-bootstrap routing (ships in asterisk/). */
    postBootstrapContext: string;
    disclosureContext: string;
    defaultTransport: string;
    defaultAllow: string;
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

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, problems: string[], min = 1, max = Number.MAX_SAFE_INTEGER): number {
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
 * fast at startup instead of at first use.
 *
 * In production, the CIDR allowlists must be non-empty: the private
 * provisioning/operational API is CIDR-trusted, so an empty allowlist
 * would either lock everything out or (if defaulted open) trust everyone.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const runtimeEnv = (env.NODE_ENV as RuntimeEnv) || 'development';
  if (!['production', 'development', 'test'].includes(runtimeEnv)) {
    problems.push(`NODE_ENV must be production, development, or test; got '${env.NODE_ENV}'`);
  }

  const logLevel = (env.LOG_LEVEL as AppConfig['logLevel']) || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug|info|warn|error, got '${env.LOG_LEVEL}'`);
  }

  const trustedServerCidrs = cidrList(env, 'TRUSTED_SERVER_CIDRS', problems);
  const trustedProxyCidrs = cidrList(env, 'TRUSTED_PROXY_CIDRS', problems);
  if (runtimeEnv === 'production' && trustedServerCidrs.length === 0) {
    problems.push('TRUSTED_SERVER_CIDRS must be non-empty in production');
  }

  const config: AppConfig = {
    env: runtimeEnv,
    logLevel,
    officePulseInstanceId: str(env, 'OFFICEPULSE_INSTANCE_ID', problems, runtimeEnv === 'production' ? undefined : 'officepulse-dev'),
    fastAgi: {
      port: int(env, 'FASTAGI_PORT', 4573, problems, 1, 65535),
      bind: env.FASTAGI_BIND ?? '0.0.0.0',
      advertisedHost: env.FASTAGI_ADVERTISED_HOST ?? 'aida-integration.internal',
      maxConnections: int(env, 'FASTAGI_MAX_CONNECTIONS', 50, problems),
      sessionTimeoutMs: int(env, 'FASTAGI_SESSION_TIMEOUT_MS', 10_000, problems, 100),
    },
    http: {
      port: int(env, 'HTTP_PORT', 8085, problems, 1, 65535),
      bind: env.HTTP_BIND ?? '0.0.0.0',
      maxBodyBytes: int(env, 'HTTP_MAX_BODY_BYTES', 64 * 1024, problems, 256),
      rateLimitPerMinute: int(env, 'HTTP_RATE_LIMIT_PER_MINUTE', 300, problems),
      trustedServerCidrs,
      trustedProxyCidrs,
    },
    ari: {
      url: str(env, 'ARI_URL', problems, runtimeEnv === 'production' ? undefined : 'http://127.0.0.1:8088/ari'),
      username: str(env, 'ARI_USERNAME', problems, runtimeEnv === 'production' ? undefined : 'aida'),
      password: str(env, 'ARI_PASSWORD', problems, runtimeEnv === 'production' ? undefined : 'dev-only'),
      app: env.ARI_APP ?? 'aida',
    },
    mysql: {
      host: str(env, 'MYSQL_HOST', problems, runtimeEnv === 'production' ? undefined : '127.0.0.1'),
      port: int(env, 'MYSQL_PORT', 3306, problems, 1, 65535),
      user: str(env, 'MYSQL_USER', problems, runtimeEnv === 'production' ? undefined : 'aida'),
      password: str(env, 'MYSQL_PASSWORD', problems, runtimeEnv === 'production' ? undefined : 'dev-only'),
      database: str(env, 'MYSQL_DATABASE', problems, runtimeEnv === 'production' ? undefined : 'asterisk'),
    },
    aidaControl: {
      baseUrl: str(env, 'AIDACONTROL_BASE_URL', problems, runtimeEnv === 'production' ? undefined : 'http://127.0.0.1:9010'),
      timeoutMs: int(env, 'AIDACONTROL_TIMEOUT_MS', 4_000, problems, 100),
    },
    provisioningServer: optStr(env, 'PROVISIONING_SERVER_BASE_URL')
      ? {
          baseUrl: env.PROVISIONING_SERVER_BASE_URL as string,
          authToken: optStr(env, 'PROVISIONING_SERVER_AUTH_TOKEN'),
          timeoutMs: int(env, 'PROVISIONING_SERVER_TIMEOUT_MS', 10_000, problems, 100),
        }
      : undefined,
    handsetConfig: {
      aidaControlUrl: env.HANDSET_AIDACONTROL_URL ?? env.AIDACONTROL_BASE_URL ?? 'http://127.0.0.1:9010',
      pusherKey: optStr(env, 'PUSHER_KEY'),
      pusherCluster: optStr(env, 'PUSHER_CLUSTER'),
    },
    dialplan: {
      postBootstrapContext: env.DIALPLAN_POST_BOOTSTRAP_CONTEXT ?? 'aida-post-bootstrap',
      disclosureContext: env.DIALPLAN_DISCLOSURE_CONTEXT ?? 'aida-disclosure',
      defaultTransport: env.DEFAULT_SIP_TRANSPORT ?? 'transport-udp',
      defaultAllow: env.DEFAULT_SIP_ALLOW ?? 'ulaw,alaw',
    },
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
