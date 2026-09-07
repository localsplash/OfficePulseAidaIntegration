import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const PROD_ENV = {
  NODE_ENV: 'production',
  IDENTITY_BASE_URL: 'https://identity.example.test',
  OFFICEPULSE_INSTANCE_ID: 'op-1',
  TRUSTED_SERVER_CIDRS: '10.0.0.0/24',
  ARI_URL: 'http://10.0.0.2:8088/ari',
  ARI_USERNAME: 'aida',
  ARI_PASSWORD: 'pw',
  MYSQL_HOST: '10.0.0.2',
  MYSQL_USER: 'aida_integration',
  MYSQL_PASSWORD: 'pw',
  MYSQL_DATABASE: 'asterisk',
  RUNTIME_MYSQL_USER: 'aida_runtime',
  RUNTIME_MYSQL_PASSWORD: 'pw',
  NOCODB_BASE_URL: 'https://nocodb.test',
  NOCODB_API_TOKEN: 'token',
  LIVEKIT_URL: 'wss://acme.livekit.cloud',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'secret',
  LIVEKIT_SIP_HOST: 'sip.livekit.cloud',
};

test('administration-only production requires real platform services but no voice credentials', () => {
  const env = {
    NODE_ENV: 'production', VOICE_ENABLED: 'false',
    IDENTITY_BASE_URL: PROD_ENV.IDENTITY_BASE_URL,
    OFFICEPULSE_INSTANCE_ID: PROD_ENV.OFFICEPULSE_INSTANCE_ID,
    TRUSTED_SERVER_CIDRS: PROD_ENV.TRUSTED_SERVER_CIDRS,
    RUNTIME_MYSQL_HOST: 'runtime-db', RUNTIME_MYSQL_USER: 'runtime', RUNTIME_MYSQL_PASSWORD: 'pw',
    NOCODB_BASE_URL: PROD_ENV.NOCODB_BASE_URL, NOCODB_API_TOKEN: PROD_ENV.NOCODB_API_TOKEN,
  };
  const config = loadConfig(env);
  assert.equal(config.voiceEnabled, false);
  assert.equal(config.ari.password, '');
  assert.equal(config.livekit.apiSecret, '');
  assert.equal(config.asteriskMysql.host, '');
  assert.throws(() => loadConfig({ ...env, RUNTIME_MYSQL_HOST: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, NOCODB_API_TOKEN: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, VOICE_ENABLED: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ ...PROD_ENV, VOICE_ENABLED: 'typo' }), ConfigError);
});

test('development config loads with defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.fastAgi.port, 4573);
  assert.equal(config.http.port, 8085);
  assert.equal(config.takeover.drainTimeoutMs, 10_000);
});

test('production requires credentials and non-empty CIDR allowlist', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigError);
  const err = (() => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      return undefined;
    } catch (e) {
      return e as ConfigError;
    }
  })();
  assert.ok(err?.problems.some((p) => p.includes('TRUSTED_SERVER_CIDRS')));
  assert.doesNotThrow(() => loadConfig(PROD_ENV));
});

test('invalid CIDRs and integers are reported together', () => {
  try {
    loadConfig({ ...PROD_ENV, TRUSTED_SERVER_CIDRS: 'garbage', FASTAGI_PORT: '99999' });
    assert.fail('should throw');
  } catch (err) {
    const problems = (err as ConfigError).problems;
    assert.ok(problems.some((p) => p.includes("invalid CIDR 'garbage'")));
    assert.ok(problems.some((p) => p.includes('FASTAGI_PORT')));
  }
});

test('drain timeout is capped at the 10 second maximum', () => {
  assert.throws(() => loadConfig({ ...PROD_ENV, TAKEOVER_DRAIN_TIMEOUT_MS: '20000' }), ConfigError);
});

test('production requires the dependencies this service now orchestrates itself', () => {
  // Each is individually load-bearing: without NocoDB there is no route,
  // without LiveKit no screening, without the runtime database no session.
  for (const key of [
    'NOCODB_BASE_URL',
    'NOCODB_API_TOKEN',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_SIP_HOST',
    'RUNTIME_MYSQL_USER',
    'RUNTIME_MYSQL_PASSWORD',
  ]) {
    const env: Record<string, string> = { ...PROD_ENV };
    delete env[key];
    assert.throws(() => loadConfig(env), ConfigError, `${key} must be required in production`);
  }
});

test('no AidaControl configuration is read or required any more', () => {
  const config = loadConfig({ ...PROD_ENV, AIDACONTROL_BASE_URL: 'http://stale:9010' });
  assert.equal(JSON.stringify(config).includes('stale:9010'), false);
  assert.equal(config.nocodb.baseName, 'PlatformConfig');
  assert.equal(config.livekit.agentName, 'aida-prime');
});

test('the operator emergency fallback must be complete or absent', () => {
  assert.throws(() => loadConfig({ ...PROD_ENV, OPERATOR_FALLBACK_CONTEXT: 'emergency' }), ConfigError);
  assert.throws(() => loadConfig({ ...PROD_ENV, OPERATOR_FALLBACK_EXTENSION: '000' }), ConfigError);
  const config = loadConfig({
    ...PROD_ENV,
    OPERATOR_FALLBACK_CONTEXT: 'emergency',
    OPERATOR_FALLBACK_EXTENSION: '000',
  });
  assert.equal(config.call.operatorFallbackContext, 'emergency');
});
