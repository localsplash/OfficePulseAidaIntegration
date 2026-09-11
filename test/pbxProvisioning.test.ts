import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { pbxProvisioningRoutes, type PbxProvisioner } from '../src/pbx/provisioning.js';
import { didDialplanRows, managedDid, normalizeWeekdays, parseDidSettings, recognizeDidRows } from '../src/pbx/managedDid.js';
import { parsePbxTenantScopes } from '../src/pbx/inventory.js';
import { captureLogger } from './helpers/capture.js';
import { ConflictError, NotFoundError } from '../src/errors.js';
const scopes = parsePbxTenantScopes(JSON.stringify({
  1: { contexts: ['tenant-one'], queueNames: ['concierge'], didContext: 'managed-inbound', didNumbers: ['+19496501147', '+19496501148', '+19496501149'] },
  2: { contexts: ['tenant-two'], queueNames: ['other'], didContext: 'managed-inbound', didNumbers: ['+19496501150'] },
}));
function fakeWriter(): PbxProvisioner & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    createExtension: async input => { calls.push({ method: 'createExtension', args: [input] }); return { extension: input.extension, sipUsername: input.endpointId, sipSecret: 'one-time-secret' }; },
    deleteExtension: async (...args) => { calls.push({ method: 'deleteExtension', args }); },
    createQueue: async (...args) => { calls.push({ method: 'createQueue', args }); },
    deleteQueue: async (...args) => { calls.push({ method: 'deleteQueue', args }); },
    setQueueMember: async (...args) => { calls.push({ method: 'setQueueMember', args }); },
    deleteQueueMember: async (...args) => { calls.push({ method: 'deleteQueueMember', args }); },
    listDids: async () => [],
    setDid: async (...args) => { calls.push({ method: 'setDid', args }); },
    deleteDid: async (...args) => { calls.push({ method: 'deleteDid', args }); },
  };
}
async function withApi(writer: PbxProvisioner, fn: (base: string, logs: ReturnType<typeof captureLogger>) => Promise<void>, enabled = true, publicListener = false) {
  const logs = captureLogger();
  const options = { logger: logs.logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'], trustedProxyCidrs: [], maxBodyBytes: 4096, rateLimitPerMinute: 300, routes: pbxProvisioningRoutes(writer, scopes, enabled) };
  const api = new HttpApi(publicListener ? publicApiOptions(options) : options);
  await api.listen(0, '127.0.0.1');
  try { await fn(`http://127.0.0.1:${api.address()!.port}`, logs); } finally { await api.close(); }
}
const request = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('DID metadata and shared-subroutine arguments roundtrip exactly; no provider selection or per-DID branching', () => {
  const settings = parseDidSettings({ queue: 'concierge', ringsBeforeAi: 6, schedule: { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/Los_Angeles' } });
  const rows = didDialplanRows('+19496501147', settings);
  assert.deepEqual(rows, [
    { priority: 1, app: 'NoOp', appdata: 'OfficePulse:did:v1:+19496501147' },
    { priority: 2, app: 'Gosub', appdata: 'aida-managed-did-v1,s,1(concierge,6,+19496501147,09:00-17:00,mon&tue&wed&thu&fri,America/Los_Angeles)' },
    { priority: 3, app: 'Hangup', appdata: '' },
  ]);
  assert.deepEqual(recognizeDidRows('+19496501147', rows), { ...settings, livekitDestination: '+19496501147' });
  for (const changed of [rows.slice(1), [...rows, { priority: 4, app: 'NoOp', appdata: 'manual' }], rows.map(row => ({ ...row, appdata: row.appdata.replace('v1', 'v2') }))]) {
    assert.equal(recognizeDidRows('+19496501147', changed), undefined);
  }
  assert.equal(recognizeDidRows('+19496501150', rows), undefined);
  const always = didDialplanRows('+19496501147', { queue: 't1.sales', ringsBeforeAi: 12, livekitDestination: '+19496501150' });
  assert.equal(always[1]!.appdata, 'aida-managed-did-v1,s,1(t1.sales,12,+19496501150,*,*,UTC)');
  assert.equal(managedDid('+19496501147', { queue: 't1.sales', ringsBeforeAi: 12 }).ringTimeoutSeconds, 60);
  assert.equal(normalizeWeekdays('fri-mon&sun'), 'sun&mon&fri&sat');
});

test('create namespaces overlapping extensions/queues per tenant and returns the secret once without caching/logging', async () => {
  const writer = fakeWriter();
  await withApi(writer, async (base, logs) => {
    for (const id of [1, 2]) {
      const response = await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=${id}`, request('POST', { extension: '1001', displayName: 'Front Desk' }));
      assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { extension: '1001', sipUsername: `1001-t${id}`, sipSecret: 'one-time-secret', applyState: 'committed' });
      const queue = await fetch(`${base}/v1/admin/pbx/queues?iTenantId=${id}`, request('POST', { name: 'sales' }));
      assert.deepEqual(await queue.json(), { name: `t${id}.sales`, strategy: 'ringall', applyState: 'committed' });
    }
    const member = await fetch(`${base}/v1/admin/pbx/queues/concierge/extensions/1001?iTenantId=1`, request('PUT', { penalty: 2, paused: true }));
    assert.equal(member.status, 200);
    assert.deepEqual(writer.calls.at(-1)?.args, [{ queue: 'concierge', extension: '1001', endpointId: '1001-t1', context: 'tenant-one', penalty: 2, paused: true }, scopes.get('1')]);
    writer.createExtension = async () => { throw new ConflictError('extension already exists'); };
    const replay = await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`, request('POST', { extension: '1001' }));
    assert.equal(replay.status, 409); assert.doesNotMatch(await replay.text(), /one-time-secret/);
    assert.doesNotMatch(JSON.stringify(logs.lines), /one-time-secret/);
  });
});

test('strict input and canonical tenant validation prevent any writer call on invalid requests', async () => {
  const writer = fakeWriter();
  await withApi(writer, async base => {
    for (const query of ['', '?iTenantId=01', '?iTenantId=0', '?iTenantId=-1', '?iTenantId=1&iTenantId=1', '?iTenantId=9007199254740992']) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${query}`, request('POST', { extension: '1001' }))).status, 422);
    }
    for (const body of [{ extension: '1' }, { extension: '1001', context: 'tenant-two' }, { extension: '1001', displayName: 'x\nsecret' }, { extension: '1001', displayName: 'x'.repeat(24), callerIdNumber: '+19496501147' }, { extension: '1001', callerIdNumber: '1949' }, { extension: '1001', iTenantId: 2 }]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`, request('POST', body))).status, 422);
    }
    for (const body of [{ penalty: -1 }, { penalty: null }, { penalty: 101 }, { penalty: 0.5 }, { paused: 'false' }, { context: 'tenant-two' }]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/queues/concierge/extensions/1001?iTenantId=1`, request('PUT', body))).status, 422);
    }
    const valid = { queue: 'concierge', ringsBeforeAi: 6 };
    for (const body of [{ ...valid, aiProvider: 'livekit' }, { ...valid, aiDestination: '+19496501147' }, { ...valid, ringsBeforeAi: 0 }, { ...valid, ringsBeforeAi: 13 }, { ...valid, queue: 'q,evil' },
      ...[{ timeRange: '25:00-17:00', weekdays: 'mon-fri', timezone: 'UTC' }, { timeRange: '09:00-17:00', weekdays: 'mon-fri' }, { timeRange: '09:00-17:00', weekdays: 'everyday', timezone: 'UTC' }, { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/NotAZone' }].map(schedule => ({ ...valid, schedule }))]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501147?iTenantId=1`, request('PUT', body))).status, 422);
    }
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501150?iTenantId=1`, request('PUT', valid))).status, 422);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501150?iTenantId=1`, request('DELETE'))).status, 404);
    assert.equal(writer.calls.length, 0);
  });
});

