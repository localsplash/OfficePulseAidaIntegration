import { ConfigError } from './errors.js';
import { parseCidr } from './net/cidr.js';

export type RuntimeEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  env: RuntimeEnv;
  /** Explicit administration-only mode; calling requires configured voice connectors. */
  voiceEnabled: boolean;
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
  /** OfficePulse's Asterisk Realtime database (this service is its writer). */
  asteriskMysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** `aidacalls_db`: runtime state this service exclusively owns. */
  runtimeMysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** Read-only access to the AidaAdmin NocoDB configuration base. */
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
  identity: { baseUrl: string; clientSecret?: string };
  call: {
    defaultLocale: string;
    /** Operator emergency fallback; used only when a DID has no projection. */
    operatorFallbackContext?: string;
    operatorFallbackExtension?: string;
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
 * Production requires every dependency this service now orchestrates
 * directly (issue #9): NocoDB, LiveKit, and the runtime database are no
 * longer optional, because without them there is no screening at all.
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
  const asteriskHost = voice('MYSQL_HOST', '127.0.0.1');

  const config: AppConfig = {
    env: runtimeEnv,
    voiceEnabled,
    logLevel,
    officePulseInstanceId: str(env, 'OFFICEPULSE_INSTANCE_ID', problems, required('officepulse-dev')),
    fastAgi: {
      port: int(env, 'FASTAGI_PORT', 4573, problems, 1, 65535),
      bind: env.FASTAGI_BIND ?? '0.0.0.0',
      advertisedHost: env.FASTAGI_ADVERTISED_HOST ?? 'aida-integration.internal',
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
    asteriskMysql: {
      host: asteriskHost,
      port: int(env, 'MYSQL_PORT', 3306, problems, 1, 65535),
      user: voice('MYSQL_USER', 'aida'),
      password: voice('MYSQL_PASSWORD', 'dev-only'),
      database: voice('MYSQL_DATABASE', 'asterisk'),
    },
    runtimeMysql: {
      // The runtime database usually lives on LSAidaOffice01 rather than
      // beside Asterisk, but defaults to the same server when unset.
      host: voiceEnabled ? (env.RUNTIME_MYSQL_HOST ?? asteriskHost)
        : str(env, 'RUNTIME_MYSQL_HOST', problems, required('127.0.0.1')),
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
    provisioningServer: optStr(env, 'PROVISIONING_SERVER_BASE_URL')
      ? {
          baseUrl: env.PROVISIONING_SERVER_BASE_URL as string,
          authToken: optStr(env, 'PROVISIONING_SERVER_AUTH_TOKEN'),
          timeoutMs: int(env, 'PROVISIONING_SERVER_TIMEOUT_MS', 10_000, problems, 100),
        }
      : undefined,
    handsetConfig: {
      // AidaHandset still enrols against this service's own HTTP API.
      aidaControlUrl: env.HANDSET_API_URL ?? `http://${env.FASTAGI_ADVERTISED_HOST ?? 'aida-integration.internal'}:${env.HTTP_PORT ?? '8085'}`,
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
    identity: { baseUrl: str(env, 'IDENTITY_BASE_URL', problems, required('http://identity:3200')), clientSecret: optStr(env, 'IDENTITY_CLIENT_SECRET') },
    call: {
      defaultLocale: env.CALL_DEFAULT_LOCALE ?? 'en-US',
      operatorFallbackContext: optStr(env, 'OPERATOR_FALLBACK_CONTEXT'),
      operatorFallbackExtension: optStr(env, 'OPERATOR_FALLBACK_EXTENSION'),
    },
  };

  const { operatorFallbackContext, operatorFallbackExtension } = config.call;
  if ((operatorFallbackContext === undefined) !== (operatorFallbackExtension === undefined)) {
    problems.push('OPERATOR_FALLBACK_CONTEXT and OPERATOR_FALLBACK_EXTENSION must be set together');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
