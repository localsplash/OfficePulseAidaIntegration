import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpApi } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { nullLogger } from '../src/logging/logger.js';
import { pbxProvisioningRoutes, type PbxProvisioner } from '../src/pbx/provisioning.js';
import { pbxInventoryRoutes, parsePbxTenantScopes } from '../src/pbx/inventory.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';
import { openApi } from '../src/http/documentation.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-pbx-contract.json', import.meta.url), 'utf8')) as {
  name: string; method: string; path: string; status: number; body?: unknown; response?: unknown;
}[];

test('published OpenAPI fixture matches the served contract exactly', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('./fixtures/officepulse-openapi.json', import.meta.url), 'utf8')), openApi);
});
test('AidaAdmin shared contract fixtures exercise every native method and response', async t => {
  const did = '+19496501147';
  const writer: PbxProvisioner = {
    createExtension: async input => ({ extension: input.extension, sipUsername: input.endpointId, sipSecret: 'fixture-one-time-secret' }),
    deleteExtension: async () => {}, createQueue: async () => {}, deleteQueue: async () => {},
    setQueueMember: async () => {}, deleteQueueMember: async () => {}, setDid: async () => {}, deleteDid: async () => {},
    listDids: async () => [{ did, rows: didDialplanRows(did, { queue: 't7.sales', ringsBeforeAi: 6,
      schedule: { timeRange: '09:00-17:00', weekdays: 'mon-fri', timezone: 'America/Los_Angeles' } }) }],
  };
  const scopes = parsePbxTenantScopes(JSON.stringify({ 7: { contexts: ['tenant-seven'], queueNames: [], didContext: 'inbound', didNumbers: [did] } }));
  const reader = {
    extensions: async () => [{ id: '100-t7', context: 'tenant-seven', callerId: 'Front Desk', transport: 'transport-udp', aors: '100-t7' }],
    queues: async () => [{ id: 't7.sales', name: 't7.sales', strategy: 'ringall', members: [{ interface: 'PJSIP/100-t7', memberName: '100', penalty: 3, paused: true }] }],
  };
  const routes = [...pbxInventoryRoutes(reader, scopes, true, true), ...pbxProvisioningRoutes(writer, scopes, true)];
  assert.equal(fixture.length, routes.length);
  const api = new HttpApi({ logger: nullLogger(), readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'], trustedProxyCidrs: [], maxBodyBytes: 4096, rateLimitPerMinute: 100, routes });
  await api.listen(0, '127.0.0.1'); t.after(() => api.close());
  for (const entry of fixture) {
    const response = await fetch(`http://127.0.0.1:${api.address()!.port}${entry.path}`, { method: entry.method,
      headers: { 'content-type': 'application/json' }, ...(entry.body ? { body: JSON.stringify(entry.body) } : {}) });
    assert.equal(response.status, entry.status, entry.name);
    if (entry.status === 204) assert.equal(await response.text(), '');
    else assert.deepEqual(await response.json(), entry.response, entry.name);
  }
});
