import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { credentialHash, deviceRoutes, type DeviceGrant, type DeviceStore } from '../src/devices/access.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import type { ApiRequest, Route } from '../src/http/httpServer.js';

function fixture() {
  const runtime = new FakeRuntimeStore();
  const call = runtime.seedSession({ tenantId: '1', destinationType: 'EXTENSION', destinationId: 'ext-1', roomName: 'aida-room' });
  const device: DeviceGrant = { id: 'device-1', iTenantId: 1, extensionId: 'ext-1' };
  const token = randomBytes(32).toString('base64url');
  const sessions = new Map([[credentialHash(token), device]]);
  const enrollments = new Map<string, { tenant: number; extension: string }>();
  const state = { enabled: true, extensionEnabled: true, groups: [] as string[], received: undefined as ApiRequest | undefined };
  const store: DeviceStore = {
    async issueEnrollment(hash, tenant, extension) { enrollments.set(hash, { tenant, extension }); },
    async consumeEnrollment(hash, _hardware, sessionHash) {
      const enrollment = enrollments.get(hash);
      if (!enrollment) return undefined;
      enrollments.delete(hash);
      const grant = { id: 'enrolled-device', iTenantId: enrollment.tenant, extensionId: enrollment.extension };
      sessions.set(sessionHash, grant);
      return grant;
    },
    async resolveSession(hash) { return sessions.get(hash); },
    async revokeDevice(id) { for (const [hash, grant] of sessions) if (grant.id === id) sessions.delete(hash); },
    async listCalls(tenant, destinations) { return [...runtime.sessions.values()].filter((c) => c.tenantId === tenant && destinations.includes(c.destinationId ?? '') && !c.endedAt); },
  };
  const commandRoute: Route = { method: 'POST', pattern: '/command', handler: async (req) => { state.received = req; return { status: 202, body: { status: 'accepted' } }; } };
  const routes = deviceRoutes({
    store, runtime, commandRoute,
    config: {
      async getExtension(id) { return id === 'ext-1' ? { id, revision: 1, tenantId: '1', extensionNumber: '101', displayName: 'Desk', asteriskContext: 'office-1', enabled: state.extensionEnabled } : undefined; },
      async ringGroupsForExtension() { return state.groups; },
    },
    tenantEnabled: async () => state.enabled,
    livekit: { url: 'wss://livekit.example.test', apiKey: 'test-key', apiSecret: 'test-secret' },
  });
  const invoke = async (pattern: string, body?: unknown, bearer: string | null = token, method = 'GET', id = call.id) => {
    const route = routes.find((r) => r.pattern === pattern && r.method === method)!;
    return route.handler({ method, path: pattern, params: { callSessionId: id }, body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, clientIp: '203.0.113.1', correlationId: 'test' });
  };
  return { runtime, call, device, token, state, sessions, enrollments, routes, invoke };
}

test('public call API denies absent and fabricated credentials', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('/v1/calls', undefined, null), { status: 401 });
  await assert.rejects(f.invoke('/v1/calls', undefined, 'x'.repeat(43)), { status: 401 });
  assert.equal(f.routes.find((r) => r.pattern === '/v1/provisioning/device-enrollments')?.trusted, undefined);
});

test('device call DTO excludes provisioning context and issues a short data-only token', async () => {
  const f = fixture();
  const result = await f.invoke('/v1/calls/:callSessionId');
  const body = result.body as { call: Record<string, unknown>; livekit: { token: string } };
  assert.equal(body.call.id, f.call.id);
  assert.equal(body.call.asteriskLinkedId, undefined);
  assert.equal(body.call.config, undefined);
  const jwt = JSON.parse(Buffer.from(body.livekit.token.split('.')[1]!, 'base64url').toString());
  assert.deepEqual(jwt.video, { roomJoin: true, room: 'aida-room', canPublish: false, canSubscribe: false, canPublishData: false });
  assert.ok(jwt.exp - Date.now() / 1000 <= 120);
});

