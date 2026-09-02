import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, REDACTED } from '../src/logging/redact.js';
import { captureLogger } from './helpers/capture.js';

test('redact masks secret-bearing keys recursively', () => {
  const out = redact({
    sipSecret: 'abc',
    routeToken: 'tok',
    password: 'pw',
    authorization: 'Bearer x',
    apiKey: 'k',
    nested: { enrollmentToken: 'e', fine: 'visible' },
    list: [{ deviceRefreshToken: 'r' }],
    plain: 'ok',
  }) as Record<string, unknown>;
  assert.equal(out.sipSecret, REDACTED);
  assert.equal(out.routeToken, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.apiKey, REDACTED);
  assert.equal((out.nested as Record<string, unknown>).enrollmentToken, REDACTED);
  assert.equal((out.nested as Record<string, unknown>).fine, 'visible');
  assert.equal(((out.list as unknown[])[0] as Record<string, unknown>).deviceRefreshToken, REDACTED);
  assert.equal(out.plain, 'ok');
});

test('logger output never contains bound secret values', () => {
  const { logger, lines } = captureLogger();
  logger.child({ routeToken: 'super-secret-token' }).info('call routed', { sipSecret: 'also-secret' });
  const joined = lines.join('\n');
  assert.ok(!joined.includes('super-secret-token'));
  assert.ok(!joined.includes('also-secret'));
  assert.ok(joined.includes('call routed'));
});

test('logger respects level ordering and produces JSON lines', () => {
  const { logger, lines } = captureLogger('warn');
  logger.info('hidden');
  logger.warn('shown', { component: 'x' });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(record.level, 'warn');
  assert.equal(record.msg, 'shown');
  assert.equal(record.component, 'x');
});
