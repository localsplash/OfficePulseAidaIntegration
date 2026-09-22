import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RuntimeStore, CallSessionRecord } from '../runtime/store.js';
import type { Route, ApiRequest } from '../http/httpServer.js';
import { signAccessToken } from '../livekit/token.js';
import { contextQuery, type InventoryReader, type PbxContact, type PbxExtension, type PbxQueue } from '../pbx/inventory.js';
import { CONTEXT_RE } from '../pbx/managedDid.js';
import { queueChannel } from '../notify/pusher.js';
import { ConflictError, DependencyUnavailableError } from '../errors.js';
import type { TakeoverManager } from '../takeover/takeoverManager.js';
import { contactAddresses, matchingContacts, normalizedIp, normalizedMac, registrationMac, usableIp } from './registration.js';

export interface DeviceGrant {
  id: string; pbxInstanceId: string; context: string; endpointId: string; appInstanceId: string;
  extension: string | null; label: string | null; mac: string | null; publicIp: string; localIp: string;
  deviceModel: string; appVersion: string; attachedAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null;
  iTenantId?: number;
}
export interface DeviceStore {
  attach(device: DeviceGrant, tokenHash: string): Promise<string[]>;
  resolveSession(hash: string): Promise<DeviceGrant | undefined>;
  getDevice(id: string): Promise<DeviceGrant | undefined>;
  touch(id: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  listDevices(pbxInstanceId: string, context: string): Promise<DeviceGrant[]>;
  listCalls(device: DeviceGrant, queues: string[]): Promise<CallSessionRecord[]>;
}
export const credentialHash = (token: string): string => createHash('sha256').update(token).digest('hex');
function failure(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure(400, 'JSON object required');
  return value as Record<string, unknown>;
}

/** Native read cache: nothing older than 30 seconds authorizes a handset. Failures never extend it. */
export class DeviceDirectory {
  private contactCache?: { at: number; rows: PbxContact[] };
  private readonly scopes = new Map<string, { at: number; extensions: PbxExtension[]; queues: PbxQueue[] }>();
  constructor(private readonly inventory: InventoryReader, private readonly requirePublicIpMatch = true, private readonly now = Date.now) {}
  async contacts(fresh = false): Promise<PbxContact[]> {
    if (!this.inventory.contacts) throw new DependencyUnavailableError('PBX registration inventory unavailable');
    if (!fresh && this.contactCache && this.now() - this.contactCache.at < 30000) return this.contactCache.rows;
    const at = this.now(); const rows = await this.inventory.contacts();
    this.contactCache = { at, rows }; return rows;
  }
  async scope(context: string) {
    const cached = this.scopes.get(context);
    if (cached && this.now() - cached.at < 30000) return cached;
    const at = this.now();
    const [extensions, queues] = await Promise.all([this.inventory.extensions(context), this.inventory.queues(context)]);
    const scope = { at, extensions, queues };
    if (this.scopes.size >= 1000) this.scopes.clear();
    this.scopes.set(context, scope); return scope;
  }
  async queues(device: DeviceGrant): Promise<string[]> {
    const scope = await this.scope(device.context);
    const endpoint = scope.extensions.find(e => e.id === device.endpointId && e.context === device.context);
    if (!endpoint) return [];
    return scope.queues.filter(q => q.members.some(m => m.interface === `PJSIP/${device.endpointId}` ||
      (!!endpoint.extension && [ `Local/${endpoint.extension}@${device.context}`, `Local/${endpoint.extension}@${device.context}/n` ].includes(m.interface)))).map(q => q.name);
  }
  async binding(device: DeviceGrant): Promise<boolean> {
    const matches = matchingContacts(await this.contacts(), device.publicIp, [device.localIp], this.requirePublicIpMatch, this.now());
    return matches.length === 1 && matches[0]!.endpointId === device.endpointId && matches[0]!.context === device.context &&
      (!device.mac || registrationMac(matches[0]!.userAgent) === device.mac);
  }
  async allows(device: DeviceGrant, call: CallSessionRecord): Promise<boolean> {
    return !device.revokedAt && Date.parse(device.expiresAt) > this.now() && !call.endedAt && call.state !== 'ended' &&
      call.officePulseInstanceId === device.pbxInstanceId && call.pbxContext === device.context && call.destinationType === 'QUEUE' &&
      !!call.destinationId && (await this.queues(device)).includes(call.destinationId);
  }
}
export interface DeviceAccessOptions {
  store: DeviceStore; runtime: RuntimeStore; directory: DeviceDirectory; pbxInstanceId: string;
  requirePublicIpMatch: boolean; tokenTtlSeconds: number;
  livekit: { url: string; apiKey: string; apiSecret: string };
  pusher?: { key: string; cluster: string };
  takeover: Pick<TakeoverManager, 'takeover'>; ringTimeoutSeconds: number; voiceEnabled: boolean;
  removeFromRooms: (deviceId: string) => Promise<void>;
}
const deviceDto = (d: DeviceGrant) => ({ id: d.id, pbxInstanceId: d.pbxInstanceId, context: d.context, endpointId: d.endpointId, extension: d.extension, label: d.label });
const screening = (state: string) => ['screening', 'admitted', 'agent-ready'].includes(state);
const callDto = (c: CallSessionRecord) => ({ id: c.id, state: screening(c.state) ? 'screening' : c.state, version: c.version, queue: c.destinationId, callerNumber: c.callerNumber, startedAt: c.createdAt });

export function deviceRoutes(o: DeviceAccessOptions): Route[] {
  const authorized = async (req: ApiRequest) => {
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) failure(401, 'device_authentication_required');
    const d = await o.store.resolveSession(credentialHash(auth.slice(7)));
    if (!d || d.pbxInstanceId !== o.pbxInstanceId || d.revokedAt || Date.parse(d.expiresAt) <= Date.now()) failure(401, 'device_session_invalid');
    await o.store.touch(d.id); return d;
  };
  const scoped = async (req: ApiRequest) => {
    const device = await authorized(req);
    const call = await o.runtime.getCallSession(req.params.callSessionId ?? '');
    if (!call || !await o.directory.allows(device, call)) failure(404, 'call_not_found');
    return { device, call };
  };
  const revoke = async (id: string) => { await o.store.revokeDevice(id); await o.removeFromRooms(id); };
  return [
    { method: 'POST', pattern: '/v1/handset/attach', trusted: false, logRequestBody: true, handler: async req => {
      const body = object(req.body);
      if (typeof body.appInstanceId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(body.appInstanceId) ||
        !Array.isArray(body.localIps) || body.localIps.length > 32 || body.localIps.some(ip => typeof ip !== 'string' || ip.length > 80) ||
        typeof body.deviceModel !== 'string' || !body.deviceModel.trim() || body.deviceModel.length > 120 ||
        typeof body.appVersion !== 'string' || !body.appVersion.trim() || body.appVersion.length > 80 ||
        (body.claimedMac !== undefined && (typeof body.claimedMac !== 'string' || !normalizedMac(body.claimedMac)))) failure(400, 'invalid_attach');
      const localIps = [...new Set((body.localIps as string[]).map(usableIp).filter((ip): ip is string => !!ip))];
      const publicIp = normalizedIp(req.clientIp) ?? req.clientIp;
      const contacts = matchingContacts(await o.directory.contacts(true), publicIp, localIps, o.requirePublicIpMatch);
      if (contacts.length !== 1) return { status: contacts.length ? 409 : 403, body: {
        error: contacts.length ? 'handset_ambiguous' : 'handset_not_recognized', publicIp, localIps,
      } };
      const contact = contacts[0]!;
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(contact.endpointId) || !CONTEXT_RE.test(contact.context)) failure(403, 'handset_not_recognized');
      const mac = registrationMac(contact.userAgent);
      if (mac && body.claimedMac && normalizedMac(body.claimedMac as string) !== mac) failure(403, 'handset_mac_mismatch');
      const endpoint = (await o.directory.scope(contact.context)).extensions.find(e => e.id === contact.endpointId);
      if (!endpoint) failure(403, 'handset_not_recognized');
      const now = new Date().toISOString();
      const device: DeviceGrant = { id: randomUUID(), pbxInstanceId: o.pbxInstanceId, context: contact.context, endpointId: contact.endpointId,
        appInstanceId: body.appInstanceId, extension: endpoint.extension, label: endpoint.callerId, mac: mac ?? null, publicIp,
        localIp: localIps.find(ip => contactAddresses(contact).own.includes(ip))!, deviceModel: body.deviceModel, appVersion: body.appVersion,
        attachedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + o.tokenTtlSeconds * 1000).toISOString(), revokedAt: null };
      const token = randomBytes(32).toString('base64url');
      const revoked = await o.store.attach(device, credentialHash(token));
      await Promise.all(revoked.map(id => o.removeFromRooms(id)));
      return { status: 200, body: { token, expiresAt: device.expiresAt, device: deviceDto(device) } };
    } },
    { method: 'GET', pattern: '/v1/handset/me', trusted: false, logRequestBody: true, handler: async req => {
      const device = await authorized(req);
      return { status: 200, body: { device: deviceDto(device), queues: (await o.directory.queues(device)).map(name => ({ name, channel: queueChannel(device.pbxInstanceId, device.context, name) })), pusher: o.pusher ?? null } };
    } },
    { method: 'GET', pattern: '/v1/handset/calls', trusted: false, logRequestBody: true, handler: async req => {
      const device = await authorized(req); const calls = await o.store.listCalls(device, await o.directory.queues(device));
      const visible = [];
      for (const call of calls) if ((screening(call.state) || call.state === 'ringing') && await o.directory.allows(device, call)) visible.push(callDto(call));
      return { status: 200, body: { calls: visible } };
    } },
    { method: 'GET', pattern: '/v1/handset/calls/:callSessionId', trusted: false, logRequestBody: true, handler: async req => {
      const { device, call } = await scoped(req);
      const events = await o.runtime.listCallEvents(call.id);
      const latest = [...events].reverse().find(e => ['takeover-requested', 'takeover-failed', 'bridged'].includes(e.eventType));
      const requested = [...events].reverse().find(e => e.eventType === 'takeover-requested');
      const takeover = latest ? { status: latest.eventType === 'takeover-failed' ? 'failed' : latest.eventType === 'bridged' ? 'answered' : 'ringing',
        ...(latest.eventType === 'takeover-failed' ? { reason: latest.payload?.reason } : {}), mine: requested?.payload?.deviceId === device.id } : undefined;
      const permittedRoom = o.voiceEnabled && call.roomName === `aida-${call.id}`;
      if (permittedRoom && !await o.directory.binding(device)) failure(403, 'handset_registration_changed');
      return { status: 200, body: { call: { ...callDto(call), agentParticipantSid: call.agentParticipantSid, takeover },
        ...(permittedRoom ? { livekit: { url: o.livekit.url, expiresIn: 120, token: signAccessToken(o.livekit.apiKey, o.livekit.apiSecret, {
          identity: `handset-${device.id}`, ttlSeconds: 120, video: { room: call.roomName, roomJoin: true, hidden: true,
            canSubscribe: false, canPublish: false, canPublishData: false, canUpdateOwnMetadata: false },
        }) } } : {}) } };
    } },
    { method: 'POST', pattern: '/v1/handset/calls/:callSessionId/takeover', trusted: false, logRequestBody: true, handler: async req => {
      const { device, call } = await scoped(req); const body = object(req.body);
      if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey || body.idempotencyKey.length > 200 ||
        !Number.isSafeInteger(body.expectedCallVersion) || Number(body.expectedCallVersion) < 1) failure(400, 'invalid_takeover');
      if (!o.voiceEnabled) return { status: 503, body: { error: 'voice_unavailable' } };
      if (!await o.directory.binding(device)) failure(403, 'handset_registration_changed');
      const key = credentialHash(`${device.id}:${body.idempotencyKey}`);
      let claim;
      try { claim = await o.runtime.claimControlCommand({ callSessionId: call.id, idempotencyKey: key, commandType: 'TAKEOVER',
        payload: { deviceId: device.id, endpointId: device.endpointId }, status: 'in-progress' }, Number(body.expectedCallVersion), 'screening'); }
      catch (error) {
        if (error instanceof ConflictError && /version/.test(error.message)) failure(409, 'stale_version');
        throw error;
      }
      if (!claim.claimed) return { status: claim.existing?.status === 'failed' ? 409 : 200, body: { status: claim.existing?.status, result: claim.existing?.result, duplicate: true } };
      try {
        const result = await o.takeover.takeover({ callSessionId: call.id, idempotencyKey: key, destinationType: 'EXTENSION',
          context: 'aida-takeover', exten: device.endpointId, ringTimeoutSeconds: o.ringTimeoutSeconds, deviceId: device.id });
        await o.runtime.completeControlCommand(call.id, key, 'completed', { ...result });
        return { status: 202, body: result };
      } catch (error) {
        await o.runtime.completeControlCommand(call.id, key, 'failed', { error: (error as Error).message }); throw error;
      }
    } },
    { method: 'POST', pattern: '/v1/handset/logout', trusted: false, logRequestBody: true, handler: async req => {
      await revoke((await authorized(req)).id); return { status: 200, body: { status: 'revoked' } };
    } },
    { method: 'GET', pattern: '/v1/admin/handsets', operationsAccess: { scope: 'context-query', query: 'context' }, handler: async req => {
      const devices = await o.store.listDevices(o.pbxInstanceId, contextQuery(req.query));
      return { status: 200, body: { handsets: devices.map(d => ({ ...deviceDto(d), mac: d.mac, publicIp: d.publicIp, localIp: d.localIp,
        deviceModel: d.deviceModel, attachedAt: d.attachedAt, lastSeenAt: d.lastSeenAt, appVersion: d.appVersion, revokedAt: d.revokedAt })) } };
    } },
    { method: 'DELETE', pattern: '/v1/admin/handsets/:id', operationsAccess: { scope: 'context-query', query: 'context' }, handler: async req => {
      const context = contextQuery(req.query);
      const device = (await o.store.listDevices(o.pbxInstanceId, context)).find(d => d.id === req.params.id);
      if (!device) failure(404, 'handset_not_found');
      await revoke(device.id); return { status: 200, body: { status: 'revoked' } };
    } },
  ];
}
