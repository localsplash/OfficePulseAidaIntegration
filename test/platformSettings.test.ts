import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatformSettings } from '../src/platform/settings.js';
import type { NocoReadApi, NocoRecord } from '../src/nocodb/api.js';

function api(rows: Record<string, NocoRecord[]>): NocoReadApi {
  return { listRecords: async (_table, where) => rows[String(where[0]?.value)] ?? [], ping: async () => true };
}

test('runtime settings resolve explicit scope parents and nonblank environment overrides', async () => {
  const result = await resolvePlatformSettings({ DB_NAME: 'env-db', ARI_URL: ' ' }, api({
    '*': [{ settingKey: 'DB_NAME', settingValue: 'global' }, { settingKey: 'trustedCIDR', settingValue: '172.20.0.0/16' }],
    aida: [{ settingKey: 'DB_NAME', settingValue: 'shared' }, { settingKey: 'ARI_URL', settingValue: 'http://pbx' }],
    officepulse: [{ settingKey: 'DB_NAME', settingValue: 'runtime' }, { settingKey: 'ARI_URL', settingValue: '' }],
  }));
  assert.equal(result.DB_NAME, 'env-db');
  assert.equal(result.ARI_URL, 'http://pbx');
  assert.equal(result.TRUSTED_SERVER_CIDRS, '172.20.0.0/16');
});

test('duplicate scoped settings fail without including secret values', async () => {
  await assert.rejects(resolvePlatformSettings({}, api({ officepulse: [
    { settingKey: 'LIVEKIT_API_SECRET', settingValue: 'do-not-log-this' },
    { settingKey: 'LIVEKIT_API_SECRET', settingValue: 'another-secret' },
  ] })), (error: Error) => error.message.includes('duplicate') && !error.message.includes('do-not-log-this'));
});

test('settings read failure propagates instead of treating unavailable configuration as empty', async () => {
  await assert.rejects(resolvePlatformSettings({}, { listRecords: async () => { throw new Error('unavailable'); }, ping: async () => false }), /unavailable/);
});
