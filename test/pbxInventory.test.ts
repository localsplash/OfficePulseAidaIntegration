import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions, type Route } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { loadConfig } from '../src/config.js';
import { PbxInventoryReader, pbxInventoryRoutes, legacyExtension, type InventoryReader } from '../src/pbx/inventory.js';
import { queueMarkerExten, queueMarkerData } from '../src/pbx/queueOwnership.js';
import { captureLogger } from './helpers/capture.js';

const CONTEXT = 'business-one';
const marker = (name: string, context = CONTEXT) => ({ context, exten: queueMarkerExten(name), priority: 1, app: 'NoOp', appdata: queueMarkerData(name) });

test('context listing is BINARY-distinct across endpoint and dialplan rows, sorted and bounded', async () => {
  const reader = new PbxInventoryReader(async (sql, values) => {
    assert.match(sql, /GROUP BY BINARY context/); assert.match(sql, /FROM ps_endpoints/); assert.match(sql, /FROM extensions/); assert.match(sql, /LIMIT 1001/);
    assert.deepEqual(values, []);
    return [{ context: 'tenant-b' }, { context: 'Tenant-A' }, { context: 'tenant-a' }, { context: 'from-carrier' }];
  });
  assert.deepEqual(await reader.contexts(), ['Tenant-A', 'from-carrier', 'tenant-a', 'tenant-b']);
  await assert.rejects(new PbxInventoryReader(async () => Array(1001).fill({ context: 'x' })).contexts(), /POC size/);
});

test('endpoint inventory selects only nonsecret columns of one context and derives the dialable number from the managed route', async () => {
  const reader = new PbxInventoryReader(async (sql, values) => {
    assert.deepEqual(values, [CONTEXT]);
    if (sql.startsWith('SELECT id, context, callerid, transport, aors FROM ps_endpoints WHERE BINARY context = ?')) {
      assert.doesNotMatch(sql, /ps_auths|INSERT|UPDATE|DELETE/);
      // Extra columns are deliberately never serialized even from a permissive reader.
      return [{ id: '101-business-one', context: CONTEXT, callerid: 'Alice', transport: null, aors: '101-business-one', password: 'never-expose' },
        { id: '102-t1', context: CONTEXT, callerid: 'Legacy', transport: 'transport-udp', aors: '102-t1' },
        { id: '103', context: CONTEXT, callerid: null, transport: null, aors: null },
        { id: 'trunk-a', context: CONTEXT, callerid: null, transport: null, aors: null }];
    }
    assert.match(sql, /FROM extensions WHERE BINARY context = \? AND priority = 1 AND app = 'Dial'/);
    return [{ exten: '201', appdata: 'PJSIP/101-business-one,20' }, { exten: '9999', appdata: 'PJSIP/103,30' }, { exten: 'abc', appdata: 'PJSIP/103,20' }];
  });
  assert.deepEqual(await reader.extensions(CONTEXT), [
    { id: '101-business-one', extension: '201', context: CONTEXT, callerId: 'Alice', transport: null, aors: '101-business-one', managed: true },
    { id: '102-t1', extension: '102', context: CONTEXT, callerId: 'Legacy', transport: 'transport-udp', aors: '102-t1', managed: false },
    { id: '103', extension: '103', context: CONTEXT, callerId: null, transport: null, aors: null, managed: false },
    { id: 'trunk-a', extension: null, context: CONTEXT, callerId: null, transport: null, aors: null, managed: false },
  ]);
  assert.equal(legacyExtension('12-t0'), null); assert.equal(legacyExtension('1-t1'), null); assert.equal(legacyExtension('12-t1'), '12');
});

test('queue inventory is owned by exact markers in the context; a marker duplicated elsewhere is ambiguous and omitted', async () => {
  const native = CONTEXT + '.' + 'x'.repeat(60);
  assert.equal(queueMarkerExten(native).length, 40);
  const reader = new PbxInventoryReader(async (sql, values) => {
    if (sql.includes("LEFT(exten, 13) = '__aida_queue_'")) {
      assert.deepEqual(values, [CONTEXT]);
      return [marker(native), marker('support-one'), marker('shared'), { exten: queueMarkerExten('t1.impostor'), priority: 1, app: 'NoOp', appdata: queueMarkerData('other') }];
    }
    if (sql.startsWith('SELECT context, exten, appdata FROM extensions WHERE BINARY exten IN')) {
      assert.deepEqual(values, [queueMarkerExten(native), queueMarkerExten('support-one'), queueMarkerExten('shared')]);
      return [marker(native), marker('support-one'), marker('shared'), marker('shared', 'business-two')];
    }
    assert.deepEqual(values, [native, 'support-one']);
    if (sql.includes('FROM queues ')) return [{ name: 'support-one', strategy: 'rrmemory' }, { name: native, strategy: 'ringall' }];
    assert.match(sql, /FROM queue_members WHERE BINARY queue_name IN \(\?,\?\)/);
    return [{ queue_name: 'support-one', interface: 'Local/101@business-one', membername: 'Alice', penalty: 2, paused: 1 },
      { queue_name: 'other', interface: 'PJSIP/other', penalty: 0, paused: 0 }];
  });
  assert.deepEqual(await reader.queues(CONTEXT), [
    { id: 'support-one', name: 'support-one', strategy: 'rrmemory', members: [{ interface: 'Local/101@business-one', memberName: 'Alice', penalty: 2, paused: true }] },
    { id: native, name: native, strategy: 'ringall', members: [] },
  ]);
});

