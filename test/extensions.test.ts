import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionProvisioningService } from '../src/provisioning/extensions.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { captureLogger } from './helpers/capture.js';

const TENANT = '2';
const EXT_ID = '22222222-2222-4222-8222-222222222222';

function makeService(store = new FakeRealtimeStore()): { service: ExtensionProvisioningService; store: FakeRealtimeStore; lines: string[] } {
  const { logger, lines } = captureLogger();
  const service = new ExtensionProvisioningService({
    store,
    logger,
    defaultTransport: 'transport-udp',
    defaultAllow: 'ulaw,alaw',
  });
  return { service, store, lines };
}

const CREATE = {
  requestId: 'req-1',
  tenantId: TENANT,
  extensionId: EXT_ID,
  extensionNumber: '100',
  context: 'office-main',
  displayName: 'Front Desk',
  callerIdNumber: '+15551230001',
};

test('create writes exact ps_aors/ps_auths/ps_endpoints/extensions rows in one transaction', async () => {
  const { service, store } = makeService();
  const result = await service.create(CREATE);

  assert.equal(result.status, 'created');
  assert.match(result.sipUsername, /^100-[0-9a-f]{6}$/);
  assert.equal((result.sipSecret as string).length >= 24, true);

  const aor = store.aors.get(result.sipUsername);
  assert.deepEqual(aor, { id: result.sipUsername, max_contacts: 1, remove_existing: 'yes' });

  const auth = store.auths.get(result.sipUsername);
  assert.deepEqual(auth, {
    id: result.sipUsername,
    auth_type: 'userpass',
    username: result.sipUsername,
    password: result.sipSecret,
  });

  const endpoint = store.endpoints.get(result.sipUsername);
  assert.deepEqual(endpoint, {
    id: result.sipUsername,
    transport: 'transport-udp',
    aors: result.sipUsername,
    auth: result.sipUsername,
    context: 'office-main',
    disallow: 'all',
    allow: 'ulaw,alaw',
    callerid: '"Front Desk" <+15551230001>',
  });

  assert.deepEqual(await store.getDialplan('office-main', '100'), [
    { priority: 1, app: 'Dial', appdata: `PJSIP/${result.sipUsername},20` },
    { priority: 2, app: 'Hangup', appdata: '' },
  ]);

  const object = await store.getAidaObject('EXTENSION', EXT_ID);
  assert.equal(object?.endpoint_id, result.sipUsername);
  assert.equal(object?.enabled, 1);
});

test('replay of a create reports already-applied and never re-serves the secret', async () => {
  const { service, store } = makeService();
  const first = await service.create(CREATE);
  const replay = await service.create(CREATE);
  // Same extension, no new rows — and crucially no secret: recovering a
  // lost response requires an explicit rotation.
  assert.equal(replay.status, 'already-applied');
  assert.equal(replay.sipUsername, first.sipUsername);
  assert.equal(replay.sipSecret, undefined);
  assert.equal(store.auths.size, 1);
  assert.equal(store.auths.get(first.sipUsername)?.password, first.sipSecret);
});

test('re-create with a different requestId conflicts and never returns the existing secret', async () => {
  const { service } = makeService();
  const created = await service.create(CREATE);
  await assert.rejects(service.create({ ...CREATE, requestId: 'req-2' }), (err: unknown) => {
    assert.ok(err instanceof ConflictError);
    assert.ok(!(err as Error).message.includes(created.sipSecret as string), 'no secret material in the error');
    return true;
  });
});

test('duplicate extension number in the same context conflicts', async () => {
  const { service } = makeService();
  await service.create(CREATE);
  await assert.rejects(
    service.create({ ...CREATE, requestId: 'req-2', extensionId: '33333333-3333-4333-8333-333333333333' }),
    ConflictError,
  );
});

test('partial write failure rolls back every row', async () => {
  const { service, store } = makeService();
  store.failOnCall = 'replaceDialplan';
  await assert.rejects(service.create(CREATE), /forced failure/);
  assert.equal(store.aors.size, 0);
  assert.equal(store.auths.size, 0);
  assert.equal(store.endpoints.size, 0);
  assert.equal(store.objects.size, 0);
  assert.equal(store.requests.size, 0);
});

test('validation rejects injection-shaped input before any SQL runs', async () => {
  const { service, store } = makeService();
  await assert.rejects(
    service.create({ ...CREATE, context: "office'; DROP TABLE ps_endpoints; --" }),
    ValidationError,
  );
  await assert.rejects(service.create({ ...CREATE, extensionNumber: '100; DELETE' }), ValidationError);
  await assert.rejects(service.create({ ...CREATE, callerIdName: 'x"<script>' }), ValidationError);
  await assert.rejects(service.create({ ...CREATE, callerIdNumber: 'not-a-number' }), ValidationError);
  assert.equal(store.endpoints.size, 0);
});

test('rotation returns a fresh secret exactly once and updates only ps_auths', async () => {
  const { service, store } = makeService();
  const created = await service.create(CREATE);
  const rotated = await service.rotateSecret(EXT_ID, { requestId: 'rot-1', reprovisionDevice: false });
  assert.equal(rotated.status, 'rotated');
  assert.notEqual(rotated.sipSecret, created.sipSecret);
  assert.equal(store.auths.get(created.sipUsername)?.password, rotated.sipSecret);

  // A replay confirms the rotation happened but does NOT re-serve its
  // secret; a different requestId for the same op still conflicts.
  const replay = await service.rotateSecret(EXT_ID, { requestId: 'rot-1', reprovisionDevice: false });
  assert.equal(replay.status, 'already-applied');
  assert.equal(replay.sipSecret, undefined);
  assert.equal(store.auths.get(created.sipUsername)?.password, rotated.sipSecret, 'replay must not rotate again');
  await assert.rejects(service.rotateSecret(EXT_ID, { requestId: 'req-1', reprovisionDevice: false }), ConflictError);
});

test('rotation with reprovisionDevice reports when no device is enrolled', async () => {
  const { service } = makeService();
  await service.create(CREATE);
  const rotated = await service.rotateSecret(EXT_ID, { requestId: 'rot-1', reprovisionDevice: true });
  assert.equal(rotated.provisioningResult?.ok, false);
});

test('disable removes dialplan rows and quarantines the endpoint; enable restores', async () => {
  const { service, store } = makeService();
  const created = await service.create(CREATE);
  await service.update(EXT_ID, { ...CREATE, enabled: false });
  assert.deepEqual(await store.getDialplan('office-main', '100'), []);
  assert.equal(store.endpoints.get(created.sipUsername)?.context, 'aida-disabled');
  assert.equal((await store.getAidaObject('EXTENSION', EXT_ID))?.enabled, 0);

  await service.update(EXT_ID, { ...CREATE, enabled: true });
  assert.equal((await store.getDialplan('office-main', '100')).length, 2);
  assert.equal(store.endpoints.get(created.sipUsername)?.context, 'office-main');
});

test('update of unknown extension is NotFound', async () => {
  const { service } = makeService();
  await assert.rejects(service.update(EXT_ID, { ...CREATE, enabled: true }), NotFoundError);
});

test('secrets never appear in provisioning logs', async () => {
  const { service, lines } = makeService();
  const created = await service.create(CREATE);
  const rotated = await service.rotateSecret(EXT_ID, { requestId: 'rot-1', reprovisionDevice: false });
  const joined = lines.join('\n');
  assert.ok(!joined.includes(created.sipSecret as string));
  assert.ok(!joined.includes(rotated.sipSecret as string));
});
