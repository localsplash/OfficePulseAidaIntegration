import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceAvailability } from '../src/http/voiceAvailability.js';
import type { ApiRequest, Route } from '../src/http/httpServer.js';

test('disabled voice blocks PBX changes, call commands and signed webhooks before effects', async () => {
  let invoked = 0;
  const routes: Route[] = [
    { method: 'POST', pattern: '/v1/provisioning/extensions' },
    { method: 'DELETE', pattern: '/v1/provisioning/dids/:id' },
    { method: 'POST', pattern: '/v1/calls/:callSessionId/commands' },
    { method: 'POST', pattern: '/v1/livekit/webhook', trusted: false, rawBody: true },
  ].map((route) => ({ ...route, handler: () => { invoked++; return { status: 200 }; } }));
  const request = {} as ApiRequest;
  for (const route of voiceAvailability(routes, false)) {
    assert.equal((await route.handler(request)).status, 503);
  }
  assert.equal(invoked, 0);
  assert.equal(voiceAvailability(routes, false)[3]?.trusted, false);
  assert.equal(voiceAvailability(routes, true), routes);
});

test('disabled voice still allows reading recorded call history', async () => {
  const route: Route = { method: 'GET', pattern: '/v1/calls/:id', handler: () => ({ status: 200, body: { id: 'recorded' } }) };
  assert.equal(voiceAvailability([route], false)[0], route);
});
