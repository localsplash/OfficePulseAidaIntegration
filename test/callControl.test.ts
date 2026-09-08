import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, type RouteDeps } from '../src/http/routes.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import type { ApiRequest, ApiResponse, Route } from '../src/http/httpServer.js';

/**
 * Allowlisted call-control endpoints backed by durable local state
 * (issue #9). Commands are idempotent by (session, key) and may not
 * redirect a call away from its pinned destination.
 */

const CALL_ID = '11111111-2222-4333-8444-555555555555';

interface Harness {
  routes: Route[];
  runtime: FakeRuntimeStore;
  takeoverCalls: unknown[];
}

function harness(): Harness {
  const runtime = new FakeRuntimeStore();
  runtime.seedSession({
    id: CALL_ID,
    tenantId: 'tenant-1',
    destinationType: 'EXTENSION',
    destinationId: 'ext-1',
  });
  const takeoverCalls: unknown[] = [];
  const deps = {
    runtime,
    destinationResolver: { async resolveDestination(_type: string, id: string, tenantId: string) {
      return id === 'ext-1' && tenantId === 'tenant-1' ? { context: 'office-main', exten: '100' } : undefined;
    } },
    takeover: {
      async takeover(command: unknown) {
        takeoverCalls.push(command);
        return { status: 'ringing' };
      },
      async acknowledgeDrain() {
        return { status: 'drained' };
      },
    },
    defaultRingTimeoutSeconds: 20,
  } as unknown as RouteDeps;

  return { routes: buildRoutes(deps), runtime, takeoverCalls };
}

function call(routes: Route[], method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const pattern = path.replace(CALL_ID, ':callSessionId');
  const route = routes.find((r) => r.method === method && r.pattern === pattern);
  assert.ok(route, `no route for ${method} ${pattern}`);
  const request: ApiRequest = {
    method,
    path,
    params: { callSessionId: CALL_ID },
    body,
    headers: {},
    clientIp: '127.0.0.1',
    correlationId: 'corr-1',
  };
  return Promise.resolve(route.handler(request));
}

const TAKEOVER = { commandType: 'TAKEOVER', idempotencyKey: 'key-1' };

test('a TAKEOVER command resolves the pinned destination and is accepted', async () => {
  const h = harness();
  const res = await call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER);
  assert.equal(res.status, 202);
  assert.deepEqual(h.takeoverCalls[0], {
    callSessionId: CALL_ID,
    idempotencyKey: 'key-1',
    destinationType: 'EXTENSION',
    context: 'office-main',
    exten: '100',
    ringTimeoutSeconds: 20,
    musicOnHoldClass: undefined,
  });
});

test('a duplicate command returns the recorded outcome without running twice', async () => {
  const h = harness();
  await call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER);
  const replay = await call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER);

  assert.equal(replay.status, 200);
  assert.equal((replay.body as { duplicate: boolean }).duplicate, true);
  assert.equal((replay.body as { status: string }).status, 'completed');
  assert.equal(h.takeoverCalls.length, 1, 'the command must run exactly once');
});

test('a command type outside the allowlist is refused', async () => {
  const h = harness();
  for (const commandType of ['HANGUP', 'TRANSFER', 'EVAL', '']) {
    await assert.rejects(
      call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, { commandType, idempotencyKey: 'k' }),
      /invalid call command/,
    );
  }
  assert.equal(h.takeoverCalls.length, 0);
});

test('a command may not redirect the call to another destination', async () => {
  const h = harness();
  await assert.rejects(
    call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, {
      ...TAKEOVER,
      destinationType: 'EXTENSION',
      destinationId: 'someone-elses-extension',
    }),
    /does not match/,
  );
  assert.equal(h.takeoverCalls.length, 0);
});

test('a command for an unknown call session is a 404, not a new session', async () => {
  const h = harness();
  const routes = h.routes;
  const route = routes.find((r) => r.pattern === '/v1/calls/:callSessionId/commands');
  await assert.rejects(
    Promise.resolve(
      route?.handler({
        method: 'POST',
        path: '/v1/calls/unknown/commands',
        params: { callSessionId: 'unknown' },
        body: TAKEOVER,
        headers: {},
        clientIp: '127.0.0.1',
        correlationId: 'c',
      } as ApiRequest),
    ),
    /no call session/,
  );
});

