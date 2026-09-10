import { pbxPaths, pbxSchemas } from '../pbx/openApi.js';
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
    description: 'Native Asterisk inventory and opt-in POC provisioning, integration call diagnostics and signed callbacks. Asterisk remains the PBX source of truth; provisioning writes its Realtime tables directly and keeps no desired-state copy. These docs are publicly readable; administrative requests remain restricted to trusted backends.' },
  servers: [{ url: '/', description: 'This OfficePulse API deployment' }],
  tags: [{ name: 'Health' }, { name: 'Backend API' }, { name: 'Callbacks' }],
  paths: {
    '/healthz': { get: { tags: ['Health'], summary: 'Process health', responses: { '200': response('Process is responding', { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }) } } },
    '/readyz': { get: { tags: ['Health'], summary: 'Dependency readiness', description: 'HTTP 200 means critical dependencies are ready. Inspect components.pbx-inventory separately. fullyOperational stays false when voice/native admission is unavailable.', responses: { '200': response('Critical dependencies ready', reference('Readiness')), '503': response('Critical dependency unavailable', reference('Readiness')) } } },
    ...pbxPaths,
    '/v1/admin/calls/{id}': { get: privateGet('Read an observed integration call', [callId], reference('Call')) },
    '/v1/admin/calls/{id}/events': { get: privateGet('Read integration call events', [callId], { type: 'object', properties: { events: { type: 'array', items: reference('Event') } } }) },
    '/v1/admin/calls/{id}/commands': { post: { tags: ['Backend API'], summary: 'Submit an integration call command', description: access + ' Requires VOICE_ENABLED=true. DRAIN_ACK is supported; TAKEOVER returns 503 until native destination admission exists. Dev returns voice_unavailable before executing commands.', parameters: [callId], 'x-access-policy': 'trusted-backend-network', requestBody: { required: true, content: json({ type: 'object', required: ['commandType', 'idempotencyKey'], properties: { commandType: { type: 'string', enum: ['DRAIN_ACK', 'TAKEOVER'] }, idempotencyKey: { type: 'string', minLength: 1 }, expectedCallVersion: { type: 'integer' }, destinationType: { type: 'string', enum: ['EXTENSION', 'QUEUE'] }, destinationId: { type: 'string' }, ringTimeoutSeconds: { type: 'number' }, musicOnHoldClass: { type: 'string' } } }) }, responses: { '200': response('Previously recorded command result', { type: 'object' }), '202': response('Command accepted', { type: 'object' }), '403': response('Caller denied'), '404': response('Call not found'), '409': response('Conflict or previously failed command'), '422': response('Invalid command'), '503': response('Voice or native destination unavailable') } } },
    '/v1/integrations/livekit/webhooks': { post: { tags: ['Callbacks'], summary: 'Receive a signed LiveKit webhook', description: 'Preserve the original request bytes and LiveKit Authorization header. Signature verification authenticates this callback when voice is enabled. With voice disabled, returns 503.', parameters: [{ name: 'Authorization', in: 'header', required: true, description: 'LiveKit-generated webhook signature; not a staff login token.', schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/webhook+json': { schema: { type: 'object', description: 'Original LiveKit webhook event payload' } } } }, responses: { '200': response('Verified webhook outcome', { type: 'object' }), '401': response('Signature rejected', { type: 'object' }), '503': response('Voice disabled') } } },
  },
  components: { schemas: {
    Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } } },
    Readiness: { type: 'object', properties: { ready: { type: 'boolean' }, fullyOperational: { type: 'boolean' }, components: { type: 'object', additionalProperties: { type: 'object', properties: { ready: { type: 'boolean' }, criticality: { type: 'string', enum: ['critical', 'degraded'] }, detail: { type: 'string' }, since: { type: 'string', format: 'date-time' } } } } } },
    ...pbxSchemas,
    Call: { type: 'object', properties: { id: { type: 'string' }, asteriskLinkedId: { type: 'string' }, officePulseInstanceId: { type: 'string' }, tenantId: { type: 'string' }, callerNumber: { type: 'string' }, didE164: { type: 'string' }, state: { type: 'string' }, disposition: { type: 'string' }, version: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, endedAt: { type: 'string', format: 'date-time' }, config: { type: 'object' }, roomName: { type: 'string' }, destinationType: { type: 'string' }, destinationId: { type: 'string' } } },
    Event: { type: 'object', properties: { sequenceNumber: { type: 'integer' }, eventType: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, payload: { type: 'object', additionalProperties: true } } },
  } },
};

export const operationsOpenApi = {
  ...openApi,
  info: { ...openApi.info,
    description: 'Authenticated Super Admin access to the explicitly browser-enabled Admin API. Identity authorization is revalidated for every request; tenant scope and CSRF protections are enforced by the Operations gateway.' },
  servers: [{ url: '/ops/api', description: 'Authenticated Operations gateway' }],
  security: [{ operationsSession: [] }],
  paths: Object.fromEntries(Object.entries(openApi.paths).filter(([path]) => path.startsWith('/v1/admin/'))),
  components: { ...openApi.components, securitySchemes: {
    operationsSession: { type: 'apiKey', in: 'cookie', name: '__Host-officepulse.sid', description: 'Established by central Identity sign-in.' },
  } },
};

const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OfficePulse API documentation</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/initialize.js"></script></body></html>';
const initializer = "SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,validatorUrl:null,supportedSubmitMethods:[],persistAuthorization:false});";
const operationsHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OfficePulse authenticated API</title><link rel="stylesheet" href="/ops/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/ops/docs/swagger-ui-bundle.js"></script><script src="/ops/docs/initialize.js"></script></body></html>';
const operationsInitializer = `(async()=>{const response=await fetch('/ops/api/session',{credentials:'same-origin',redirect:'error'});if(!response.ok){location.href='/';return;}const session=await response.json();SwaggerUIBundle({url:'/ops/openapi.json',dom_id:'#swagger-ui',deepLinking:true,validatorUrl:null,supportedSubmitMethods:['get','post','put','patch','delete'],persistAuthorization:false,requestInterceptor(request){request.credentials='same-origin';if(!['GET','HEAD','OPTIONS'].includes((request.method||'GET').toUpperCase()))request.headers['x-csrf-token']=session.csrfToken;return request;}});})()`;
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

/** Authenticated Swagger UI. Its same-origin requests pass through Operations authorization. */
export async function serveOperationsDocumentation(path: string, res: ServerResponse): Promise<boolean> {
  let body: string | Buffer, type: string;
  if (path === '/ops/docs' || path === '/ops/docs/') { body = operationsHtml;type = 'text/html'; }
  else if (path === '/ops/openapi.json') { body = JSON.stringify(operationsOpenApi);type = 'application/json'; }
  else if (path === '/ops/docs/initialize.js') { body = operationsInitializer;type = 'text/javascript'; }
  else if (path === '/ops/docs/swagger-ui.css' || path === '/ops/docs/swagger-ui-bundle.js') {
    const name = path.slice('/ops/docs/'.length);
    if (!assets.has(name)) assets.set(name, readFile(join(dirname(require.resolve('swagger-ui-dist/package.json')), name)));
    body = await assets.get(name)!;type = name.endsWith('.css') ? 'text/css' : 'text/javascript';
  } else return false;
  res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);return true;
}
