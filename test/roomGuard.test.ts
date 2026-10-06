import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRoomGuard } from '../src/devices/roomGuard.js';
import { handsetFixture, sampleDevice } from './helpers/handset.js';
import { captureLogger } from './helpers/capture.js';

test('room guard removes revoked, wrong-context and reassigned viewers, preserving other PBXs, SIP and Agent', async () => {
  const f = handsetFixture(); const { device } = await f.attach(); const removed: string[] = [];
  const foreign = f.runtime.seedSession({ officePulseInstanceId: 'another-dev' });
  const guard = new DeviceRoomGuard({ runtime: f.runtime, logger: captureLogger().logger, directory: f.directory, pbxInstanceId: 'officepulse-dev',
    rooms: { listRooms: async () => [`aida-${f.call.id}`, `aida-${foreign.id}`],
      listParticipants: async () => [`handset-${device.id}`, 'handset-revoked', 'handset-foreign', 'sip-caller', 'agent-aida'].map(identity => ({ identity })),
      removeParticipant: async (room, identity) => { removed.push(`${room}/${identity}`); } },
    devices: { getDevice: async id => id === 'revoked' ? undefined : id === 'foreign' ? sampleDevice({ context: 'another' }) : f.store.getDevice(id) },
  });
  await guard.sweep();
  assert.deepEqual(removed, [`aida-${f.call.id}/handset-revoked`, `aida-${f.call.id}/handset-foreign`]);
  removed.length = 0; f.state.contacts = []; f.state.now += 30001;
  await guard.sweep(); assert.equal(removed.length, 3);
  assert.ok(removed.every(id => !id.includes(foreign.id) && !id.includes('sip-caller') && !id.includes('agent-aida')));
});