test('a missing idempotency key is refused before anything runs', async () => {
  const h = harness();
  await assert.rejects(
    call(h.routes, 'POST', `/v1/calls/${CALL_ID}/commands`, { commandType: 'TAKEOVER' }),
    /invalid call command/,
  );
  assert.equal(h.runtime.commands.size, 0);
});

test('a failed command is recorded as failed so a replay does not silently succeed', async () => {
  const runtime = new FakeRuntimeStore();
  runtime.seedSession({ id: CALL_ID, tenantId: 'tenant-1', destinationType: 'EXTENSION', destinationId: 'ext-1' });
  // Destination is not available locally, so resolution fails.
  const routes = buildRoutes({
    runtime,
    destinationResolver: { async resolveDestination() { return undefined; } },
    takeover: { async takeover() { throw new Error('unreached'); } },
    defaultRingTimeoutSeconds: 20,
  } as unknown as RouteDeps);

  await assert.rejects(call(routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER), /is not available/);
  assert.equal([...runtime.commands.values()][0]?.status, 'failed');
  const replay = await call(routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER);
  assert.equal(replay.status, 409, 'a handset must not interpret a recorded failure as acceptance');
  assert.equal((replay.body as { status: string }).status, 'failed');
  assert.equal(JSON.stringify(replay.body).includes('is not available'), false);
});

test('call state and durable events are readable back', async () => {
  const h = harness();
  await h.runtime.appendCallEvent(CALL_ID, { eventType: 'bootstrapped', payload: { profileId: 'profile-1' } });
  await h.runtime.appendCallEvent(CALL_ID, { eventType: 'answered' });

  const session = await call(h.routes, 'GET', `/v1/calls/${CALL_ID}`);
  assert.equal(session.status, 200);
  assert.equal((session.body as { id: string }).id, CALL_ID);

  const events = await call(h.routes, 'GET', `/v1/calls/${CALL_ID}/events`);
  const list = (events.body as { events: Array<{ eventType: string; sequenceNumber: number }> }).events;
  assert.deepEqual(
    list.map((e) => e.eventType),
    ['bootstrapped', 'answered'],
  );
  // Ordering is explicit, not incidental.
  assert.deepEqual(
    list.map((e) => e.sequenceNumber),
    [1, 2],
  );
});

test('the LiveKit webhook route is the only one exempt from CIDR gating', () => {
  const h = harness();
  const untrusted = h.routes.filter((r) => r.trusted === false);
  assert.equal(untrusted.length, 1);
  assert.equal(untrusted[0]?.pattern, '/v1/integrations/livekit/webhooks');
  // It must receive the raw body, or the signature cannot be verified.
  assert.equal(untrusted[0]?.rawBody, true);
});

test('canonical TAKEOVER fails before claim; DRAIN_ACK remains idempotent', async () => {
  const runtime = new FakeRuntimeStore();
  runtime.seedSession({ id: CALL_ID, tenantId: '1' });
  let drains = 0;
  const routes = buildRoutes({ runtime, takeover: { async acknowledgeDrain() { drains++; return { status: 'drained' }; } } } as unknown as RouteDeps);
  const before = await runtime.getCallSession(CALL_ID);
  const response = await call(routes, 'POST', `/v1/calls/${CALL_ID}/commands`, TAKEOVER);
  assert.equal(response.status, 503);
  assert.equal((response.body as { error: string }).error, 'native_destination_unavailable');
  assert.equal(runtime.commands.size, 0);
  assert.equal((await runtime.getCallSession(CALL_ID))?.version, before?.version);
  const drain = { commandType: 'DRAIN_ACK', idempotencyKey: 'drain' };
  assert.equal((await call(routes, 'POST', `/v1/calls/${CALL_ID}/commands`, drain)).status, 202);
  assert.equal((await call(routes, 'POST', `/v1/calls/${CALL_ID}/commands`, drain)).status, 200);
  assert.equal(drains, 1);
});
