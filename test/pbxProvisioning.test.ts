import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { pbxProvisioningRoutes, type PbxProvisioner } from '../src/pbx/provisioning.js';
import { didDialplanRows, managedDid, normalizeWeekdays, parseDidSettings, recognizeDidRows } from '../src/pbx/managedDid.js';
import { captureLogger } from './helpers/capture.js';
import { ConflictError, NotFoundError } from '../src/errors.js';
const CTX = 'tenant-one'; const INBOUND = 'managed-inbound';
const scoped = (context = CTX) => `?context=${context}`;
const didQuery = (did = '%2B19496501147', extra = '') => `?context=${CTX}&didContext=${INBOUND}&authorizedDid=${did}${extra}`;
function fakeWriter(): PbxProvisioner & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    createExtension: async input => { calls.push({ method: 'createExtension', args: [input] }); return { extension: input.extension, sipUsername: input.endpointId, sipSecret: 'one-time-secret' }; },
    deleteExtension: async (...args) => { calls.push({ method: 'deleteExtension', args }); },
    // The writer decides between an owned legacy name and a context-namespaced id.
    createQueue: async (input, context) => { calls.push({ method: 'createQueue', args: [input, context] }); return { name: input.name === 'concierge' ? 'concierge' : `${context}.${input.name}` }; },
    deleteQueue: async (...args) => { calls.push({ method: 'deleteQueue', args }); },
    setQueueMember: async (...args) => { calls.push({ method: 'setQueueMember', args }); },
    deleteQueueMember: async (...args) => { calls.push({ method: 'deleteQueueMember', args }); },
    ownedQueues: async () => ['concierge', `${CTX}.sales`],
    listDids: async () => [],
    setDid: async (...args) => { calls.push({ method: 'setDid', args }); },
    deleteDid: async (...args) => { calls.push({ method: 'deleteDid', args }); },
  };
}
async function withApi(writer: PbxProvisioner, fn: (base: string, logs: ReturnType<typeof captureLogger>) => Promise<void>, enabled = true, publicListener = false) {
  const logs = captureLogger();
  const options = { logger: logs.logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'], trustedProxyCidrs: [], maxBodyBytes: 4096, rateLimitPerMinute: 300, routes: pbxProvisioningRoutes(writer, enabled, 'op-test') };
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
  const always = didDialplanRows('+19496501147', { queue: 'tenant-one.sales', ringsBeforeAi: 12, livekitDestination: '+19496501150' });
  assert.equal(always[1]!.appdata, 'aida-managed-did-v1,s,1(tenant-one.sales,12,+19496501150,*,*,UTC)');
  assert.equal(managedDid('+19496501147', { queue: 'tenant-one.sales', ringsBeforeAi: 12 }).ringTimeoutSeconds, 60);
  assert.equal(normalizeWeekdays('fri-mon&sun'), 'sun&mon&fri&sat');
});

