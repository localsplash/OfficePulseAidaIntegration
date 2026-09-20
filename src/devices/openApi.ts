const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const string = { type: 'string' };
const response = (description: string, schema: unknown = ref('Error')) => ({ description, content: json(schema) });
const id = { name: 'id', in: 'path', required: true, schema: string };
const context = { name: 'context', in: 'query', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,40}$' } };
const operation = (summary: string, schema: unknown, parameters: unknown[] = [], request?: unknown, privateRoute = false) => ({
  tags: [privateRoute ? 'Backend API' : 'Handset'], summary, parameters,
  'x-access-policy': privateRoute ? 'trusted-backend-network' : 'handset-bearer',
  ...(privateRoute ? {} : { security: [{ handsetBearer: [] }] }),
  description: 'Responses use Cache-Control: no-store. Handset calls require matching PBX instance, context and native queue membership.',
  ...(request ? { requestBody: { required: true, content: json(request) } } : {}),
  responses: { '200': response('Success or recorded replay', schema), ...(request ? { '202': response('Takeover accepted', { type: 'object' }) } : {}),
    '400': response('Malformed request'), '401': response('Invalid or expired device token'), '403': response('Registration no longer matches or backend is not admitted'),
    '404': response('Resource is absent or outside device scope'), '409': response('stale_version, takeover_in_progress or already_taken'), '429': response('Source address rate limit'), '503': response('Dependency unavailable') },
});
export const handsetSchemas = {
  Handset: { type: 'object', required: ['id', 'pbxInstanceId', 'context', 'endpointId', 'extension'], properties: {
    id: string, pbxInstanceId: string, context: string, endpointId: string, extension: { type: 'string', nullable: true }, label: { type: 'string', nullable: true },
  } },
  HandsetCall: { type: 'object', properties: { id: string, state: { type: 'string', enum: ['screening','ringing','human-active','fallback','ended'] }, version: { type: 'integer' }, queue: string, callerNumber: string, startedAt: { type: 'string', format: 'date-time' },
    agentParticipantSid: string, takeover: { type: 'object', properties: { status: string, reason: { type: 'string', enum: ['busy','rejected','no-answer','failed'] }, mine: { type: 'boolean' } } } } },
};
const attachBody = { type: 'object', required: ['appInstanceId','localIps','deviceModel','appVersion'], properties: {
  appInstanceId: { type: 'string', maxLength: 128 }, localIps: { type: 'array', maxItems: 32, items: string }, deviceModel: { type: 'string', maxLength: 120 }, appVersion: { type: 'string', maxLength: 80 }, claimedMac: string,
} };
export const handsetPaths = {
  '/v1/handset/attach': { post: { ...operation('Attach from the phone’s live SIP registration', { type: 'object', properties: { token: string, expiresAt: { type: 'string', format: 'date-time' }, device: ref('Handset') } }, [], attachBody),
    security: [], 'x-access-policy': 'sip-registration-network-match', description: 'Trusted-office POC: same-network registration matching identifies an endpoint, not physical hardware. Exactly one unexpired contact must match. Failures echo only the submitted public/local addresses, never other endpoints. Token expires in 24 hours by default.' } },
  '/v1/handset/me': { get: operation('Read device scope and public queue subscriptions', { type: 'object', properties: { device: ref('Handset'), queues: { type: 'array', items: { type: 'object', properties: { name: string, channel: string } } }, pusher: { type: 'object', nullable: true, properties: { key: string, cluster: string } } } }) },
  '/v1/handset/calls': { get: operation('List screening and ringing queue calls', { type: 'object', properties: { calls: { type: 'array', items: ref('HandsetCall') } } }) },
  '/v1/handset/calls/{id}': { get: operation('Read call and issue a hidden observer token after rechecking registration', { type: 'object', properties: { call: ref('HandsetCall'), livekit: { type: 'object', properties: { url: string, token: string, expiresIn: { type: 'integer', enum: [120] } } } } }, [id]) },
  '/v1/handset/calls/{id}/takeover': { post: operation('Ring only this handset with guarded auto-answer', { type: 'object' }, [id], { type: 'object', required: ['idempotencyKey','expectedCallVersion'], properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, expectedCallVersion: { type: 'integer', minimum: 1 } } }) },
  '/v1/handset/logout': { post: operation('Revoke this token and remove its room observer', { type: 'object', properties: { status: string } }) },
  '/v1/admin/handsets': { get: operation('List attached handsets in one context', { type: 'object', properties: { handsets: { type: 'array', items: { allOf: [ref('Handset'), { type: 'object', properties: { mac: { ...string, nullable: true }, publicIp: string, localIp: string, attachedAt: string, lastSeenAt: string, appVersion: string, revokedAt: { ...string, nullable: true } } }] } } } }, [context], undefined, true) },
  '/v1/admin/handsets/{id}': { delete: operation('Revoke a handset session and remove it from rooms', { type: 'object', properties: { status: string } }, [id, context], undefined, true) },
};
