import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions, type Route } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { loadConfig } from '../src/config.js';
import { parsePbxTenantScopes, PbxInventoryReader, pbxInventoryRoutes } from '../src/pbx/inventory.js';
import { captureLogger } from './helpers/capture.js';

const scope = { contexts: ['business-one'], queueNames: ['support-one'] };
const scopes = parsePbxTenantScopes(JSON.stringify({ 1: scope }));

test('inventory mapping is explicit and rejects shared or malformed tenant references', () => {
  assert.equal(parsePbxTenantScopes(undefined).size, 0);
  for (const value of ['[]', 'null', '{', '{"uuid":{"contexts":[],"queueNames":[]}}',
    JSON.stringify({ 1: scope, 2: { contexts: ['BUSINESS-ONE'], queueNames: [] } }),
    JSON.stringify({ 1: scope, 2: { contexts: [], queueNames: ['support-one'] } }),
    JSON.stringify({ 1: { contexts: ['one'], queueNames: ['x;DROP'] } }),
    JSON.stringify({ 1: { contexts: ['one'], queueNames: [], extra: true } }),
  ]) assert.throws(() => parsePbxTenantScopes(value), /PBX_INVENTORY_TENANTS_JSON/);
});

test('endpoint inventory selects only nonsecret columns with exact scoped SQL parameters', async () => {
  const reader = new PbxInventoryReader(async (sql, values) => {
    assert.match(sql, /^SELECT id, context, callerid, transport, aors FROM ps_endpoints WHERE BINARY context IN \(\?\)/);
    assert.doesNotMatch(sql, /ps_auths|aida_object|INSERT|UPDATE|DELETE/);
    assert.deepEqual(values, ['business-one']);
    // Extra columns are deliberately never serialized even from a permissive reader.
    return [{ id: 'sip-101', context: 'business-one', callerid: 'Alice', transport: null, aors: 'aor-101', password: 'never-expose' }];
  });
  assert.deepEqual(await reader.extensions(scope), [{ id: 'sip-101', context: 'business-one', callerId: 'Alice', transport: null, aors: 'aor-101' }]);
});

test('queue inventory reads queue configuration and persists its native member interfaces', async () => {
  const reader = new PbxInventoryReader(async (sql, values) => {
    assert.deepEqual(values, ['support-one']);
    if (sql.includes('FROM queues ')) return [{ name: 'support-one', strategy: 'rrmemory' }];
    assert.match(sql, /FROM queue_members WHERE BINARY queue_name IN \(\?\)/);
    return [{ queue_name: 'support-one', interface: 'Local/101@business-one', membername: 'Alice', penalty: 2, paused: 1 },
      { queue_name: 'other', interface: 'PJSIP/other', penalty: 0, paused: 0 }];
  });
  assert.deepEqual(await reader.queues(scope), [{ id: 'support-one', name: 'support-one', strategy: 'rrmemory', members: [
    { interface: 'Local/101@business-one', memberName: 'Alice', penalty: 2, paused: true },
  ] }]);
});

test('empty configured slices do not query all PBX rows; unavailable queues and oversized inventories fail', async () => {
  const reader = new PbxInventoryReader(async () => { throw new Error('must not query'); });
  assert.deepEqual(await reader.extensions({ contexts: [], queueNames: [] }), []);
  assert.deepEqual(await reader.queues({ contexts: [], queueNames: [] }), []);
  await assert.rejects(new PbxInventoryReader(async () => []).queues(scope), /unavailable/);
  await assert.rejects(new PbxInventoryReader(async () => Array(1001).fill({})).extensions(scope), /POC size/);
});

async function withApi(routes: Route[], fn: (base: string) => Promise<void>, publicListener = false): Promise<void> {
  const options = { logger: captureLogger().logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'],
    trustedProxyCidrs: [], maxBodyBytes: 1024, rateLimitPerMinute: 100, routes };
  const api = new HttpApi(publicListener ? publicApiOptions(options) : options);
  await api.listen(0, '127.0.0.1');
  try { await fn(`http://127.0.0.1:${api.address()!.port}`); } finally { await api.close(); }
}

test('HTTP inventory requires one canonical mapped tenant and fails closed when database or mapping is unavailable', async () => {
  let calls = 0;
  const reader = { extensions: async () => { calls++; return []; }, queues: async () => { throw new Error('SQL secret details'); } };
  await withApi(pbxInventoryRoutes(reader, scopes, true), async (base) => {
    for (const query of ['', '?iTenantId=uuid', '?iTenantId=0', '?iTenantId=1&iTenantId=2', '?iTenantId=9007199254740992']) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${query}`)).status, 422);
    }
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=2`)).status, 503);
    assert.equal(calls, 0);
    const response = await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`);
    assert.deepEqual(await response.json(), { source: 'asterisk', iTenantId: 1, extensions: [] });
    const unavailable = await fetch(`${base}/v1/admin/pbx/queues?iTenantId=1`);
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /SQL secret/);
  });
});

test('inventory is absent from public ingress and disabled inventory cannot read PBX', async () => {
  let calls = 0;
  const reader = { extensions: async () => { calls++; return []; }, queues: async () => [] };
  await withApi(pbxInventoryRoutes(reader, scopes, true), async (base) => {
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`)).status, 403);
  }, true);
  await withApi(pbxInventoryRoutes(reader, scopes, false), async (base) => {
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`)).status, 503);
  });
  assert.equal(calls, 0);
});

test('read-only inventory can run before LiveKit voice connectors with a dedicated SQL account', () => {
  const config = loadConfig({ NODE_ENV: 'test', VOICE_ENABLED: 'false', PBX_INVENTORY_ENABLED: 'true',
    MYSQL_HOST: 'pbx', MYSQL_DATABASE: 'asterisk', PBX_INVENTORY_MYSQL_USER: 'inventory_ro', PBX_INVENTORY_MYSQL_PASSWORD: 'test-only' });
  assert.equal(config.pbxInventoryMysql?.host, 'pbx');
  assert.equal(config.pbxInventoryMysql?.user, 'inventory_ro');
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PBX_INVENTORY_ENABLED: 'true' }), /PBX_INVENTORY_MYSQL_USER/);
});
