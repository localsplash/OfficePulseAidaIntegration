import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformEnvironment, resolvePlatformSettings } from '../src/platform/settings.js';
import type { NocoReadApi, NocoRecord } from '../src/nocodb/api.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';

const identityOrigin = 'https://id.example.test';
const setting = (app: string, settingKey: string, settingValue: string): NocoRecord => ({ app, settingKey, settingValue });
/** PlatformConfig rows exactly as NocoDB returns them; the Identity record is present unless a test replaces it. */
function api(rows: NocoRecord[], identity: NocoRecord[] = [setting('identity', 'APP_BASE_URL', `${identityOrigin}/`)]): FakeNocoApi {
  const noco = new FakeNocoApi();
  noco.seed('cfg_tbl_Setting', [...identity, ...rows]);
  return noco;
}
const retired = 'ID_BASE_URL is retired in PlatformConfig mode; Identity APP_BASE_URL (app=identity) is authoritative — remove the override';
const message = (expected: string) => (error: Error) => { assert.equal(error.message, expected); return true; };

test('runtime settings resolve explicit scope parents and nonblank environment overrides', async () => {
  const result = await resolvePlatformSettings({ DB_NAME: 'env-db', ARI_URL: ' ' }, api([
    setting('*', 'DB_NAME', 'global'), setting('*', 'trustedCIDR', '172.20.0.0/16'),
    setting('aida', 'DB_NAME', 'shared'), setting('aida', 'ARI_URL', 'http://pbx'),
    setting('officepulse', 'DB_NAME', 'runtime'), setting('officepulse', 'ARI_URL', ''),
  ]));
  assert.equal(result.DB_NAME, 'env-db');
  assert.equal(result.ARI_URL, 'http://pbx');
  assert.equal(result.TRUSTED_SERVER_CIDRS, '172.20.0.0/16');
  assert.equal(result.APP_BASE_URL, undefined, 'the identity scope is not a settings parent');
});

test('duplicate scoped settings fail without including secret values', async () => {
  await assert.rejects(resolvePlatformSettings({}, api([
    setting('officepulse', 'LIVEKIT_API_SECRET', 'do-not-log-this'),
    setting('officepulse', 'LIVEKIT_API_SECRET', 'another-secret'),
  ])), (error: Error) => error.message.includes('duplicate') && !error.message.includes('do-not-log-this'));
});

test('settings read failure propagates instead of treating unavailable configuration as empty', async () => {
  const noco = api([]); noco.failOn = 'cfg_tbl_Setting';
  await assert.rejects(resolvePlatformSettings({}, noco), /forced NocoDB failure/);
});

test('the Identity origin comes from the identity application record only, never another app or the key alone', async () => {
  const noco = api([
    setting('officepulse', 'APP_BASE_URL', 'https://officepulse.example.test'),
    setting('aida', 'APP_BASE_URL', 'https://aida.example.test'),
    setting('*', 'APP_BASE_URL', 'https://platform.example.test'),
    setting('aidaadmin', 'APP_BASE_URL', 'https://admin.example.test'),
  ]);
  const result = await resolvePlatformSettings({}, noco);
  assert.equal(result.ID_BASE_URL, identityOrigin, 'trailing slash is tolerated and normalized to the origin');
  assert.equal(result.APP_BASE_URL, 'https://officepulse.example.test', 'OfficePulse keeps its own APP_BASE_URL as an ordinary setting');
  const lookups = noco.calls.filter(c => c.where.some(w => w.field === 'settingKey'));
  assert.deepEqual(lookups, [{ table: 'cfg_tbl_Setting', where: [{ field: 'app', op: 'eq', value: 'identity' }, { field: 'settingKey', op: 'eq', value: 'APP_BASE_URL' }] }]);
});

test('duplicate Identity APP_BASE_URL records are rejected without printing their values', async () => {
  await assert.rejects(resolvePlatformSettings({}, api([], [
    setting('identity', 'APP_BASE_URL', 'https://one.example.test'), setting('identity', 'APP_BASE_URL', 'https://two.example.test'),
  ])), message('duplicate PlatformConfig setting identity/APP_BASE_URL'));
});

