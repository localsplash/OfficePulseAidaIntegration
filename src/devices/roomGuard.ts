import type { DeviceGrant } from './access.js';
import type { CallSessionRecord, RuntimeStore } from '../runtime/store.js';
import type { DeviceDirectory } from './access.js';
import type { Logger } from '../logging/logger.js';

export interface RoomGuardOptions {
  rooms: {
    listRooms(): Promise<string[]>;
    listParticipants(room: string): Promise<Array<{ identity: string }>>;
    removeParticipant(room: string, identity: string): Promise<void>;
  };
  devices: { getDevice(id: string): Promise<DeviceGrant | undefined> };
  runtime: Pick<RuntimeStore, 'getCallSession'>;
  config: DeviceDirectory;
  tenantEnabled: (id: number) => Promise<boolean>;
  logger: Logger;
}

/** Reconcile actual rooms after restart too: JWT expiry alone does not disconnect a participant. */
export class DeviceRoomGuard {
  private running = false;
  private readonly knownCalls = new Map<string, CallSessionRecord>();
  constructor(private readonly options: RoomGuardOptions) {}

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rooms = await this.options.rooms.listRooms();
      for (const room of this.knownCalls.keys()) if (!rooms.includes(room)) this.knownCalls.delete(room);
      for (const room of rooms) {
        if (!/^aida-[0-9a-f-]{36}$/i.test(room)) continue;
        let call;
        let storageAvailable = true;
        try { call = await this.options.runtime.getCallSession(room.slice(5)); }
        catch { storageAvailable = false; call = this.knownCalls.get(room); }
        if (call) this.knownCalls.set(room, call);
        // Another deployment may share a LiveKit project. Only touch our known call rooms.
        if (!call) continue;
        for (const participant of await this.options.rooms.listParticipants(room)) {
          if (!participant.identity.startsWith('handset-')) continue;
          let allowed = false;
          try {
            const device = await this.options.devices.getDevice(participant.identity.slice(8));
            if (storageAvailable && device && !call.endedAt && Number(call.tenantId) === device.iTenantId) {
              const extension = await this.options.config.getExtension(device.extensionId);
              const groups = await this.options.config.queueDestinationsForExtension(device.extensionId, String(device.iTenantId));
              allowed = !!extension?.enabled && Number(extension.tenantId) === device.iTenantId &&
                !!call.destinationId && [device.extensionId, ...groups].includes(call.destinationId) &&
                await this.options.tenantEnabled(device.iTenantId);
            }
          } catch { /* Fail closed for connected viewers when current access cannot be checked. */ }
          if (!allowed) await this.options.rooms.removeParticipant(room, participant.identity).catch(() => {
            this.options.logger.warn('handset room removal failed; retrying on next sweep', { room });
          });
        }
      }
    } catch {
      this.options.logger.warn('handset room authorization sweep unavailable; retrying');
    } finally { this.running = false; }
  }
}