test('create namespaces extensions and queues by context and returns the secret once without caching/logging', async () => {
  const writer = fakeWriter();
  await withApi(writer, async (base, logs) => {
    for (const context of ['tenant-one', 'tenant-two']) {
      const response = await fetch(`${base}/v1/admin/pbx/extensions${scoped(context)}`, request('POST', { extension: '1001', displayName: 'Front Desk' }));
      assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { extension: '1001', sipUsername: `1001-${context}`, sipSecret: 'one-time-secret', applyState: 'committed' });
      assert.deepEqual(writer.calls.at(-1)?.args, [{ extension: '1001', endpointId: `1001-${context}`, context, displayName: 'Front Desk', callerIdNumber: undefined }]);
      const queue = await fetch(`${base}/v1/admin/pbx/queues${scoped(context)}`, request('POST', { name: 'sales' }));
      assert.deepEqual(await queue.json(), { name: `${context}.sales`, strategy: 'ringall', applyState: 'committed' });
      assert.deepEqual(writer.calls.at(-1)?.args, [{ name: 'sales', strategy: 'ringall' }, context]);
    }
    // An owned legacy name is reused exactly as the writer reports it.
    const legacy = await fetch(`${base}/v1/admin/pbx/queues${scoped()}`, request('POST', { name: 'concierge' }));
    assert.deepEqual(await legacy.json(), { name: 'concierge', strategy: 'ringall', applyState: 'committed' });
    const member = await fetch(`${base}/v1/admin/pbx/queues/concierge/extensions/1001${scoped()}`, request('PUT', { penalty: 2, paused: true, context: CTX }));
    assert.equal(member.status, 200);
    assert.deepEqual(writer.calls.at(-1)?.args, [{ queue: 'concierge', extension: '1001', context: CTX, penalty: 2, paused: true }]);
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions/1001${scoped()}`, request('DELETE'))).status, 204);
    assert.deepEqual(writer.calls.at(-1)?.args, ['1001', CTX]);
    assert.equal((await fetch(`${base}/v1/admin/pbx/queues/concierge/extensions/1001${scoped()}`, request('DELETE'))).status, 204);
    assert.deepEqual(writer.calls.at(-1)?.args, ['concierge', '1001', CTX]);
    assert.equal((await fetch(`${base}/v1/admin/pbx/queues/concierge${scoped()}`, request('DELETE'))).status, 204);
    assert.deepEqual(writer.calls.at(-1)?.args, ['concierge', CTX]);
    writer.createExtension = async () => { throw new ConflictError('extension already exists'); };
    const replay = await fetch(`${base}/v1/admin/pbx/extensions${scoped()}`, request('POST', { extension: '1001' }));
    assert.equal(replay.status, 409); assert.doesNotMatch(await replay.text(), /one-time-secret/);
    assert.doesNotMatch(JSON.stringify(logs.lines), /one-time-secret/);
  });
});

test('strict input and context validation prevent any writer call on invalid requests', async () => {
  const writer = fakeWriter();
  await withApi(writer, async base => {
    for (const query of ['', '?context=', '?context=bad%20ctx', '?context=' + 'x'.repeat(41), `?context=${CTX}&context=${CTX}`]) {
      const response = await fetch(`${base}/v1/admin/pbx/extensions${query}`, request('POST', { extension: '1001' }));
      assert.equal(response.status, 422, query); assert.equal((await response.json() as { error: string }).error, 'context must be exactly one Asterisk context name');
    }
    const retired = await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1&context=${CTX}`, request('POST', { extension: '1001' }));
    assert.equal(retired.status, 422); assert.equal((await retired.json() as { error: string }).error, 'iTenantId is retired; supply context');
    for (const body of [{ extension: '1' }, { extension: '1001', context: 'tenant-two' }, { extension: '1001', displayName: 'x\nsecret' }, { extension: '1001', displayName: 'x'.repeat(24), callerIdNumber: '+19496501147' }, { extension: '1001', callerIdNumber: '1949' }, { extension: '1001', iTenantId: 2 }]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${scoped()}`, request('POST', body))).status, 422);
    }
    for (const body of [{ penalty: -1 }, { penalty: null }, { penalty: 101 }, { penalty: 0.5 }, { paused: 'false' }, { context: 'tenant-two' }]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/queues/concierge/extensions/1001${scoped()}`, request('PUT', body))).status, 422);
    }
    const valid = { queue: 'concierge', ringsBeforeAi: 6 };
    for (const body of [{ ...valid, aiProvider: 'livekit' }, { ...valid, aiDestination: '+19496501147' }, { ...valid, ringsBeforeAi: 0 }, { ...valid, ringsBeforeAi: 13 }, { ...valid, queue: 'q,evil' },
      ...[{ timeRange: '25:00-17:00', weekdays: 'mon-fri', timezone: 'UTC' }, { timeRange: '09:00-17:00', weekdays: 'mon-fri' }, { timeRange: '09:00-17:00', weekdays: 'everyday', timezone: 'UTC' }, { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/NotAZone' }].map(schedule => ({ ...valid, schedule }))]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501147${didQuery()}`, request('PUT', body))).status, 422);
    }
    // didContext is required exactly once, must fit the grammar, and must differ from the extension context.
    for (const query of [`?context=${CTX}&authorizedDid=%2B19496501147`, `?context=${CTX}&didContext=a&didContext=b&authorizedDid=%2B19496501147`, `?context=${CTX}&didContext=bad%20one`, `?didContext=${INBOUND}`]) {
      assert.equal((await fetch(`${base}/v1/admin/pbx/dids${query}`)).status, 422, query);
    }
    const same = await fetch(`${base}/v1/admin/pbx/dids?context=${CTX}&didContext=${CTX}&authorizedDid=%2B19496501147`);
    assert.equal(same.status, 422); assert.equal((await same.json() as { error: string }).error, 'didContext must be the inbound ingress context, not the extension context');
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501150${didQuery()}`, request('PUT', valid))).status, 422);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501150${didQuery()}`, request('DELETE'))).status, 404);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids${didQuery('bad')}`)).status, 422);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids${didQuery('%2B19496501160', '&authorizedDid=%2B19496501160')}`)).status, 422);
    assert.equal(writer.calls.length, 0);
    // <extension>-<context> must fit the installed 40-character endpoint id; the writer is never asked to truncate.
    const long = 'c'.repeat(30);
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${scoped(long)}`, request('POST', { extension: '123456789012' }))).status, 422);
    assert.equal(writer.calls.length, 0);
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${scoped(long)}`, request('POST', { extension: '123456789' }))).status, 201);
    assert.equal((writer.calls[0]?.args[0] as { endpointId: string }).endpointId.length, 40);
  });
});

