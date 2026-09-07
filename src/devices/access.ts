import { createHash, randomBytes } from 'node:crypto';
import type { NocoConfigRepository } from '../nocodb/configRepository.js';
import type { RuntimeStore, CallSessionRecord } from '../runtime/store.js';
import type { Route, ApiRequest } from '../http/httpServer.js';
import { signAccessToken } from '../livekit/token.js';

export interface DeviceGrant {
  id: string;
  iTenantId: number;
  extensionId: string;
}

export interface DeviceStore {
  issueEnrollment(hash: string, iTenantId: number, extensionId: string): Promise<void>;
  consumeEnrollment(hash: string, deviceId: string, sessionHash: string): Promise<DeviceGrant | undefined>;
  resolveSession(hash: string): Promise<DeviceGrant | undefined>;
  revokeDevice(id: string): Promise<void>;
  listCalls(tenantId: string, destinations: string[]): Promise<CallSessionRecord[]>;
}

export function credentialHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function failure(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure(400, 'JSON object required');
  return value as Record<string, unknown>;
}

function tenantId(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) failure(400, 'valid iTenantId required');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) failure(400, 'valid iTenantId required');
  return n;
}

export interface DeviceAccessOptions {
  store: DeviceStore;
  runtime: RuntimeStore;
  config: Pick<NocoConfigRepository, 'getExtension' | 'ringGroupsForExtension'>;
  tenantEnabled: (iTenantId: number) => Promise<boolean>;
  livekit: { url: string; apiKey: string; apiSecret: string };
  commandRoute: Route;
  voiceEnabled?: boolean;
}

