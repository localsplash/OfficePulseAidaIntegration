import type {
  AidaDeviceRow,
  AidaObjectKind,
  AidaObjectRow,
  AorRow,
  AuthRow,
  DialplanRow,
  EndpointRow,
  RealtimeStore,
  RealtimeTx,
  RequestRecord,
} from '../../src/provisioning/store.js';

/**
 * In-memory RealtimeStore with genuine transaction semantics: the state
 * is snapshotted at transaction start and restored when the callback
 * throws, so rollback-on-partial-write is actually exercised.
 * Set failOnCall to force a failure when a named tx method runs.
 */
export class FakeRealtimeStore implements RealtimeStore {
  aors = new Map<string, AorRow>();
  auths = new Map<string, AuthRow>();
  endpoints = new Map<string, EndpointRow>();
  dialplan = new Map<string, DialplanRow[]>();
  objects = new Map<string, AidaObjectRow>();
  devices = new Map<string, AidaDeviceRow>();
  requests = new Map<string, RequestRecord>();
  failOnCall: string | null = null;
  pingResult = true;

  private key(context: string, exten: string): string {
    return `${context}|${exten}`;
  }

  private snapshot(): () => void {
    const clone = <K, V>(m: Map<K, V>): Map<K, V> => new Map(JSON.parse(JSON.stringify([...m.entries()]))) as Map<K, V>;
    const saved = {
      aors: clone(this.aors),
      auths: clone(this.auths),
      endpoints: clone(this.endpoints),
      dialplan: clone(this.dialplan),
      objects: clone(this.objects),
      devices: clone(this.devices),
      requests: clone(this.requests),
    };
    return () => {
      this.aors = saved.aors;
      this.auths = saved.auths;
      this.endpoints = saved.endpoints;
      this.dialplan = saved.dialplan;
      this.objects = saved.objects;
      this.devices = saved.devices;
      this.requests = saved.requests;
    };
  }

  async withTransaction<T>(fn: (tx: RealtimeTx) => Promise<T>): Promise<T> {
    const restore = this.snapshot();
    const store = this;
    const guard = (name: string): void => {
      if (store.failOnCall === name) throw new Error(`forced failure in ${name}`);
    };
    const tx: RealtimeTx = {
      async upsertAor(row) {
        guard('upsertAor');
        store.aors.set(row.id, { ...row });
      },
      async upsertAuth(row) {
        guard('upsertAuth');
        store.auths.set(row.id, { ...row });
      },
      async upsertEndpoint(row) {
        guard('upsertEndpoint');
        store.endpoints.set(row.id, { ...row });
      },
      async deleteEndpointBundle(endpointId) {
        guard('deleteEndpointBundle');
        store.endpoints.delete(endpointId);
        store.auths.delete(endpointId);
        store.aors.delete(endpointId);
      },
      async setEndpointFields(endpointId, fields) {
        guard('setEndpointFields');
        const row = store.endpoints.get(endpointId);
        if (row) Object.assign(row, fields);
      },
      async setAuthPassword(authId, password) {
        guard('setAuthPassword');
        const row = store.auths.get(authId);
        if (row) row.password = password;
      },
      async replaceDialplan(context, exten, rows) {
        guard('replaceDialplan');
        store.dialplan.set(store.key(context, exten), rows.map((r) => ({ ...r })));
      },
      async deleteDialplan(context, exten) {
        guard('deleteDialplan');
        store.dialplan.delete(store.key(context, exten));
      },
      async upsertAidaObject(row) {
        guard('upsertAidaObject');
        store.objects.set(`${row.kind}|${row.external_id}`, { ...row });
      },
      async upsertAidaDevice(row) {
        guard('upsertAidaDevice');
        store.devices.set(row.device_id, { ...row });
      },
      async recordRequest(record) {
        guard('recordRequest');
        if (store.requests.has(record.request_id)) throw new Error('duplicate request_id');
        store.requests.set(record.request_id, { ...record });
      },
    };
    try {
      return await fn(tx);
    } catch (err) {
      restore();
      throw err;
    }
  }

  async getAuth(authId: string): Promise<AuthRow | undefined> {
    return this.auths.get(authId);
  }

  async getEndpoint(endpointId: string): Promise<EndpointRow | undefined> {
    return this.endpoints.get(endpointId);
  }

  async getDialplan(context: string, exten: string): Promise<DialplanRow[]> {
    return this.dialplan.get(this.key(context, exten)) ?? [];
  }

  async getAidaObject(kind: AidaObjectKind, externalId: string): Promise<AidaObjectRow | undefined> {
    return this.objects.get(`${kind}|${externalId}`);
  }

  async findExtensionObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    for (const obj of this.objects.values()) {
      if (obj.kind === 'EXTENSION' && obj.context === context && obj.exten === exten) return obj;
    }
    return undefined;
  }

  async findDidObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    for (const obj of this.objects.values()) {
      if (obj.kind === 'DID' && obj.context === context && obj.exten === exten) return obj;
    }
    return undefined;
  }

  async findObjectAtLocation(context: string, exten: string): Promise<AidaObjectRow | undefined> {
    for (const obj of this.objects.values()) {
      // DID rows share the dialplan but occupy an E.164 slot, never an
      // extension number, so they cannot collide with one.
      if (obj.kind !== 'DID' && obj.context === context && obj.exten === exten) return obj;
    }
    return undefined;
  }

  async getAidaDeviceByExtension(extensionExternalId: string): Promise<AidaDeviceRow | undefined> {
    for (const device of this.devices.values()) {
      if (device.extension_external_id === extensionExternalId) return device;
    }
    return undefined;
  }

  async getRequest(requestId: string): Promise<RequestRecord | undefined> {
    return this.requests.get(requestId);
  }

  async ping(): Promise<boolean> {
    return this.pingResult;
  }
}
