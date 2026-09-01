import type { NocoReadApi, NocoRecord, NocoWhere } from '../../src/nocodb/api.js';
import type { CallMetadata, DispatchResult, LiveKitApi } from '../../src/livekit/client.js';
import type { CallAlert, Notifier } from '../../src/notify/pusher.js';

/**
 * In-memory NocoDB base. Records are plain rows exactly as the v2 API
 * returns them, so the repository's own coercion is under test rather than
 * bypassed by pre-typed fixtures.
 */
export class FakeNocoApi implements NocoReadApi {
  tables = new Map<string, NocoRecord[]>();
  failOn: string | null = null;
  calls: Array<{ table: string; where: NocoWhere[] }> = [];

  seed(table: string, records: NocoRecord[]): void {
    this.tables.set(table, records);
  }

  async listRecords(table: string, where: NocoWhere[], limit = 200): Promise<NocoRecord[]> {
    if (this.failOn === table || this.failOn === '*') throw new Error(`forced NocoDB failure for ${table}`);
    this.calls.push({ table, where });
    const rows = this.tables.get(table) ?? [];
    const matched = rows.filter((row) =>
      where.every((clause) => {
        const value = row[clause.field];
        return clause.op === 'eq' ? value === clause.value : value !== clause.value;
      }),
    );
    return matched.slice(0, limit);
  }

  async ping(): Promise<boolean> {
    return this.failOn === null;
  }
}

export class FakeLiveKit implements LiveKitApi {
  rooms: string[] = [];
  dispatches: Array<{ roomName: string; metadata: CallMetadata }> = [];
  published: Array<{ roomName: string; topic: string; payload: Record<string, unknown> }> = [];
  failCreateRoom = false;
  failDispatch = false;

  async createRoom(roomName: string): Promise<void> {
    if (this.failCreateRoom) throw new Error('livekit createRoom failed');
    this.rooms.push(roomName);
  }

  async dispatchAidaPrime(roomName: string, metadata: CallMetadata): Promise<DispatchResult> {
    if (this.failDispatch) throw new Error('livekit dispatch failed');
    this.dispatches.push({ roomName, metadata });
    return { roomName, dispatchId: `dispatch-${this.dispatches.length}` };
  }

  async publishData(roomName: string, topic: string, payload: Record<string, unknown>): Promise<void> {
    this.published.push({ roomName, topic, payload });
  }

  async listParticipants(): Promise<Array<{ sid: string; identity: string; kind?: string }>> {
    return [];
  }

  async ping(): Promise<boolean> {
    return !this.failCreateRoom && !this.failDispatch;
  }
}

export class FakeNotifier implements Notifier {
  alerts: Array<{ deviceId: string; alert: CallAlert }> = [];
  fail = false;

  async publishCallStarted(deviceId: string, alert: CallAlert): Promise<boolean> {
    if (this.fail) throw new Error('pusher unavailable');
    this.alerts.push({ deviceId, alert });
    return true;
  }

  async ping(): Promise<boolean> {
    return !this.fail;
  }
}

/** Canonical AidaAdmin rows for a healthy single-tenant configuration. */
export function seedHealthyBase(
  api: FakeNocoApi,
  overrides: {
    didE164?: string;
    screeningEnabled?: boolean;
    profileEnabled?: boolean;
    tenantEnabled?: boolean;
    destinationType?: string;
  } = {},
): void {
  api.seed('tenant', [
    {
      id: 'tenant-1',
      revision: 7,
      name: 'Acme Dental',
      slug: 'acme',
      asterisk_context: 'office-main',
      caller_id_name: 'Acme Dental',
      caller_id_number: '+15559870001',
      enabled: overrides.tenantEnabled ?? true,
    },
  ]);
  api.seed('assistant_profile', [
    {
      id: 'profile-1',
      revision: 3,
      tenant_id: 'tenant-1',
      name: 'Reception',
      business_name: 'Acme Dental',
      prompt: 'Greet the caller and find out why they are calling.',
      tone: 'warm',
      objective: 'Book or triage',
      opening_statement: 'Thanks for calling Acme Dental.',
      transfer_statement: 'Connecting you now.',
      failed_transfer_statement: 'Nobody is free right now.',
      enabled: overrides.profileEnabled ?? true,
    },
  ]);
  api.seed('did_route', [
    {
      id: 'route-1',
      revision: 11,
      tenant_id: 'tenant-1',
      did_e164: overrides.didE164 ?? '+15559870001',
      assistant_profile_id: 'profile-1',
      destination_type: overrides.destinationType ?? 'EXTENSION',
      destination_extension_id: 'ext-1',
      destination_ring_group_id: '',
      screening_enabled: overrides.screeningEnabled ?? true,
      enabled: true,
    },
  ]);
  api.seed('extension', [
    {
      id: 'ext-1',
      revision: 2,
      tenant_id: 'tenant-1',
      extension_number: '100',
      display_name: 'Front Desk',
      asterisk_context: 'office-main',
      device_id: 'device-1',
      provisioning_mac: 'C074AD112233',
      enabled: true,
    },
  ]);
}
