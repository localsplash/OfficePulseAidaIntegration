import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { runtimeQueryRoutes } from '../src/http/runtimeQueryRoutes.js';
import type { RuntimeQueries } from '../src/runtime/queries.js';
import { captureLogger } from './helpers/capture.js';
import { Readiness } from '../src/readiness.js';

/** Records each call's arguments and answers with a marker naming the method. */
function recordingQueries(): { queries: RuntimeQueries; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const answer = (name: string) => async (...args: unknown[]) => { calls.push([name, args]); return [{ from: name }]; };
  const queries = {
    listCallSessions: answer('listCallSessions'), listControlCommands: answer('listControlCommands'),
    listParticipants: answer('listParticipants'), listWebhookDeliveries: answer('listWebhookDeliveries'),
    listDependencyStatus: answer('listDependencyStatus'), listFailedCommands: answer('listFailedCommands'),
    listEventsOfType: answer('listEventsOfType'),
  } as unknown as RuntimeQueries;
  return { queries, calls };
}

test('runtime reads for AidaAdmin parse their filters and stay off the public listener', async (t) => {
  const { queries, calls } = recordingQueries();
  const options = { logger: captureLogger().logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'], trustedProxyCidrs: [],
    maxBodyBytes: 1024, rateLimitPerMinute: 1000, routes: runtimeQueryRoutes(queries) };
  const api = new HttpApi(options);
  const publicApi = new HttpApi(publicApiOptions(options));
  await api.listen(0, '127.0.0.1'); await publicApi.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); await publicApi.close(); });
  const base = `http://127.0.0.1:${api.address()!.port}`;
  const read = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as Record<string, unknown> }; };

  const cases: Array<[string, string, string, unknown[]]> = [
    ['/v1/admin/calls', 'calls', 'listCallSessions', [{ state: 'all', tenantId: undefined, limit: undefined }]],
    ['/v1/admin/calls?state=orphaned&tenantId=42&limit=20', 'calls', 'listCallSessions', [{ state: 'orphaned', tenantId: '42', limit: 20 }]],
    ['/v1/admin/calls/call-1/commands', 'commands', 'listControlCommands', ['call-1']],
    ['/v1/admin/calls/call-1/participants', 'participants', 'listParticipants', ['call-1']],
    ['/v1/admin/runtime/webhook-deliveries?limit=5', 'deliveries', 'listWebhookDeliveries', [5]],
    ['/v1/admin/runtime/dependencies', 'dependencies', 'listDependencyStatus', []],
    ['/v1/admin/runtime/failed-commands', 'commands', 'listFailedCommands', [24, undefined]],
    ['/v1/admin/runtime/failed-commands?sinceHours=48&tenantId=7', 'commands', 'listFailedCommands', [48, '7']],
    ['/v1/admin/runtime/events?type=a&type=b&sinceHours=6', 'events', 'listEventsOfType', [['a', 'b'], 6, undefined]],
  ];
  for (const [path, key, method, args] of cases) {
    calls.length = 0;
    const { status, body } = await read(path);
    assert.equal(status, 200, path);
    assert.deepEqual(body[key], [{ from: method }], path);
    assert.deepEqual(calls, [[method, args]], path);
  }

  calls.length = 0;
  for (const path of ['/v1/admin/calls?state=live', '/v1/admin/calls?limit=-1', '/v1/admin/calls?tenantId=%20',
    '/v1/admin/runtime/events', '/v1/admin/runtime/failed-commands?sinceHours=1.5']) {
    assert.equal((await read(path)).status, 422, path);
  }
  assert.deepEqual(calls, [], 'an invalid filter never reaches the database');

  const publicBase = `http://127.0.0.1:${publicApi.address()!.port}`;
  assert.equal((await fetch(`${publicBase}/v1/admin/calls`)).status, 403);
});
