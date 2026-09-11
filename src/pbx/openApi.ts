const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const string = { type: 'string' };
const nativeName = { ...string, pattern: '^[a-zA-Z0-9_.-]{1,80}$', maxLength: 80 };
const contextName = { ...string, pattern: '^[a-zA-Z0-9_.-]{1,40}$', maxLength: 40 };
const e164 = { ...string, pattern: '^\\+[1-9][0-9]{6,14}$', example: '+19496501147' };
const strategies = ['ringall', 'leastrecent', 'fewestcalls', 'random', 'rrmemory', 'linear', 'wrandom'];
const tenant = { name: 'iTenantId', in: 'query', required: true, description: 'Exactly one canonical Identity tenant ID; duplicate values are rejected.', schema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } };
const parameter = (name: string, schema: unknown = string) => ({ name, in: 'path', required: true, schema });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const applyState = { ...string, enum: ['committed', 'active', 'unknown'], description: 'This implementation returns committed after a transaction and unknown for native inventory. It does not verify effective Asterisk state or return active.' };
const error = (description: string) => ({ description, content: json(ref('Error')) });
const op = (summary: string, method: string, parameters: unknown[], output?: string, input?: string) => ({
  tags: ['Backend API'], summary,
  description: 'Private admitted backend network or Identity-authenticated Operations gateway with tenant authorization and mutation CSRF. PBX mutations and DID reads require PBX_PROVISIONING_ENABLED=true plus dedicated writer credentials. Disabled mutation routes are absent. Credentials are returned only by extension creation; responses must not be cached.',
  'x-access-policy': 'trusted-backend-network', parameters: [tenant, ...parameters],
  ...(input ? { requestBody: { required: true, content: json(ref(input)) } } : {}),
  responses: {
    [method === 'post' ? '201' : method === 'delete' ? '204' : '200']: {
      description: method === 'get' ? 'Scoped Asterisk records' : 'Transaction committed; effective Asterisk state has not been verified',
      ...(output ? { content: json(ref(output)) } : {}),
    },
    '403': error('Caller not admitted or not authorized'), '404': error('Absent/other-tenant native object, or provisioning disabled'),
    '409': error('Duplicate object, remaining reference, manual route, or concurrent change; refresh and retry'),
    '422': error('Invalid fields or out-of-scope input'), '503': error('Database, schema, ownership mapping, or provisioning unavailable'),
  },
});
const ext = parameter('extension', { ...string, pattern: '^[0-9]{2,12}$' });
const queue = parameter('queue', nativeName);
const did = { ...parameter('did', e164), description: 'Exact tenant-allowlisted E.164 DID. URL encode the plus as %2B.' };
export const pbxPaths = {
  '/v1/admin/pbx/extensions': {
    get: op('List native extensions and approved contexts', 'get', [], 'ExtensionInventory'),
    post: op('Create a tenant extension; disclose SIP secret once', 'post', [], 'ExtensionCreated', 'ExtensionCreate'),
  },
  '/v1/admin/pbx/extensions/{extension}': { delete: op('Delete an owned extension bundle and saved queue memberships', 'delete', [ext]) },
  '/v1/admin/pbx/queues': {
    get: op('List explicitly owned native queues and members', 'get', [], 'QueueInventory'),
    post: op('Create a queue from a friendly slug (native ID tN.slug) or approved legacy name', 'post', [], 'QueueCreated', 'QueueCreate'),
  },
  '/v1/admin/pbx/queues/{queue}': { delete: op('Delete a queue and members; conflict while a DID references it', 'delete', [queue]) },
  '/v1/admin/pbx/queues/{queue}/extensions/{extension}': {
    put: op('Idempotently set an owned queue member', 'put', [queue, ext], 'QueueMemberSaved', 'QueueMemberInput'),
    delete: op('Delete one owned saved membership', 'delete', [queue, ext]),
  },
  '/v1/admin/pbx/dids': { get: op('Read recognized managed routes and explicitly identify manual/unconfigured allowed DIDs', 'get', [], 'DidInventory') },
  '/v1/admin/pbx/dids/{did}': {
    put: op('Set queue hours and ring budget before LiveKit; refuse manual route adoption', 'put', [did], 'ManagedDid', 'DidSettings'),
    delete: op('Delete recognized managed Realtime rows only; retain Identity number assignment', 'delete', [did]),
  },
};
const inventory = { source: { ...string, enum: ['asterisk'] }, iTenantId: { type: 'integer' }, provisioningEnabled: { type: 'boolean' } };
export const pbxSchemas = {
  ApplyState: applyState,
  Extension: object({ id: string, extension: { ...string, nullable: true }, context: string, callerId: { ...string, nullable: true }, transport: { ...string, nullable: true }, aors: { ...string, nullable: true }, applyState }),
  ExtensionInventory: object({ ...inventory, contexts: { type: 'array', items: contextName }, extensions: { type: 'array', items: ref('Extension') } }),
  ExtensionCreate: object({ extension: { ...string, pattern: '^[0-9]{2,12}$' }, context: { ...contextName, description: 'Required when more than one approved context exists.' }, displayName: { ...string, minLength: 1, maxLength: 33, description: 'No quotes, angle brackets, backslashes or control characters. The formatted caller ID must fit the installed 40-character column.' }, callerIdNumber: e164 }, ['extension']),
  ExtensionCreated: object({ extension: string, sipUsername: string, sipSecret: { ...string, description: 'One-time disclosure. Never logged, cached, persisted by AidaAdmin, or returned by inventory/replays.' }, applyState }),
  Queue: object({ id: string, name: string, strategy: { ...string, nullable: true }, applyState, members: { type: 'array', items: object({ interface: string, memberName: { ...string, nullable: true }, penalty: { type: 'integer' }, paused: { type: 'boolean' } }) } }),
  QueueInventory: object({ ...inventory, queues: { type: 'array', items: ref('Queue') } }),
  QueueCreate: object({ name: { ...nativeName, description: 'Friendly slug up to 60 characters, or exact approved legacy name up to 80. Generated native ID is tN.slug.' }, strategy: { ...string, enum: strategies, default: 'ringall' } }, ['name']),
  QueueCreated: object({ name: string, strategy: { ...string, enum: strategies }, applyState }),
  QueueMemberInput: object({ context: contextName, penalty: { type: 'integer', minimum: 0, maximum: 100, default: 0 }, paused: { type: 'boolean', default: false } }, []),
  QueueMemberSaved: object({ queue: string, extension: string, penalty: { type: 'integer' }, paused: { type: 'boolean' }, applyState }),
  DidSchedule: object({ timeRange: { ...string, pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]-(?:[01][0-9]|2[0-3]):[0-5][0-9]$', example: '09:00-17:00' }, weekdays: { ...string, maxLength: 128, description: 'Asterisk day names, & separated and optional ranges. Ranges normalize to a unique ordered sun..sat list.', example: 'mon-fri' }, timezone: { ...string, maxLength: 64, description: 'Required valid IANA timezone, including UTC.', example: 'America/Los_Angeles' } }),
  DidSettings: object({ queue: nativeName, ringsBeforeAi: { type: 'integer', minimum: 1, maximum: 12, description: 'Approximately five seconds per ring.' }, schedule: { ...ref('DidSchedule'), nullable: true }, livekitDestination: { ...e164, description: 'Defaults to the DID. The PJSIP provider endpoint is always livekit.' } }, ['queue', 'ringsBeforeAi']),
  ManagedDid: object({ did: e164, managed: { type: 'boolean', enum: [true] }, queue: nativeName,
    ringsBeforeAi: { type: 'integer', minimum: 1, maximum: 12 }, schedule: ref('DidSchedule'), livekitDestination: e164,
    ringTimeoutSeconds: { type: 'integer', minimum: 5, maximum: 60 }, applyState,
  }, ['did', 'managed', 'queue', 'ringsBeforeAi', 'livekitDestination', 'ringTimeoutSeconds', 'applyState']),
  UnmanagedDid: object({ did: e164, managed: { type: 'boolean', enum: [false] }, availability: { ...string, enum: ['unconfigured', 'manual'] }, applyState: { ...string, enum: ['unknown'] } }),
  DidInventory: object({ ...inventory, dids: { type: 'array', items: { oneOf: [ref('ManagedDid'), ref('UnmanagedDid')] } } }),
};
