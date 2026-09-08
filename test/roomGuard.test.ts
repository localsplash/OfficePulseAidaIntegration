import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRoomGuard } from '../src/devices/roomGuard.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { captureLogger } from './helpers/capture.js';

test('room sweeper removes revoked and wrong-business handsets without disturbing SIP/agent', async () => {
  const runtime = new FakeRuntimeStore();
  const call = runtime.seedSession({ tenantId: '1', destinationId: 'extension', destinationType: 'EXTENSION' });
  const removed: string[] = [];
  let enabled = true;
  const guard = new DeviceRoomGuard({ runtime, logger: captureLogger().logger,
    rooms: { listRooms: async () => [`aida-${call.id}`],
      listParticipants: async () => ['handset-valid', 'handset-revoked', 'handset-foreign', 'sip-caller', 'agent-aida'].map((identity) => ({ identity })),
      removeParticipant: async (_room, identity) => { removed.push(identity); } },
    devices: { getDevice: async (id) => id === 'revoked' ? undefined : { id, iTenantId: id === 'foreign' ? 2 : 1, extensionId: 'extension' } },
    config: { getExtension: async () => ({ id: 'extension', tenantId: '1', revision: 1, extensionNumber: '101', displayName: 'Desk', asteriskContext: 'office-1', enabled: true }), queueDestinationsForExtension: async () => [] },
    tenantEnabled: async () => enabled,
  });
  await guard.sweep();
  assert.deepEqual(removed, ['handset-revoked', 'handset-foreign']);
  removed.length = 0; enabled = false;
  await guard.sweep();
  assert.deepEqual(removed, ['handset-valid', 'handset-revoked', 'handset-foreign']);
});
