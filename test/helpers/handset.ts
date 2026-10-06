import { randomUUID } from 'node:crypto';
import { DeviceDirectory, deviceRoutes, type DeviceGrant, type DeviceStore } from '../../src/devices/access.js';
import type { PbxContact, PbxExtension, PbxQueue } from '../../src/pbx/inventory.js';
import type { TakeoverCommand } from '../../src/takeover/takeoverManager.js';
import { FakeRuntimeStore } from './fakeRuntime.js';

export const sampleDevice = (overrides: Partial<DeviceGrant> = {}): DeviceGrant => ({
  id: randomUUID(), pbxInstanceId: 'officepulse-dev', context: 'office', endpointId: '411', appInstanceId: 'install-1',
  extension: '411', label: 'Desk', mac: 'ec74d7c92718', publicIp: '203.0.113.1', localIp: '192.168.1.10',
  deviceModel: 'GXV3450', appVersion: '1.0', attachedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: null, ...overrides,
});
export class MemoryDeviceStore implements DeviceStore {
  sessions = new Map<string, DeviceGrant>();
  async attach(device: DeviceGrant, hash: string) {
    const revoked: string[] = [];
    for (const d of this.sessions.values()) if (d.pbxInstanceId === device.pbxInstanceId && !d.revokedAt &&
      (d.appInstanceId === device.appInstanceId || (d.context === device.context && d.endpointId === device.endpointId))) {
      d.revokedAt = new Date().toISOString(); revoked.push(d.id);
    }
    this.sessions.set(hash, device); return revoked;
  }
  async resolveSession(hash: string) { const d = this.sessions.get(hash); return d && !d.revokedAt && Date.parse(d.expiresAt) > Date.now() ? d : undefined; }
  async getDevice(id: string) { return [...this.sessions.values()].find(d => d.id === id && !d.revokedAt && Date.parse(d.expiresAt) > Date.now()); }
  async touch() {}
  async revokeDevice(id: string) { for (const d of this.sessions.values()) if (d.id === id) d.revokedAt = new Date().toISOString(); }
  async listDevices(pbxInstanceId: string, context: string) { return [...this.sessions.values()].filter(d => d.pbxInstanceId === pbxInstanceId && d.context === context); }
  async listCalls() { return [...this.runtime.sessions.values()]; }
  constructor(readonly runtime: FakeRuntimeStore) {}
}
export function handsetFixture(requirePublicIpMatch = true, voiceEnabled = true) {
  const runtime = new FakeRuntimeStore(); const store = new MemoryDeviceStore(runtime);
  const call = runtime.seedSession({ officePulseInstanceId: 'officepulse-dev', pbxContext: 'office', destinationType: 'QUEUE', destinationId: 'sales', state: 'screening' });
  call.roomName = `aida-${call.id}`;
  const state = { now: Date.now(), contacts: [{ endpointId: '411', context: 'office', uri: 'sip:411@203.0.113.1:5061;transport=TLS',
    localIp: '192.168.1.10', userAgent: 'Grandstream/MAC-ec74d7c92718', expiresAt: Date.now() + 3600000 }] as PbxContact[],
    endpoints: [{ id: '411', extension: '411', context: 'office', callerId: 'Desk', transport: 'tls', aors: '411', managed: false }] as PbxExtension[],
    queues: [{ id: 'sales', name: 'sales', strategy: 'ringall', members: [{ interface: 'PJSIP/411', memberName: null, paused: false, penalty: 0 }] }] as PbxQueue[],
    commands: [] as TakeoverCommand[], removed: [] as string[] };
  const directory = new DeviceDirectory({ contexts: async () => ['office'], contacts: async () => [...state.contacts],
    extensions: async () => [...state.endpoints], queues: async () => structuredClone(state.queues) }, requirePublicIpMatch, () => state.now);
  const routes = deviceRoutes({ runtime, store, directory, pbxInstanceId: 'officepulse-dev', requirePublicIpMatch, tokenTtlSeconds: 86400,
    livekit: { url: 'wss://example.test', apiKey: 'test-key', apiSecret: 'test-secret' }, pusher: { key: 'public', cluster: 'us2' },
    voiceEnabled, ringTimeoutSeconds: 15, removeFromRooms: async id => { state.removed.push(id); },
    takeover: { takeover: async cmd => { state.commands.push(cmd); await runtime.updateCallSession(cmd.callSessionId, { state: 'ringing' }); return { status: 'ringing' }; } } });
  const attachBody = { appInstanceId: 'install-1', localIps: ['192.168.1.10'], deviceModel: 'GXV3450', appVersion: '1.0' };
  const invoke = async (path: string, body?: unknown, token?: string, method = 'GET', id = call.id, publicIp = '203.0.113.1') => {
    const route = routes.find(r => r.pattern === path && r.method === method)!;
    return route.handler({ method, path, body, params: { callSessionId: id, id }, headers: token ? { authorization: `Bearer ${token}` } : {},
      query: new URLSearchParams('context=office'), clientIp: publicIp, correlationId: 'test' });
  };
  const attach = async () => (await invoke('/v1/handset/attach', attachBody, undefined, 'POST')).body as { token: string; device: DeviceGrant; expiresAt: string };
  return { runtime, store, call, state, directory, routes, attachBody, invoke, attach };
}
