import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DidProvisioningService } from '../src/provisioning/dids.js';
import { ValidationError } from '../src/errors.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { captureLogger } from './helpers/capture.js';

const DID_ID = '66666666-6666-4666-8666-666666666666';

function makeService(store = new FakeRealtimeStore()): { service: DidProvisioningService; store: FakeRealtimeStore } {
  const { logger } = captureLogger();
  return {
    service: new DidProvisioningService({
      store,
      logger,
      officePulseInstanceId: 'op-primary',
      fastAgiHost: 'aida-integration.internal',
      fastAgiPort: 4573,
      disclosureContext: 'aida-disclosure',
      postBootstrapContext: 'aida-post-bootstrap',
    }),
    store,
  };
}

const INPUT = { didE164: '+15559870001', context: 'aida-inbound', enabled: true };

test('DID rows route disclosure-first into FastAGI and never dial a destination', async () => {
  const { service, store } = makeService();
  await service.provision(DID_ID, INPUT);
  const rows = await store.getDialplan('aida-inbound', '+15559870001');
  assert.deepEqual(rows, [
    { priority: 1, app: 'NoOp', appdata: `aida-did ${DID_ID}` },
    { priority: 2, app: 'Set', appdata: 'OFFICEPULSE_INSTANCE_ID=op-primary' },
    { priority: 3, app: 'Set', appdata: 'ASTERISK_LINKEDID=${CHANNEL(linkedid)}' },
    { priority: 4, app: 'Gosub', appdata: 'aida-disclosure,s,1' },
    { priority: 5, app: 'AGI', appdata: 'agi://aida-integration.internal:4573/bootstrap' },
    { priority: 6, app: 'Goto', appdata: 'aida-post-bootstrap,s,1' },
  ]);
  // Disclosure strictly precedes the AGI; nothing dials a destination.
  assert.ok(!rows.some((r) => r.app === 'Dial'));
  const disclosureIdx = rows.findIndex((r) => r.app === 'Gosub');
  const agiIdx = rows.findIndex((r) => r.app === 'AGI');
  assert.ok(disclosureIdx !== -1 && agiIdx !== -1 && disclosureIdx < agiIdx);
});

test('re-provision is idempotent; disable removes rows', async () => {
  const { service, store } = makeService();
  await service.provision(DID_ID, INPUT);
  await service.provision(DID_ID, INPUT);
  assert.equal((await store.getDialplan('aida-inbound', '+15559870001')).length, 6);
  await service.provision(DID_ID, { ...INPUT, enabled: false });
  assert.deepEqual(await store.getDialplan('aida-inbound', '+15559870001'), []);
});

test('a DID already routed by another did_route conflicts', async () => {
  const { service } = makeService();
  await service.provision(DID_ID, INPUT);
  await assert.rejects(service.provision('77777777-7777-4777-8777-777777777777', INPUT), ValidationError);
});

test('invalid E.164 or fastAgiPath is rejected', async () => {
  const { service } = makeService();
  await assert.rejects(service.provision(DID_ID, { ...INPUT, didE164: '555-CALL-NOW' }), ValidationError);
  await assert.rejects(service.provision(DID_ID, { ...INPUT, fastAgiPath: 'bootstrap;rm -rf' }), ValidationError);
});
