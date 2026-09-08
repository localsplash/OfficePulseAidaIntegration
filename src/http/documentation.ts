import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

const reference = (name: string) => ({ $ref: '#/components/schemas/' + name });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const response = (description: string, schema: unknown = reference('Error')) => ({ description, content: json(schema) });
const tenant = { name: 'iTenantId', in: 'query', required: true, description: 'Canonical Identity tenant ID with an explicitly configured native PBX scope.', schema: { type: 'integer', minimum: 1 } };
const callId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const access = 'Restricted to trusted application backends. A browser session, API key or bearer token does not bypass the network admission policy. AidaAdmin and the operations UI authenticate their human users separately.';
const privateGet = (summary: string, parameters: unknown[], schema: unknown) => ({
  tags: ['Backend API'], summary, description: access, 'x-access-policy': 'trusted-backend-network', parameters,
  responses: { '200': response('Successful read', schema), '403': response('Caller is not an admitted backend'), '404': response('Resource not found'), '422': response('Invalid request'), '503': response('Dependency or native scope unavailable') },
});

export const openApi = {
  openapi: '3.0.3', info: { title: 'OfficePulse Integration API', version: '1.0.0',
    description: 'Native Asterisk extension and queue inventory, integration call diagnostics and signed callbacks. Asterisk is the PBX source of truth. No extension provisioning or synchronization API exists. These docs are publicly readable; administrative requests remain restricted to trusted backends. Interactive submission is disabled to avoid sending call commands from documentation. Native queue takeover is not implemented, and Dev voice is disabled.' },
  servers: [{ url: '/', description: 'This OfficePulse API deployment' }],
  tags: [{ name: 'Health' }, { name: 'Backend API' }, { name: 'Callbacks' }],
  paths: {
    '/healthz': { get: { tags: ['Health'], summary: 'Process health', responses: { '200': response('Process is responding', { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }) } } },
    '/readyz': { get: { tags: ['Health'], summary: 'Dependency readiness', description: 'HTTP 200 means critical dependencies are ready. Inspect components.pbx-inventory separately. fullyOperational stays false when voice/native admission is unavailable.', responses: { '200': response('Critical dependencies ready', reference('Readiness')), '503': response('Critical dependency unavailable', reference('Readiness')) } } },
    '/v1/admin/pbx/extensions': { get: privateGet('Read tenant extensions', [tenant], { type: 'object', properties: { source: { type: 'string', enum: ['asterisk'] }, iTenantId: { type: 'integer' }, extensions: { type: 'array', items: reference('Extension') } } }) },
    '/v1/admin/pbx/queues': { get: privateGet('Read tenant queues and saved members', [tenant], { type: 'object', properties: { source: { type: 'string', enum: ['asterisk'] }, iTenantId: { type: 'integer' }, queues: { type: 'array', items: reference('Queue') } } }) },
    '/v1/admin/calls/{id}': { get: privateGet('Read an observed integration call', [callId], reference('Call')) },
    '/v1/admin/calls/{id}/events': { get: privateGet('Read integration call events', [callId], { type: 'object', properties: { events: { type: 'array', items: reference('Event') } } }) },
    '/v1/admin/calls/{id}/commands': { post: { tags: ['Backend API'], summary: 'Submit an integration call command', description: access + ' Requires VOICE_ENABLED=true. DRAIN_ACK is supported; TAKEOVER returns 503 until native destination admission exists. Dev returns voice_unavailable before executing commands.', parameters: [callId], 'x-access-policy': 'trusted-backend-network', requestBody: { required: true, content: json({ type: 'object', required: ['commandType', 'idempotencyKey'], properties: { commandType: { type: 'string', enum: ['DRAIN_ACK', 'TAKEOVER'] }, idempotencyKey: { type: 'string', minLength: 1 }, expectedCallVersion: { type: 'integer' }, destinationType: { type: 'string', enum: ['EXTENSION', 'QUEUE'] }, destinationId: { type: 'string' }, ringTimeoutSeconds: { type: 'number' }, musicOnHoldClass: { type: 'string' } } }) }, responses: { '200': response('Previously recorded command result', { type: 'object' }), '202': response('Command accepted', { type: 'object' }), '403': response('Caller denied'), '404': response('Call not found'), '409': response('Conflict or previously failed command'), '422': response('Invalid command'), '503': response('Voice or native destination unavailable') } } },
    '/v1/integrations/livekit/webhooks': { post: { tags: ['Callbacks'], summary: 'Receive a signed LiveKit webhook', description: 'Preserve the original request bytes and LiveKit Authorization header. Signature verification authenticates this callback when voice is enabled. With voice disabled, returns 503.', parameters: [{ name: 'Authorization', in: 'header', required: true, description: 'LiveKit-generated webhook signature; not a staff login token.', schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/webhook+json': { schema: { type: 'object', description: 'Original LiveKit webhook event payload' } } } }, responses: { '200': response('Verified webhook outcome', { type: 'object' }), '401': response('Signature rejected', { type: 'object' }), '503': response('Voice disabled') } } },
  },
  components: { schemas: {
    Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } } },
    Readiness: { type: 'object', properties: { ready: { type: 'boolean' }, fullyOperational: { type: 'boolean' }, components: { type: 'object', additionalProperties: { type: 'object', properties: { ready: { type: 'boolean' }, criticality: { type: 'string', enum: ['critical', 'degraded'] }, detail: { type: 'string' }, since: { type: 'string', format: 'date-time' } } } } } },
    Extension: { type: 'object', properties: { id: { type: 'string' }, context: { type: 'string' }, callerId: { type: 'string', nullable: true }, transport: { type: 'string', nullable: true }, aors: { type: 'string', nullable: true } } },
    Queue: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, strategy: { type: 'string', nullable: true }, members: { type: 'array', items: { type: 'object', properties: { interface: { type: 'string' }, memberName: { type: 'string', nullable: true }, penalty: { type: 'number' }, paused: { type: 'boolean' } } } } } },
    Call: { type: 'object', properties: { id: { type: 'string' }, asteriskLinkedId: { type: 'string' }, officePulseInstanceId: { type: 'string' }, tenantId: { type: 'string' }, callerNumber: { type: 'string' }, didE164: { type: 'string' }, state: { type: 'string' }, disposition: { type: 'string' }, version: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, endedAt: { type: 'string', format: 'date-time' }, config: { type: 'object' }, roomName: { type: 'string' }, destinationType: { type: 'string' }, destinationId: { type: 'string' } } },
    Event: { type: 'object', properties: { sequenceNumber: { type: 'integer' }, eventType: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, payload: { type: 'object', additionalProperties: true } } },
  } },
};