test('both other-business and same-business other-extension calls are hidden', async () => {
  const f = fixture();
  const otherTenant = f.runtime.seedSession({ tenantId: '2', destinationId: 'ext-1' });
  const otherDesk = f.runtime.seedSession({ tenantId: '1', destinationId: 'ext-2' });
  await assert.rejects(f.invoke('/v1/calls/:callSessionId', undefined, f.token, 'GET', otherTenant.id), { status: 404 });
  await assert.rejects(f.invoke('/v1/calls/:callSessionId', undefined, f.token, 'GET', otherDesk.id), { status: 404 });
  const result = await f.invoke('/v1/calls');
  assert.deepEqual((result.body as { calls: { id: string }[] }).calls.map((c) => c.id), [f.call.id]);
});

test('business or extension disable takes effect for an existing device session', async () => {
  const f = fixture();
  f.state.enabled = false;
  await assert.rejects(f.invoke('/v1/calls'), { status: 403 });
  f.state.enabled = true;
  f.state.extensionEnabled = false;
  await assert.rejects(f.invoke('/v1/calls'), { status: 403 });
});

test('enrollment is single-use and only hashes are passed to persistence', async () => {
  const f = fixture();
  const issued = await f.invoke('/v1/provisioning/device-enrollments', { iTenantId: 1, extensionId: 'ext-1' }, null, 'POST');
  const token = (issued.body as { enrollmentToken: string }).enrollmentToken;
  assert.equal(f.enrollments.has(token), false);
  assert.equal(f.enrollments.has(credentialHash(token)), true);
  const body = { enrollmentToken: token, deviceId: 'hardware-1' };
  const enrolled = await f.invoke('/v1/devices/enroll', body, null, 'POST');
  const session = (enrolled.body as { token: string }).token;
  assert.equal(f.sessions.has(session), false);
  assert.equal(f.sessions.has(credentialHash(session)), true);
  await assert.rejects(f.invoke('/v1/devices/enroll', body, null, 'POST'), { status: 401 });
});

test('handset command preserves retry/version but cannot supply a PBX destination', async () => {
  const f = fixture();
  const body = { commandType: 'TAKEOVER', expectedCallVersion: 7, idempotencyKey: 'retry-1', destinationId: 'victim', ringTimeoutSeconds: 120 };
  await f.invoke('/v1/calls/:callSessionId/commands', body, f.token, 'POST');
  assert.deepEqual(f.state.received?.body, { commandType: 'TAKEOVER', expectedCallVersion: 7, idempotencyKey: credentialHash('device-1:retry-1') });
  await assert.rejects(f.invoke('/v1/calls/:callSessionId/commands', { ...body, commandType: 'DRAIN_ACK' }, f.token, 'POST'), { status: 400 });
  await assert.rejects(f.invoke('/v1/calls/:callSessionId/commands', { ...body, expectedCallVersion: undefined }, f.token, 'POST'), { status: 400 });
});

test('logout revokes bearer access and an ended call has no room token', async () => {
  const f = fixture();
  f.call.endedAt = new Date().toISOString();
  const result = await f.invoke('/v1/calls/:callSessionId');
  assert.equal((result.body as { livekit?: unknown }).livekit, undefined);
  await f.invoke('/v1/devices/logout', {}, f.token, 'POST');
  await assert.rejects(f.invoke('/v1/calls'), { status: 401 });
});

test('a configured ring-group membership grants only that group destination', async () => {
  const f = fixture();
  const group = f.runtime.seedSession({ tenantId: '1', destinationType: 'RING_GROUP', destinationId: 'group-1' });
  await assert.rejects(f.invoke('/v1/calls/:callSessionId', undefined, f.token, 'GET', group.id), { status: 404 });
  f.state.groups = ['group-1'];
  assert.equal((await f.invoke('/v1/calls/:callSessionId', undefined, f.token, 'GET', group.id)).status, 200);
});