test('DID GET reports owned, foreign, manual and absent routes without exposing arbitrary dialplan; PUT/DELETE pass both scopes', async () => {
  const writer = fakeWriter();
  writer.listDids = async (didContext, dids) => {
    assert.equal(didContext, INBOUND); assert.deepEqual(dids, ['+19496501147', '+19496501148', '+19496501149', '+19496501150']);
    return [
      { did: '+19496501147', rows: didDialplanRows('+19496501147', { queue: 'concierge', ringsBeforeAi: 6 }) },
      { did: '+19496501148', rows: [{ priority: 1, app: 'Dial', appdata: 'private-operator-destination' }] },
      { did: '+19496501150', rows: didDialplanRows('+19496501150', { queue: 'tenant-two.sales', ringsBeforeAi: 2 }) },
    ];
  };
  await withApi(writer, async base => {
    const authorized = '&authorizedDid=%2B19496501148&authorizedDid=%2B19496501149&authorizedDid=%2B19496501150';
    const response = await fetch(`${base}/v1/admin/pbx/dids${didQuery('%2B19496501147', authorized)}`);
    const body = await response.json() as { pbxInstanceId: string; context: string; didContext: string; provisioningEnabled: boolean; dids: Record<string, unknown>[] };
    assert.equal(body.pbxInstanceId, 'op-test'); assert.equal(body.context, CTX); assert.equal(body.didContext, INBOUND); assert.equal(body.provisioningEnabled, true);
    assert.equal(body.dids[0]!.managed, true); assert.equal(body.dids[0]!.applyState, 'committed');
    assert.equal(body.dids[1]!.availability, 'manual'); assert.equal(body.dids[2]!.availability, 'unconfigured');
    // A recognized route whose queue another context owns is neither adopted nor parsed into settings.
    assert.deepEqual(body.dids[3], { did: '+19496501150', managed: false, availability: 'manual', applyState: 'unknown' });
    assert.doesNotMatch(JSON.stringify(body), /private-operator|sipSecret|appdata|tenant-two/);
    const saved = await fetch(`${base}/v1/admin/pbx/dids/%2B19496501147${didQuery()}`, request('PUT', { queue: 'concierge', ringsBeforeAi: 6 }));
    assert.equal(saved.status, 200); assert.equal((await saved.json() as { ringTimeoutSeconds: number }).ringTimeoutSeconds, 30);
    const args = writer.calls.at(-1)!.args;
    assert.deepEqual([args[0], args[1], args[2], args[4]], [INBOUND, '+19496501147', 'concierge', CTX]);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501147${didQuery()}`, request('DELETE'))).status, 204);
    assert.deepEqual(writer.calls.at(-1)?.args, [INBOUND, '+19496501147', CTX]);
  });
});

test('fresh Identity Numbers can be configured without any static allowlist; an empty authorization reads nothing', async () => {
  const writer = fakeWriter(); let reads = 0;
  writer.listDids = async () => { reads++; return []; };
  await withApi(writer, async base => {
    const listed = await fetch(`${base}/v1/admin/pbx/dids${didQuery('%2B19496501160')}`);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { dids: unknown[] }).dids, [{ did: '+19496501160', managed: false, availability: 'unconfigured', applyState: 'unknown' }]);
    const saved = await fetch(`${base}/v1/admin/pbx/dids/%2B19496501160${didQuery('%2B19496501160')}`, request('PUT', { queue: 'concierge', ringsBeforeAi: 6 }));
    assert.equal(saved.status, 200); assert.equal(writer.calls.at(-1)?.method, 'setDid');
    assert.deepEqual((await (await fetch(`${base}/v1/admin/pbx/dids?context=${CTX}&didContext=${INBOUND}`)).json() as { dids: unknown[] }).dids, []);
    assert.equal(reads, 1);
    assert.equal((await fetch(`${base}/v1/admin/pbx/dids/%2B19496501160?context=${CTX}&didContext=${INBOUND}`, request('PUT', { queue: 'concierge', ringsBeforeAi: 6 }))).status, 422);
  });
});

test('missing/conflict/unexpected DB errors are safe and distinguishable; driver messages never reach logs', async () => {
  const writer = fakeWriter();
  await withApi(writer, async (base, logs) => {
    for (const [error, expected] of [[new NotFoundError('queue was not found'), 404], [new ConflictError('queue is referenced by a DID'), 409], [new Error('SQL password=one-time-secret'), 503]] as const) {
      writer.deleteQueue = async () => { throw error; };
      const response = await fetch(`${base}/v1/admin/pbx/queues/concierge${scoped()}`, request('DELETE'));
      assert.equal(response.status, expected); assert.doesNotMatch(await response.text(), /one-time-secret|SQL/);
    }
    assert.doesNotMatch(JSON.stringify(logs.lines), /one-time-secret|SQL password/);
  });
});

test('disabled provisioning has no routes and public ingress cannot reach any PBX route', async () => {
  assert.deepEqual(pbxProvisioningRoutes(fakeWriter(), false, 'op-test'), []);
  assert.deepEqual(pbxProvisioningRoutes(undefined, true, 'op-test'), []);
  await withApi(fakeWriter(), async base => { assert.equal((await fetch(`${base}/v1/admin/pbx/extensions${scoped()}`, request('POST', { extension: '1001' }))).status, 404); }, false);
  const writer = fakeWriter();
  await withApi(writer, async base => {
    for (const route of pbxProvisioningRoutes(writer, true, 'op-test')) {
      if (route.pattern.includes('/dids')) assert.equal(route.operationsAccess, undefined);
      else assert.deepEqual(route.operationsAccess, { scope: 'context-query', query: 'context' });
      const path = route.pattern.replace(':extension', '1001').replace(':queue', 'concierge').replace(':did', '%2B19496501147');
      assert.equal((await fetch(`${base}${path}${scoped()}`, request(route.method, route.method === 'GET' || route.method === 'DELETE' ? undefined : {}))).status, 403);
    }
    assert.equal(writer.calls.length, 0);
  }, true, true);
});