/** Public device routes authenticate opaque credentials; private provisioning remains CIDR gated. */
export function deviceRoutes(options: DeviceAccessOptions): Route[] {
  const authorized = async (req: ApiRequest): Promise<{ device: DeviceGrant; destinations: string[] }> => {
    const authorization = req.headers.authorization ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) failure(401, 'device authentication required');
    const device = await options.store.resolveSession(credentialHash(authorization.slice(7)));
    if (!device) failure(401, 'device session invalid or revoked');
    const extension = await options.config.getExtension(device.extensionId);
    if (!extension?.enabled || Number(extension.tenantId) !== device.iTenantId) failure(403, 'device access disabled');
    if (!(await options.tenantEnabled(device.iTenantId))) failure(403, 'business disabled');
    const groups = await options.config.ringGroupsForExtension(device.extensionId, String(device.iTenantId));
    return { device, destinations: [device.extensionId, ...groups] };
  };
  const scopedCall = async (req: ApiRequest) => {
    const { device, destinations } = await authorized(req);
    const call = await options.runtime.getCallSession(req.params.callSessionId ?? '');
    if (!call || Number(call.tenantId) !== device.iTenantId || !call.destinationId || !destinations.includes(call.destinationId)) {
      failure(404, 'call not found');
    }
    return { device, call };
  };
  const dto = (call: CallSessionRecord) => ({
    id: call.id, status: call.state, version: call.version,
    caller: call.callerNumber, startedAt: call.createdAt,
    extensionId: call.destinationType === 'EXTENSION' ? call.destinationId : undefined,
  });
  return [
    {
      method: 'POST', pattern: '/v1/provisioning/device-enrollments',
      handler: async (req) => {
        const body = object(req.body);
        const id = tenantId(body.iTenantId);
        const extensionId = typeof body.extensionId === 'string' ? body.extensionId : '';
        const extension = await options.config.getExtension(extensionId);
        if (!extension?.enabled || Number(extension.tenantId) !== id) failure(404, 'extension not found');
        if (!(await options.tenantEnabled(id))) failure(403, 'business disabled');
        const enrollmentToken = randomBytes(32).toString('base64url');
        await options.store.issueEnrollment(credentialHash(enrollmentToken), id, extensionId);
        return { status: 201, body: { enrollmentToken, expiresIn: 600 } };
      },
    },
    {
      method: 'POST', pattern: '/v1/devices/enroll', trusted: false,
      handler: async (req) => {
        const body = object(req.body);
        const enrollmentToken = typeof body.enrollmentToken === 'string' ? body.enrollmentToken : '';
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(enrollmentToken) || !/^[A-Za-z0-9._:-]{1,120}$/.test(deviceId)) failure(400, 'invalid enrollment');
        const token = randomBytes(32).toString('base64url');
        const device = await options.store.consumeEnrollment(credentialHash(enrollmentToken), deviceId, credentialHash(token));
        if (!device) failure(401, 'enrollment expired or already used');
        const extension = await options.config.getExtension(device.extensionId);
        if (!extension?.enabled || Number(extension.tenantId) !== device.iTenantId || !(await options.tenantEnabled(device.iTenantId))) {
          await options.store.revokeDevice(device.id);
          failure(403, 'device access disabled');
        }
        return { status: 201, body: { token, device } };
      },
    },
    {
      method: 'POST', pattern: '/v1/devices/logout', trusted: false,
      handler: async (req) => {
        const { device } = await authorized(req);
        await options.store.revokeDevice(device.id);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: 'DELETE', pattern: '/v1/provisioning/devices/:deviceId',
      handler: async (req) => {
        await options.store.revokeDevice(req.params.deviceId ?? '');
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: 'GET', pattern: '/v1/calls', trusted: false,
      handler: async (req) => {
        const { device, destinations } = await authorized(req);
        const calls = await options.store.listCalls(String(device.iTenantId), destinations);
        return { status: 200, body: { calls: calls.map(dto) } };
      },
    },
    {
      method: 'GET', pattern: '/v1/calls/:callSessionId', trusted: false,
      handler: async (req) => {
        const { device, call } = await scopedCall(req);
        const livekit = options.voiceEnabled !== false && call.roomName && !call.endedAt ? {
          url: options.livekit.url,
          token: signAccessToken(options.livekit.apiKey, options.livekit.apiSecret, {
            identity: `handset-${device.id}`, ttlSeconds: 120,
            video: { roomJoin: true, room: call.roomName, canPublish: false, canSubscribe: false, canPublishData: false },
          }),
        } : undefined;
        return { status: 200, body: { call: dto(call), livekit } };
      },
    },
    {
      method: 'GET', pattern: '/v1/calls/:callSessionId/events', trusted: false,
      handler: async (req) => {
        const { call } = await scopedCall(req);
        const events = await options.runtime.listCallEvents(call.id);
        // Explicit DTO: internal event payloads may contain provisioning context.
        return { status: 200, body: { events: events.map((e) => ({ eventType: e.eventType, sequence: e.sequenceNumber, timestamp: e.createdAt })) } };
      },
    },
    {
      method: 'POST', pattern: '/v1/calls/:callSessionId/commands', trusted: false,
      handler: async (req) => {
        const { device } = await scopedCall(req);
        const body = object(req.body);
        if (body.commandType !== 'TAKEOVER') failure(400, 'only TAKEOVER is allowed for handsets');
        if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.idempotencyKey)) failure(400, 'valid idempotencyKey required');
        if (!Number.isSafeInteger(body.expectedCallVersion) || Number(body.expectedCallVersion) < 1) failure(400, 'expectedCallVersion required');
        // Device identity scopes retries; destinations and PBX options never come from the handset.
        return options.commandRoute.handler({ ...req, body: {
          commandType: 'TAKEOVER', expectedCallVersion: body.expectedCallVersion,
          idempotencyKey: credentialHash(`${device.id}:${body.idempotencyKey}`),
        } });
      },
    },
  ];
}

export function identityTenantReader(baseUrl: string, clientSecret?: string): (id: number) => Promise<boolean> {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('IDENTITY_BASE_URL must be HTTP(S)');
  return async (id: number) => {
    let response: Response;
    try { response = await fetch(new URL(`/api/runtime/tenants/${id}`, origin), {
      headers: clientSecret ? { 'x-id-client-secret': clientSecret } : {},
      signal: AbortSignal.timeout(5000), redirect: 'error',
    }); } catch { failure(503, 'identity tenant validation unavailable'); }
    if (response.status === 404) return false;
    if (!response.ok) failure(503, 'identity tenant validation unavailable');
    const body = await response.json() as { iTenantId?: number; bEnabled?: boolean };
    return body.iTenantId === id && body.bEnabled === true;
  };
}