test('DID GET reports recognized, manual and absent routes without exposing arbitrary dialplan; PUT returns committed', async () => {
  const writer = fakeWriter();
  writer.listDids = async () => [
    { did: '+19496501147', rows: didDialplanRows('+19496501147', { queue: 'concierge', ringsBeforeAi: 6 }) },
    { did: '+19496501148', rows: [{ priority: 1, app: 'Dial', appdata: 'private-operator-destination' }] },
  ];
  await withApi(writer, async base => {
    const response = await fetch(`${base}/v1/admin/pbx/dids?iTenantId=1`);
    const body = await response.json() as { dids: Record<string, unknown>[] };
    assert.equal(body.dids[0]!.managed, true); assert.equal(body.dids[0]!.applyState, 'committed');
    assert.equal(body.dids[1]!.availability, 'manual'); assert.equal(body.dids[2]!.availability, 'unconfigured');
    assert.doesNotMatch(JSON.stringify(body), /private-operator|sipSecret|appdata/);
    const saved = await fetch(`${base}/v1/admin/pbx/dids/%2B19496501147?iTenantId=1`, request('PUT', { queue: 'concierge', ringsBeforeAi: 6 }));
    assert.equal(saved.status, 200); assert.equal((await saved.json() as { ringTimeoutSeconds: number }).ringTimeoutSeconds, 30);
    assert.equal(writer.calls[0]!.args[1], '+19496501147');
  });
});

test('missing/conflict/unexpected DB errors are safe and distinguishable; driver messages never reach logs', async () => {
  const writer = fakeWriter();
  await withApi(writer, async (base, logs) => {
    for (const [error, expected] of [[new NotFoundError('queue was not found'), 404], [new ConflictError('queue is referenced by a DID'), 409], [new Error('SQL password=one-time-secret'), 503]] as const) {
      writer.deleteQueue = async () => { throw error; };
      const response = await fetch(`${base}/v1/admin/pbx/queues/concierge?iTenantId=1`, request('DELETE'));
      assert.equal(response.status, expected); assert.doesNotMatch(await response.text(), /one-time-secret|SQL/);
    }
    assert.doesNotMatch(JSON.stringify(logs.lines), /one-time-secret|SQL password/);
  });
});

test('disabled provisioning has no routes and public ingress cannot reach any PBX route', async () => {
  assert.deepEqual(pbxProvisioningRoutes(fakeWriter(), scopes, false), []);
  assert.deepEqual(pbxProvisioningRoutes(undefined, scopes, true), []);
  await withApi(fakeWriter(), async base => { assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`, request('POST', { extension: '1001' }))).status, 404); }, false);
  const writer = fakeWriter();
  await withApi(writer, async base => {
    for (const route of pbxProvisioningRoutes(writer, scopes, true)) {
      assert.deepEqual(route.operationsAccess, { scope: 'tenant-query', query: 'iTenantId' });
      const path = route.pattern.replace(':extension', '1001').replace(':queue', 'concierge').replace(':did', '%2B19496501147');
      assert.equal((await fetch(`${base}${path}?iTenantId=1`, request(route.method, route.method === 'GET' || route.method === 'DELETE' ? undefined : {}))).status, 403);
    }
    assert.equal(writer.calls.length, 0);
  }, true, true);
});
