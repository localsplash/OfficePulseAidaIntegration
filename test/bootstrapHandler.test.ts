import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastAgiServer } from '../src/agi/fastAgiServer.js';
import { createBootstrapHandler, type FallbackResolver } from '../src/agi/bootstrapHandler.js';
import { AidaControlClient } from '../src/aidacontrol/client.js';
import { FakeAsteriskCall } from './helpers/fakeAsteriskCall.js';
import { captureLogger } from './helpers/capture.js';

const CALL_ENV = {
  agi_network: 'yes',
  agi_network_script: 'bootstrap',
  agi_request: 'agi://aida-integration.internal:4573/bootstrap',
  agi_channel: 'PJSIP/officepulse-00000042',
  agi_uniqueid: '1756400100.42',
  agi_callerid: '15551230001',
  agi_extension: '15559870001',
};

const CHANNEL_VARS = {
  ASTERISK_LINKEDID: '1756400100.42',
  OFFICEPULSE_INSTANCE_ID: 'op-primary',
};

type FetchResponder = (url: string, init: RequestInit) => Promise<Response> | Response;

function fakeFetch(responder: FetchResponder): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
    return Promise.race([Promise.resolve(responder(String(input), init ?? {})), aborted]);
  }) as typeof fetch;
}

const resolver: FallbackResolver = {
  async resolveDestination(kind, externalId) {
    if (kind === 'EXTENSION' && externalId === 'c0ffee00-0000-4000-8000-000000000001') {
      return { context: 'office-main', exten: '100' };
    }
    return undefined;
  },
};

/** Run one fake inbound call against a bootstrap-handling FastAGI server. */
async function runBootstrapCall(
  responder: FetchResponder,
  opts?: { channelVars?: Record<string, string>; timeoutMs?: number },
): Promise<{ call: FakeAsteriskCall; requests: Array<{ url: string; body: unknown; headers: Record<string, string> }>; logLines: string[] }> {
  const { logger, lines } = captureLogger();
  const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const aidaControl = new AidaControlClient({
    baseUrl: 'http://aidacontrol.test',
    timeoutMs: opts?.timeoutMs ?? 500,
    logger,
    fetchImpl: fakeFetch(async (url, init) => {
      requests.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      });
      return responder(url, init);
    }),
  });
  const server = new FastAgiServer({
    port: 0,
    bind: '127.0.0.1',
    maxConnections: 5,
    sessionTimeoutMs: 5000,
    logger,
    handlers: {
      bootstrap: createBootstrapHandler({ aidaControl, fallbackResolver: resolver, officePulseInstanceId: 'op-env', logger }),
    },
  });
  await server.listen();
  const call = new FakeAsteriskCall(CALL_ENV, opts?.channelVars ?? CHANNEL_VARS);
  try {
    await call.dial(server.address()?.port as number);
    await call.waitForHangup(4000);
  } finally {
    await server.close();
  }
  return { call, requests, logLines: lines };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('SCREEN sets all routing variables and sends linkedid idempotency', async () => {
  const { call, requests } = await runBootstrapCall(() =>
    jsonResponse({
      disposition: 'SCREEN',
      callSessionId: 'cs-1',
      roomName: 'room-1',
      sipDestination: 'room-1@sip.livekit.test',
      routeToken: 'tok-abc123',
      destinationType: 'EXTENSION',
      destinationId: 'c0ffee00-0000-4000-8000-000000000001',
    }),
  );
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'SCREEN');
  assert.equal(call.setVars.get('AIDA_CALL_SESSION_ID'), 'cs-1');
  assert.equal(call.setVars.get('AIDA_ROOM_NAME'), 'room-1');
  assert.equal(call.setVars.get('AIDA_SIP_DESTINATION'), 'room-1@sip.livekit.test');
  assert.equal(call.setVars.get('AIDA_ROUTE_TOKEN'), 'tok-abc123');
  assert.equal(call.setVars.get('AIDA_FALLBACK_CONTEXT'), 'office-main');
  assert.equal(call.setVars.get('AIDA_FALLBACK_EXTENSION'), '100');

  const request = requests[0];
  assert.ok(request);
  assert.ok(request.url.endsWith('/v1/integrations/officepulse/calls/bootstrap'));
  assert.equal(request.headers['x-idempotency-key'], '1756400100.42');
  assert.deepEqual(request.body, {
    officePulseInstanceId: 'op-primary',
    asteriskLinkedId: '1756400100.42',
    callerNumber: '15551230001',
    didE164: '15559870001',
  });
});

test('the route token is never logged', async () => {
  const { logLines } = await runBootstrapCall(() =>
    jsonResponse({
      disposition: 'SCREEN',
      callSessionId: 'cs-1',
      roomName: 'room-1',
      sipDestination: 'dest',
      routeToken: 'super-secret-route-token',
    }),
  );
  assert.ok(!logLines.join('\n').includes('super-secret-route-token'));
});

test('REJECT sets only the disposition', async () => {
  const { call } = await runBootstrapCall(() => jsonResponse({ disposition: 'REJECT' }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'REJECT');
  assert.equal(call.setVars.has('AIDA_ROUTE_TOKEN'), false);
});

test('FALLBACK resolves the provisioned destination', async () => {
  const { call } = await runBootstrapCall(() =>
    jsonResponse({
      disposition: 'FALLBACK',
      destinationType: 'EXTENSION',
      destinationId: 'c0ffee00-0000-4000-8000-000000000001',
    }),
  );
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
  assert.equal(call.setVars.get('AIDA_FALLBACK_CONTEXT'), 'office-main');
  assert.equal(call.setVars.get('AIDA_FALLBACK_EXTENSION'), '100');
});

test('AidaControl timeout degrades to FALLBACK within the deadline', async () => {
  const { call } = await runBootstrapCall(
    () => new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse({ disposition: 'SCREEN' })), 5_000).unref()),
    { timeoutMs: 200 },
  );
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('malformed response (bad disposition) degrades to FALLBACK', async () => {
  const { call } = await runBootstrapCall(() => jsonResponse({ disposition: 'WHATEVER' }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('SCREEN missing required fields is treated as malformed -> FALLBACK', async () => {
  const { call } = await runBootstrapCall(() => jsonResponse({ disposition: 'SCREEN', callSessionId: 'cs-1' }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('AidaControl 5xx degrades to FALLBACK', async () => {
  const { call } = await runBootstrapCall(() => jsonResponse({ error: 'boom' }, 500));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('AidaControl unreachable degrades to FALLBACK', async () => {
  const { call } = await runBootstrapCall(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('missing linkedid channel var falls back to uniqueid; instance falls back to env config', async () => {
  const { requests } = await runBootstrapCall(() => jsonResponse({ disposition: 'REJECT' }), { channelVars: {} });
  const body = requests[0]?.body as Record<string, unknown>;
  assert.equal(body.asteriskLinkedId, '1756400100.42');
  assert.equal(body.officePulseInstanceId, 'op-env');
});