const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OfficePulse API documentation</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/initialize.js"></script></body></html>';
const initializer = "SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,validatorUrl:null,supportedSubmitMethods:[],persistAuthorization:false});";
const require = createRequire(import.meta.url);
const assets = new Map<string, Promise<Buffer>>();

/** Only static allowlisted assets and the public contract; no backend data or credentials. */
export async function serveDocumentation(path: string, res: ServerResponse): Promise<boolean> {
  if (path === '/') { res.writeHead(302, { location: '/docs' });res.end();return true; }
  let body: string | Buffer, type: string;
  if (path === '/docs' || path === '/docs/') { body = html;type = 'text/html'; }
  else if (path === '/openapi.json') { body = JSON.stringify(openApi);type = 'application/json'; }
  else if (path === '/docs/initialize.js') { body = initializer;type = 'text/javascript'; }
  else if (path === '/docs/swagger-ui.css' || path === '/docs/swagger-ui-bundle.js') {
    const name = path.slice('/docs/'.length);
    if (!assets.has(name)) assets.set(name, readFile(join(dirname(require.resolve('swagger-ui-dist/package.json')), name)));
    body = await assets.get(name)!;type = name.endsWith('.css') ? 'text/css' : 'text/javascript';
  } else return false;
  res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=300', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);return true;
}
