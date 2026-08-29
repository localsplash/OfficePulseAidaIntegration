import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AidaControlClient } from '../src/aidacontrol/client.js';
import { UpstreamError } from '../src/errors.js';
import { captureLogger } from './helpers/capture.js';

function client(fetchImpl: typeof fetch, timeoutMs = 300): AidaControlClient {
  const { logger } = captureLogger();
  return new AidaControlClient({ baseUrl: 'http://control.test', timeoutMs, logger, fetchImpl });
}

const SCREEN_BODY = {
  disposition: 'SCREEN',
  callSessionId: 'cs-1',
  roomName: 'r1',
  sipDestination: 'd1',
  routeToken: 't1',
};

test('bootstrapCall posts the contract body with linkedid idempotency and correlation headers', async () => {
  let captured: { url: string; headers: Record<string, string>; body: unknown } | undefined;
  const c = client((async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    return new Response(JSON.stringify(SCREEN_BODY), { status: 200 });
  }) as typeof fetch);

  const result = await c.bootstrapCall(
    { officePulseInstanceId: 'op', asteriskLinkedId: 'lid-1', callerNumber: '155', didE164: '156' },
    { correlationId: 'corr-1' },
  );
  assert.equal(result.disposition, 'SCREEN');
  assert.equal(captured?.url, 'http://control.test/v1/integrations/officepulse/calls/bootstrap');
  assert.equal(captured?.headers['x-idempotency-key'], 'lid-1');
  assert.equal(captured?.headers['x-aida-correlation-id'], 'corr-1');
});

test('malformed and incomplete responses are rejected as UpstreamError', async () => {
  const bad = client((async () => new Response(JSON.stringify({ disposition: 'MAYBE' }), { status: 200 })) as typeof fetch);
  await assert.rejects(
    bad.bootstrapCall({ officePulseInstanceId: 'op', asteriskLinkedId: 'l', didE164: 'd' }),
    UpstreamError,
  );
  const partial = client(
    (async () => new Response(JSON.stringify({ disposition: 'SCREEN', callSessionId: 'x' }), { status: 200 })) as typeof fetch,
  );
  await assert.rejects(
    partial.bootstrapCall({ officePulseInstanceId: 'op', asteriskLinkedId: 'l', didE164: 'd' }),
    /missing roomName/,
  );
  const nonJson = client((async () => new Response('<html>', { status: 200 })) as typeof fetch);
  await assert.rejects(
    nonJson.bootstrapCall({ officePulseInstanceId: 'op', asteriskLinkedId: 'l', didE164: 'd' }),
    /non-JSON/,
  );
});

test('timeout aborts within the configured deadline', async () => {
  const c = client(
    ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch,
    80,
  );
  const started = Date.now();
  await assert.rejects(
    c.bootstrapCall({ officePulseInstanceId: 'op', asteriskLinkedId: 'l', didE164: 'd' }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 1000);
});

test('postCallEvent retries once and never throws', async () => {
  let calls = 0;
  const flaky = client((async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 502 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  const ok = await flaky.postCallEvent('cs-1', {
    eventType: 'ringing',
    occurredAt: new Date().toISOString(),
    idempotencyKey: 'cs-1:1',
  });
  assert.equal(ok, true);
  assert.equal(calls, 2);

  const down = client((async () => new Response('{}', { status: 500 })) as typeof fetch);
  const delivered = await down.postCallEvent('cs-1', {
    eventType: 'ringing',
    occurredAt: new Date().toISOString(),
    idempotencyKey: 'cs-1:2',
  });
  assert.equal(delivered, false);
});
