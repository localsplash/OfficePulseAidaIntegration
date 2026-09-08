import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, type RouteDeps } from '../src/http/routes.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { pbxInventoryRoutes } from '../src/pbx/inventory.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { captureLogger } from './helpers/capture.js';
import { Readiness } from '../src/readiness.js';
import { assembleApiRoutes } from '../src/http/apiRoutes.js';
import { voiceAvailability } from '../src/http/voiceAvailability.js';
import { migrateRuntime } from '../src/runtime/migrate.js';

test('canonical HTTP serves observed calls and has no legacy mutation/admission routes', async () => {
  const runtime = new FakeRuntimeStore();
  const call = runtime.seedSession({ id: 'existing-call', tenantId: '1' });
  const routes = assembleApiRoutes(pbxInventoryRoutes({ extensions: async () => [], queues: async () => [] }, new Map(), false),
    voiceAvailability(buildRoutes({ runtime } as unknown as RouteDeps), false));
  assert.ok(routes.every(route => !route.pattern.startsWith('/v1/provisioning/')));
  const options = { logger: captureLogger().logger, readiness: new Readiness(), trustedServerCidrs: ['127.0.0.1/32'], trustedProxyCidrs: [],
    maxBodyBytes: 1024, rateLimitPerMinute: 100, routes };
  const api = new HttpApi(options);
  const publicApi = new HttpApi(publicApiOptions(options));
  await api.listen(0, '127.0.0.1'); await publicApi.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${api.address()!.port}`;
    const found = await fetch(`${base}/v1/admin/calls/${call.id}`);
    assert.equal(found.status, 200); assert.equal((await found.json() as { id: string }).id, call.id);
    assert.equal((await fetch(`${base}/v1/admin/calls/missing`)).status, 404);
    assert.equal((await fetch(`${base}/v1/admin/pbx/extensions?iTenantId=1`)).status, 503);
    for (const path of ['/v1/provisioning/extensions', '/v1/provisioning/ring-groups/group', '/v1/provisioning/dids/did',
      '/v1/provisioning/handsets', '/v1/provisioning/device-enrollments', '/v1/devices/enroll']) {
      assert.equal((await fetch(`${base}${path}`, { method: 'POST' })).status, 404, path);
    }
    assert.equal((await fetch(`${base}/v1/provisioning/devices/device`, { method: 'DELETE' })).status, 404);
    for (const path of ['/v1/admin/calls/existing-call/commands', '/v1/integrations/livekit/webhooks']) {
      const result = await fetch(`${base}${path}`, { method: 'POST' });
      assert.equal(result.status, 503);
      assert.equal((await result.json() as { error: string }).error, 'voice_unavailable');
    }
    const publicBase = `http://127.0.0.1:${publicApi.address()!.port}`;
    assert.equal((await fetch(`${publicBase}/healthz`)).status, 200);
    assert.equal((await fetch(`${publicBase}/v1/admin/calls/${call.id}`)).status, 403);
  } finally { await api.close(); await publicApi.close(); }
});

test('cleanup migration refuses the external vendor database before opening a connection', async () => {
  await assert.rejects(migrateRuntime({ host: 'must-not-connect', port: 3306, user: 'unused', password: 'unused', database: 'asterisk' }), /may only target/);
});
