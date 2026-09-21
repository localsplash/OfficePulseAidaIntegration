import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialHash } from '../src/devices/access.js';
import { normalizedIp } from '../src/devices/registration.js';
import { handsetFixture } from './helpers/handset.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { captureLogger } from './helpers/capture.js';
const detail = '/v1/handset/calls/:callSessionId';
const takeover = detail + '/takeover';

test('attach matches registration, hashes a 32-byte token, and returns only the permitted device fields', async () => {
  const f = handsetFixture(); const result = await f.attach();
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/); assert.ok(f.store.sessions.has(credentialHash(result.token))); assert.ok(!f.store.sessions.has(result.token));
  assert.equal(result.device.endpointId, '411'); assert.equal(result.device.context, 'office');
  assert.equal(result.device.mac, undefined); assert.equal(result.device.publicIp, undefined);
  assert.ok(Date.parse(result.expiresAt) - Date.now() > 86390000);
  const me = (await f.invoke('/v1/handset/me', undefined, result.token)).body as any;
  assert.deepEqual(me.queues, [{ name: 'sales', channel: 'aida;officepulse-dev;office;sales' }]);
  assert.deepEqual(me.pusher, { key: 'public', cluster: 'us2' });
});

test('attach refuses absent, expired, ambiguous, wrong-public-IP and wrong-MAC registrations without disclosing other phones', async () => {
  for (const kind of ['absent', 'expired', 'ambiguous', 'public', 'mac']) {
    const f = handsetFixture();
    if (kind === 'absent') f.state.contacts = [];
    if (kind === 'expired') f.state.contacts[0]!.expiresAt = 0;
    if (kind === 'ambiguous') f.state.contacts.push({ ...f.state.contacts[0]!, endpointId: 'secret-phone' });
    const body = { ...f.attachBody, ...(kind === 'mac' ? { claimedMac: '000000000000' } : {}) };
    if (kind === 'mac') await assert.rejects(f.invoke('/v1/handset/attach', body, undefined, 'POST'), { status: 403, message: 'handset_mac_mismatch' });
    else {
      const result = await f.invoke('/v1/handset/attach', body, undefined, 'POST', '', kind === 'public' ? '203.0.113.2' : '203.0.113.1');
      assert.equal(result.status, kind === 'ambiguous' ? 409 : 403);
      assert.doesNotMatch(JSON.stringify(result.body), /secret-phone|endpoint|Grandstream/);
      assert.deepEqual((result.body as any).localIps, ['192.168.1.10']);
    }
  }
});

