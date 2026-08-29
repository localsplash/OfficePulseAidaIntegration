import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const PROD_ENV = {
  NODE_ENV: 'production',
  OFFICEPULSE_INSTANCE_ID: 'op-1',
  TRUSTED_SERVER_CIDRS: '10.0.0.0/24',
  ARI_URL: 'http://10.0.0.2:8088/ari',
  ARI_USERNAME: 'aida',
  ARI_PASSWORD: 'pw',
  MYSQL_HOST: '10.0.0.2',
  MYSQL_USER: 'aida_integration',
  MYSQL_PASSWORD: 'pw',
  MYSQL_DATABASE: 'asterisk',
  AIDACONTROL_BASE_URL: 'http://10.0.0.3:9010',
};

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