test('a context without markers queries nothing further; oversized inventories fail explicitly', async () => {
  let calls = 0;
  const reader = new PbxInventoryReader(async (sql) => { calls++; if (/FROM queues|queue_members/.test(sql)) throw new Error('must not query'); return []; });
  assert.deepEqual(await reader.queues(CONTEXT), []); assert.equal(calls, 1);
  assert.deepEqual(await reader.extensions(CONTEXT), []);
  await assert.rejects(new PbxInventoryReader(async () => Array(1001).fill({})).extensions(CONTEXT), /POC size/);
  await assert.rejects(new PbxInventoryReader(async () => Array(1001).fill({})).queues(CONTEXT), /POC size/);
});

async function withApi(routes: Route[], fn: (base: string) => Promise<void>, publicListener = false): Promise<void> {
  const options = { logger: captureLogger().logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'],
    trustedProxyCidrs: [], maxBodyBytes: 1024, rateLimitPerMinute: 100, routes };
  const api = new HttpApi(publicListener ? publicApiOptions(options) : options);
  await api.listen(0, '127.0.0.1');
  try { await fn(`http://127.0.0.1:${api.address()!.port}`); } finally { await api.close(); }
}
const base: InventoryReader = { contexts: async () => ['from-carrier', CONTEXT], extensions: async () => [], queues: async () => { throw new Error('SQL secret details'); } };

test('HTTP inventory requires exactly one context, refuses the retired tenant parameter and fails closed', async () => {
  let calls = 0;
  const reader: InventoryReader = { ...base, extensions: async (context) => { calls++; assert.equal(context, CONTEXT); return []; } };
  await withApi(pbxInventoryRoutes(reader, true, 'op-test'), async (url) => {
    for (const query of ['', '?context=', '?context=bad%20name', '?context=' + 'x'.repeat(41), '?context=a&context=b']) {
      const response = await fetch(`${url}/v1/admin/pbx/extensions${query}`);
      assert.equal(response.status, 422, query);
      assert.equal((await response.json() as { error: string }).error, 'context must be exactly one Asterisk context name');
    }
    for (const path of ['/v1/admin/pbx/extensions?iTenantId=1', `/v1/admin/pbx/queues?iTenantId=1&context=${CONTEXT}`, '/v1/admin/pbx/contexts?iTenantId=1']) {
      const response = await fetch(url + path);
      assert.equal(response.status, 422, path);
      assert.equal((await response.json() as { error: string }).error, 'iTenantId is retired; supply context');
    }
    assert.equal(calls, 0);
    const response = await fetch(`${url}/v1/admin/pbx/extensions?context=${CONTEXT}`);
    assert.deepEqual(await response.json(), { source: 'asterisk', pbxInstanceId: 'op-test', context: CONTEXT, provisioningEnabled: false, contexts: [CONTEXT], extensions: [] });
    const contexts = await fetch(`${url}/v1/admin/pbx/contexts`);
    assert.deepEqual(await contexts.json(), { source: 'asterisk', pbxInstanceId: 'op-test', contexts: ['from-carrier', CONTEXT] });
    const unavailable = await fetch(`${url}/v1/admin/pbx/queues?context=${CONTEXT}`);
    assert.equal(unavailable.status, 503);
    const text = await unavailable.text();
    assert.match(text, /pbx_inventory_unavailable/); assert.doesNotMatch(text, /SQL secret/);
  });
});

test('inventory items carry the managed flag and an unknown apply state; the contexts route declares the platform scope', async () => {
  const reader: InventoryReader = { ...base, extensions: async () => [{ id: '100-business-one', extension: '100', context: CONTEXT, callerId: null, transport: null, aors: '100-business-one', managed: true }] };
  const routes = pbxInventoryRoutes(reader, true, 'op-test', true);
  assert.deepEqual(routes.map(route => [route.pattern, route.operationsAccess]), [
    ['/v1/admin/pbx/contexts', { scope: 'platform' }],
    ['/v1/admin/pbx/extensions', { scope: 'context-query', query: 'context' }],
    ['/v1/admin/pbx/queues', { scope: 'context-query', query: 'context' }]]);
  await withApi(routes, async url => {
    const body = await (await fetch(`${url}/v1/admin/pbx/extensions?context=${CONTEXT}`)).json() as { provisioningEnabled: boolean; extensions: unknown[] };
    assert.equal(body.provisioningEnabled, true);
    assert.deepEqual(body.extensions, [{ id: '100-business-one', extension: '100', context: CONTEXT, callerId: null, transport: null, aors: '100-business-one', managed: true, applyState: 'unknown' }]);
  });
});

test('inventory is absent from public ingress and disabled inventory cannot read PBX', async () => {
  let calls = 0;
  const reader: InventoryReader = { contexts: async () => { calls++; return []; }, extensions: async () => { calls++; return []; }, queues: async () => [] };
  await withApi(pbxInventoryRoutes(reader, true, 'op-test'), async (url) => {
    assert.equal((await fetch(`${url}/v1/admin/pbx/extensions?context=${CONTEXT}`)).status, 403);
    assert.equal((await fetch(`${url}/v1/admin/pbx/contexts`)).status, 403);
  }, true);
  await withApi(pbxInventoryRoutes(reader, false, 'op-test'), async (url) => {
    assert.equal((await fetch(`${url}/v1/admin/pbx/extensions?context=${CONTEXT}`)).status, 503);
    assert.equal((await fetch(`${url}/v1/admin/pbx/contexts`)).status, 503);
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