test('normalizes addresses, ignores loopback/link-local, and supports deliberate multi-WAN relaxation', async () => {
  assert.equal(normalizedIp('::ffff:c000:20a'), '192.0.2.10');
  assert.equal(normalizedIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
  const f = handsetFixture(false);
  const result = await f.invoke('/v1/handset/attach', { ...f.attachBody, localIps: ['127.0.0.1', '169.254.1.1', '::1', 'fe80::1', '::ffff:192.168.1.10'] }, undefined, 'POST', '', '203.0.113.99');
  assert.equal(result.status, 200);
  for (const ip of ['127.0.0.1', '169.254.1.1', '::1', 'fe80::1']) {
    const g = handsetFixture(); g.state.contacts[0]!.localIp = ip;
    assert.equal((await g.invoke('/v1/handset/attach', { ...g.attachBody, localIps: [ip] }, undefined, 'POST')).status, 403);
  }
});

test('replacement and logout revoke capabilities; a phone may attach after admin revoke', async () => {
  const f = handsetFixture(); const first = await f.attach(); const second = await f.attach();
  assert.deepEqual(f.state.removed, [first.device.id]);
  await assert.rejects(f.invoke('/v1/handset/me', undefined, first.token), { status: 401 });
  await f.invoke('/v1/admin/handsets/:id', undefined, undefined, 'DELETE', second.device.id);
  await assert.rejects(f.invoke('/v1/handset/me', undefined, second.token), { status: 401 });
  const third = await f.attach(); assert.equal((await f.invoke('/v1/handset/me', undefined, third.token)).status, 200);
  await f.invoke('/v1/handset/logout', {}, third.token, 'POST');
  await assert.rejects(f.invoke('/v1/handset/me', undefined, third.token), { status: 401 });
});

test('calls hide other instances, contexts, non-queue destinations, ended calls and non-members', async () => {
  const f = handsetFixture(); const { token } = await f.attach();
  for (const change of [{ officePulseInstanceId: 'other-dev' }, { pbxContext: 'other' }, { destinationType: 'EXTENSION' }, { destinationId: 'private' }, { endedAt: new Date().toISOString() }]) {
    const foreign = f.runtime.seedSession({ ...f.call, id: randomUUID(), ...change });
    await assert.rejects(f.invoke(detail, undefined, token, 'GET', foreign.id), { status: 404 });
  }
  const response = await f.invoke('/v1/handset/calls', undefined, token);
  assert.deepEqual((response.body as any).calls.map((c: any) => c.id), [f.call.id]);
  f.state.queues[0]!.members = []; f.state.now += 30001;
  assert.deepEqual((await f.invoke('/v1/handset/calls', undefined, token)).body, { calls: [] });
  await assert.rejects(f.invoke(detail, undefined, token), { status: 404 });
});

test('Local queue membership uses the dialable extension in the exact context; Agent diagnostics remain screening', async () => {
  const f = handsetFixture(); f.state.queues[0]!.members[0]!.interface = 'Local/411@office/n';
  const { token } = await f.attach(); f.call.state = 'agent-ready';
  assert.equal(((await f.invoke('/v1/handset/calls', undefined, token)).body as any).calls[0].state, 'screening');
  f.state.queues[0]!.members[0]!.interface = 'Local/411@elsewhere'; f.state.now += 30001;
  await assert.rejects(f.invoke(detail, undefined, token), { status: 404 });
});

test('detail grants exactly a hidden 120-second observer and rechecks registration within 30 seconds', async () => {
  const f = handsetFixture(); const { token, device } = await f.attach();
  const response = (await f.invoke(detail, undefined, token)).body as any;
  assert.equal(response.call.asteriskLinkedId, undefined); assert.equal(response.call.config, undefined);
  const jwt = JSON.parse(Buffer.from(response.livekit.token.split('.')[1], 'base64url').toString());
  assert.equal(jwt.sub, `handset-${device.id}`);
  assert.deepEqual(jwt.video, { room: f.call.roomName, roomJoin: true, hidden: true, canSubscribe: false, canPublish: false, canPublishData: false, canUpdateOwnMetadata: false });
  assert.ok(jwt.exp - Date.now() / 1000 <= 120);
  f.state.contacts = [{ ...f.state.contacts[0]!, userAgent: 'Grandstream/MAC-000000000000' }]; f.state.now += 30001;
  await assert.rejects(f.invoke(detail, undefined, token), { status: 403, message: 'handset_registration_changed' });
});

test('takeover targets only the authenticated endpoint, replays once, rejects a stale version and concurrent/answered calls', async () => {
  const f = handsetFixture(); const { token, device } = await f.attach();
  const body = { idempotencyKey: 'retry-1', expectedCallVersion: f.call.version, endpointId: 'victim', context: 'evil' };
  await assert.rejects(f.invoke(takeover, { ...body, expectedCallVersion: 99 }, token, 'POST'), { status: 409, message: 'stale_version' });
  assert.equal((await f.invoke(takeover, body, token, 'POST')).status, 202);
  assert.deepEqual(f.state.commands[0], { callSessionId: f.call.id, idempotencyKey: credentialHash(`${device.id}:retry-1`), destinationType: 'EXTENSION', context: 'aida-takeover', exten: '411', ringTimeoutSeconds: 15, deviceId: device.id });
  assert.equal(((await f.invoke(takeover, body, token, 'POST')).body as any).duplicate, true); assert.equal(f.state.commands.length, 1);
  await assert.rejects(f.invoke(takeover, { ...body, idempotencyKey: 'second' }, token, 'POST'), { status: 409, message: 'takeover_in_progress' });
  f.call.state = 'human-active';
  await assert.rejects(f.invoke(takeover, { ...body, idempotencyKey: 'third' }, token, 'POST'), { status: 409, message: 'already_taken' });
});

test('disabled voice allows management but issues no room token and executes no takeover', async () => {
  const f = handsetFixture(true, false); const { token } = await f.attach();
  assert.equal(((await f.invoke(detail, undefined, token)).body as any).livekit, undefined);
  assert.equal((await f.invoke(takeover, { idempotencyKey: 'retry', expectedCallVersion: 1 }, token, 'POST')).status, 503);
  assert.equal(f.state.commands.length, 0);
});

test('public attach ignores untrusted forwarding headers, is rate limited, and never caches credentials', async t => {
  const f = handsetFixture(); const api = new HttpApi(publicApiOptions({ routes: f.routes, logger: captureLogger().logger, readiness: new Readiness(),
    trustedServerCidrs: [], trustedProxyCidrs: [], maxBodyBytes: 4096, rateLimitPerMinute: 2 }));
  await api.listen(0, '127.0.0.1'); t.after(() => api.close());
  const url = `http://127.0.0.1:${api.address()!.port}`;
  const response = await fetch(url + '/v1/handset/attach', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.1' }, body: JSON.stringify(f.attachBody) });
  assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json() as any).publicIp, '127.0.0.1');
  assert.equal((await fetch(url + '/v1/handset/me')).status, 401);
  assert.equal((await fetch(url + '/v1/handset/me')).status, 429);
  assert.equal((await fetch(url + '/v1/admin/handsets?context=office')).status, 403);
});

test('two attached queue members cannot originate simultaneous takeovers', async () => {
  const f = handsetFixture();
  f.state.endpoints.push({ ...f.state.endpoints[0]!, id: '412', extension: '412' });
  f.state.queues[0]!.members.push({ ...f.state.queues[0]!.members[0]!, interface: 'PJSIP/412' });
  f.state.contacts.push({ ...f.state.contacts[0]!, endpointId: '412', localIp: '192.168.1.11', userAgent: 'Phone/MAC-000000000002' });
  const first = await f.attach();
  const second = (await f.invoke('/v1/handset/attach', { ...f.attachBody, appInstanceId: 'install-2', localIps: ['192.168.1.11'] }, undefined, 'POST')).body as any;
  const body = { idempotencyKey: 'same-key-on-two-phones', expectedCallVersion: f.call.version };
  const results = await Promise.allSettled([first.token, second.token].map(token => f.invoke(takeover, body, token, 'POST')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.message, 'takeover_in_progress'); assert.equal(f.state.commands.length, 1);
});

test('admin handset inventory exposes the stored model and display fields without credentials', async () => {
  const f = handsetFixture(); const attached = await f.attach();
  const response = await f.invoke('/v1/admin/handsets');
  assert.equal(response.status, 200);
  const device = (response.body as { handsets: Record<string, unknown>[] }).handsets[0]!;
  assert.equal(device.id, attached.device.id);
  assert.equal(device.deviceModel, f.attachBody.deviceModel);
  assert.equal(device.localIp, '192.168.1.10');
  assert.equal(device.publicIp, '203.0.113.1');
  assert.equal(device.token, undefined);
  assert.equal(device.tokenHash, undefined);
});
