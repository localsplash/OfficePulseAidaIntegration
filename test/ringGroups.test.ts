import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionProvisioningService } from '../src/provisioning/extensions.js';
import { RingGroupProvisioningService } from '../src/provisioning/ringGroups.js';
import { ValidationError } from '../src/errors.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { captureLogger } from './helpers/capture.js';

const TENANT = '2';
const RG_ID = '44444444-4444-4444-8444-444444444444';

async function setup(): Promise<{
  ringGroups: RingGroupProvisioningService;
  store: FakeRealtimeStore;
  usernames: Record<string, string>;
}> {
  const store = new FakeRealtimeStore();
  const { logger } = captureLogger();
  const extensions = new ExtensionProvisioningService({
    store,
    logger,
    defaultTransport: 'transport-udp',
    defaultAllow: 'ulaw,alaw',
  });
  const usernames: Record<string, string> = {};
  let n = 0;
  for (const exten of ['101', '102']) {
    const created = await extensions.create({
      requestId: `req-${exten}`,
      tenantId: TENANT,
      extensionId: `55555555-5555-4555-8555-55555555555${n++}`,
      extensionNumber: exten,
      context: 'office-main',
      displayName: `Ext ${exten}`,
    });
    usernames[exten] = created.sipUsername;
  }
  return { ringGroups: new RingGroupProvisioningService({ store, logger }), store, usernames };
}

const INPUT = {
  tenantId: TENANT,
  virtualExtension: '600',
  context: 'office-main',
  memberExtensions: ['101', '102'],
  ringTimeoutSeconds: 25,
  musicOnHoldClass: 'aida-default-tune',
  enabled: true,
};

test('provision writes deterministic RING_ALL rows in member order', async () => {
  const { ringGroups, store, usernames } = await setup();
  await ringGroups.provision(RG_ID, INPUT);
  const rows = await store.getDialplan('office-main', '600');
  assert.deepEqual(rows, [
    { priority: 1, app: 'NoOp', appdata: `aida-ring-group ${RG_ID}` },
    { priority: 2, app: 'Dial', appdata: `PJSIP/${usernames['101']}&PJSIP/${usernames['102']},25,m(aida-default-tune)` },
    { priority: 3, app: 'Hangup', appdata: '' },
  ]);
  // Saving again produces byte-identical rows (idempotent).
  await ringGroups.provision(RG_ID, INPUT);
  assert.deepEqual(await store.getDialplan('office-main', '600'), rows);
});

test('missing members fail validation listing each offender', async () => {
  const { ringGroups } = await setup();
  await assert.rejects(
    ringGroups.provision(RG_ID, { ...INPUT, memberExtensions: ['101', '999'] }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.deepEqual((err as ValidationError).details, ['member 999']);
      return true;
    },
  );
});

test('caller id name and no MOH class shape the rows deterministically', async () => {
  const { ringGroups, store, usernames } = await setup();
  await ringGroups.provision(RG_ID, {
    ...INPUT,
    musicOnHoldClass: undefined,
    callerIdName: 'Sales',
    ringTimeoutSeconds: undefined,
  });
  assert.deepEqual(await store.getDialplan('office-main', '600'), [
    { priority: 1, app: 'NoOp', appdata: `aida-ring-group ${RG_ID}` },
    { priority: 2, app: 'Set', appdata: 'CALLERID(name)=Sales' },
    { priority: 3, app: 'Dial', appdata: `PJSIP/${usernames['101']}&PJSIP/${usernames['102']},20` },
    { priority: 4, app: 'Hangup', appdata: '' },
  ]);
});

test('disable removes the dialplan rows but keeps the mapping', async () => {
  const { ringGroups, store } = await setup();
  await ringGroups.provision(RG_ID, INPUT);
  await ringGroups.provision(RG_ID, { ...INPUT, enabled: false });
  assert.deepEqual(await store.getDialplan('office-main', '600'), []);
  assert.equal((await store.getAidaObject('RING_GROUP', RG_ID))?.enabled, 0);
});

test('moving the virtual extension cleans up the old location', async () => {
  const { ringGroups, store } = await setup();
  await ringGroups.provision(RG_ID, INPUT);
  await ringGroups.provision(RG_ID, { ...INPUT, virtualExtension: '601' });
  assert.deepEqual(await store.getDialplan('office-main', '600'), []);
  assert.equal((await store.getDialplan('office-main', '601')).length, 3);
});

test('injection-shaped MOH class or virtual extension is rejected', async () => {
  const { ringGroups } = await setup();
  await assert.rejects(ringGroups.provision(RG_ID, { ...INPUT, musicOnHoldClass: 'x),Dial(evil' }), ValidationError);
  await assert.rejects(ringGroups.provision(RG_ID, { ...INPUT, virtualExtension: '600,1,Dial' }), ValidationError);
});

test('ring timeout outside bounds is rejected', async () => {
  const { ringGroups } = await setup();
  await assert.rejects(ringGroups.provision(RG_ID, { ...INPUT, ringTimeoutSeconds: 4 }), ValidationError);
  await assert.rejects(ringGroups.provision(RG_ID, { ...INPUT, ringTimeoutSeconds: 500 }), ValidationError);
});
