import type { DeviceGrant, DeviceDirectory } from './access.js';
import type { CallSessionRecord, RuntimeStore } from '../runtime/store.js';
import type { Logger } from '../logging/logger.js';

export interface RoomGuardOptions {
  rooms: {
    listRooms(): Promise<string[]>;
    listParticipants(room: string): Promise<Array<{ identity: string }>>;
    removeParticipant(room: string, identity: string): Promise<void>;
  };
  pbxInstanceId: string;
  devices: { getDevice(id: string): Promise<DeviceGrant | undefined> };
  runtime: Pick<RuntimeStore, 'getCallSession'>;
  directory: DeviceDirectory;
  logger: Logger;
}
/** JWT expiry does not disconnect an existing viewer. Reconcile rooms after restarts too. */
export class DeviceRoomGuard {
  private running = false;
  private readonly knownCalls = new Map<string, CallSessionRecord>();
  constructor(private readonly options: RoomGuardOptions) {}
  async removeDevice(deviceId: string): Promise<void> {
    try {
      for (const room of await this.options.rooms.listRooms()) {
        if (!/^aida-[0-9a-f-]{36}$/i.test(room)) continue;
        const call = await this.options.runtime.getCallSession(room.slice(5));
        if (call?.officePulseInstanceId !== this.options.pbxInstanceId) continue;
        const identity = `handset-${deviceId}`;
        if ((await this.options.rooms.listParticipants(room)).some(p => p.identity === identity)) await this.options.rooms.removeParticipant(room, identity);
      }
    } catch { this.options.logger.warn('handset room removal unavailable; the authorization sweep will retry'); }
  }
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rooms = await this.options.rooms.listRooms();
      for (const room of this.knownCalls.keys()) if (!rooms.includes(room)) this.knownCalls.delete(room);
      for (const room of rooms) {
        if (!/^aida-[0-9a-f-]{36}$/i.test(room)) continue;
        let call; let storageAvailable = true;
        try { call = await this.options.runtime.getCallSession(room.slice(5)); }
        catch { storageAvailable = false; call = this.knownCalls.get(room); }
        if (!call || call.officePulseInstanceId !== this.options.pbxInstanceId) continue;
        this.knownCalls.set(room, call);
        for (const participant of await this.options.rooms.listParticipants(room)) {
          if (!participant.identity.startsWith('handset-')) continue;
          let allowed = false;
          try {
            const d = await this.options.devices.getDevice(participant.identity.slice(8));
            allowed = !!(storageAvailable && d && await this.options.directory.allows(d, call) && await this.options.directory.binding(d));
          } catch { /* Fail closed when current authorization cannot be checked. */ }
          if (!allowed) await this.options.rooms.removeParticipant(room, participant.identity).catch(() => {
            this.options.logger.warn('handset room removal failed; retrying on next sweep', { room });
          });
        }
      }
    } catch { this.options.logger.warn('handset room authorization sweep unavailable; retrying'); }
    finally { this.running = false; }
  }
}
