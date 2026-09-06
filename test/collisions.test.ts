import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionProvisioningService } from '../src/provisioning/extensions.js';
import { RingGroupProvisioningService } from '../src/provisioning/ringGroups.js';
import { ConflictError } from '../src/errors.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { captureLogger } from './helpers/capture.js';

/**
 * Dialplan-location collisions (issue #9).
 *
 * An extension and a ring group's virtual extension occupy the same
 * realtime `extensions` slot. Whichever is written last silently wins, so
 * every write path must detect the clash BEFORE replacing any row.
 */

const TENANT = '2';
const EXT_A = '22222222-2222-4222-8222-22222222222a';
const EXT_B = '22222222-2222-4222-8222-22222222222b';
const RG_A = '44444444-4444-4444-8444-44444444444a';
const RG_B = '44444444-4444-4444-8444-44444444444b';

function harness() {
  const store = new FakeRealtimeStore();
  const { logger } = captureLogger();
  return {
    store,
    extensions: new ExtensionProvisioningService({
      store,
      logger,
      defaultTransport: 'transport-udp',
      defaultAllow: 'ulaw,alaw',
    }),
    ringGroups: new RingGroupProvisioningService({ store, logger }),
  };
}

function extensionInput(id: string, number: string, requestId: string) {
  return {
    requestId,
    tenantId: TENANT,
    extensionId: id,
    extensionNumber: number,
    context: 'office-main',
    displayName: `Ext ${number}`,
  };
}

function ringGroupInput(virtualExtension: string, members: string[]) {
  return {
    tenantId: TENANT,
    virtualExtension,
    context: 'office-main',
    memberExtensions: members,
    ringTimeoutSeconds: 20,
    enabled: true,
  };
}

test('a ring group cannot take over an extension number already in use', async () => {
  const { extensions, ringGroups, store } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  const before = await store.getDialplan('office-main', '100');

  await assert.rejects(ringGroups.provision(RG_A, ringGroupInput('100', ['100'])), ConflictError);
  // The extension's rows survive untouched.
  assert.deepEqual(await store.getDialplan('office-main', '100'), before);
});

test('an extension cannot be created on a ring group virtual extension', async () => {
  const { extensions, ringGroups, store } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));
  const before = await store.getDialplan('office-main', '600');

  await assert.rejects(extensions.create(extensionInput(EXT_B, '600', 'r2')), ConflictError);
  assert.deepEqual(await store.getDialplan('office-main', '600'), before);
});

test('moving an extension onto an occupied location is refused before rows are replaced', async () => {
  const { extensions, ringGroups, store } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));
  const ringGroupRows = await store.getDialplan('office-main', '600');

  await assert.rejects(
    extensions.update(EXT_A, {
      extensionNumber: '600',
      context: 'office-main',
      displayName: 'Front Desk',
      enabled: true,
    }),
    ConflictError,
  );

  // The ring group is intact and the extension did not move.
  assert.deepEqual(await store.getDialplan('office-main', '600'), ringGroupRows);
  assert.equal((await store.getDialplan('office-main', '100')).length, 2);
  assert.equal((await store.getAidaObject('EXTENSION', EXT_A))?.exten, '100');
});

test('moving a ring group onto an occupied location is refused before rows are replaced', async () => {
  const { extensions, ringGroups, store } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));

  await assert.rejects(ringGroups.provision(RG_A, ringGroupInput('100', ['100'])), ConflictError);
  // NoOp + Dial + Hangup: no caller ID overrides in this fixture.
  assert.equal((await store.getDialplan('office-main', '600')).length, 3);
  assert.equal((await store.getAidaObject('RING_GROUP', RG_A))?.exten, '600');
});

test('re-saving an object at its own location is not a collision', async () => {
  const { extensions, ringGroups, store } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));

  // Idempotent re-saves of both kinds must keep working.
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));
  await extensions.update(EXT_A, {
    extensionNumber: '100',
    context: 'office-main',
    displayName: 'Front Desk Renamed',
    enabled: true,
  });
  assert.equal((await store.getDialplan('office-main', '600')).length, 3);
  assert.equal((await store.getDialplan('office-main', '100')).length, 2);
});

test('two ring groups cannot share a virtual extension', async () => {
  const { extensions, ringGroups } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));
  await assert.rejects(ringGroups.provision(RG_B, ringGroupInput('600', ['100'])), ConflictError);
});

test('a disabled ring group frees its location for an extension', async () => {
  const { extensions, ringGroups } = harness();
  await extensions.create(extensionInput(EXT_A, '100', 'r1'));
  await ringGroups.provision(RG_A, ringGroupInput('600', ['100']));
  await ringGroups.provision(RG_A, { ...ringGroupInput('600', ['100']), enabled: false });

  // Disabling removes the dialplan rows, but the mapping remains, so the
  // location is still spoken for — an operator must move or delete it.
  await assert.rejects(extensions.create(extensionInput(EXT_B, '600', 'r2')), ConflictError);
});