test('a missing or blank Identity APP_BASE_URL leaves ID_BASE_URL unset rather than guessing a host', async () => {
  for (const identity of [[], [setting('identity', 'APP_BASE_URL', '   ')], [{ app: 'identity', settingKey: 'APP_BASE_URL', settingValue: null }]]) {
    const result = await resolvePlatformSettings({ DB_NAME: 'env-db' }, api([setting('officepulse', 'APP_BASE_URL', 'https://officepulse.example.test')], identity));
    assert.equal('ID_BASE_URL' in result, false);
    assert.equal(result.DB_NAME, 'env-db');
  }
});

test('a malformed Identity APP_BASE_URL is a configuration error that never echoes the value', async () => {
  for (const value of ['http://id.example.test', 'https://id.example.test/identity', 'https://user:secret@id.example.test', 'https://id.example.test/?env=prod',
    'https://id.example.test/#fragment', 'id.example.test', 'not a url']) {
    await assert.rejects(resolvePlatformSettings({}, api([], [setting('identity', 'APP_BASE_URL', value)])), (error: Error) => {
      assert.equal(error.message, 'Identity APP_BASE_URL in PlatformConfig must be an HTTPS origin');
      assert.doesNotMatch(error.message, /secret|example/);
      return true;
    });
  }
});

test('a stale ID_BASE_URL override is rejected from the environment and from every settings scope', async () => {
  await assert.rejects(resolvePlatformSettings({ ID_BASE_URL: 'https://stale.example.test' }, api([])), message(retired));
  for (const scope of ['*', 'aida', 'officepulse']) {
    await assert.rejects(resolvePlatformSettings({}, api([setting(scope, 'ID_BASE_URL', 'https://stale.example.test')])), message(retired));
  }
  // Blank values are not overrides, matching every other setting.
  const result = await resolvePlatformSettings({ ID_BASE_URL: '  ' }, api([setting('officepulse', 'ID_BASE_URL', '')]));
  assert.equal(result.ID_BASE_URL, identityOrigin);
});

test('environment-only mode keeps ID_BASE_URL from the environment and reads no PlatformConfig', async () => {
  const env = { PLATFORM_CONFIG_MODE: 'environment', ID_BASE_URL: 'https://legacy.example.test', DB_NAME: 'env-db' };
  const result = await platformEnvironment(env);
  assert.deepEqual(result, env);
});

test('a NocoDB failure during the Identity lookup is a configuration error, not an unset origin', async () => {
  const noco = api([setting('officepulse', 'DB_NAME', 'runtime')]);
  const flaky: NocoReadApi = {
    listRecords: async (table, where, limit) => { if (where.some(w => w.field === 'settingKey')) throw new Error('NocoDB /records returned 503'); return noco.listRecords(table, where, limit); },
    ping: async () => true,
  };
  await assert.rejects(resolvePlatformSettings({}, flaky), message('Identity APP_BASE_URL lookup failed: NocoDB /records returned 503'));
});

test('shared environment and central instance resolve with a deliberate multi-PBX host override', async () => {
  const rows = [setting('*', 'ENVIRONMENT_NAME', 'dev'), setting('officepulse', 'OFFICEPULSE_INSTANCE_ID', 'officepulse-dev')];
  const central = await resolvePlatformSettings({}, api(rows));
  assert.equal(central.ENVIRONMENT_NAME, 'dev'); assert.equal(central.OFFICEPULSE_INSTANCE_ID, 'officepulse-dev');
  const host = await resolvePlatformSettings({ OFFICEPULSE_INSTANCE_ID: 'officepulse2-dev' }, api(rows));
  assert.equal(host.OFFICEPULSE_INSTANCE_ID, 'officepulse2-dev'); assert.equal(host.ENVIRONMENT_NAME, 'dev');
});
