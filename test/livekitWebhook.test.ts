import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LiveKitWebhookHandler, callSessionIdFromRoom } from '../src/livekit/webhookHandler.js';
import { signAccessToken, verifyWebhook } from '../src/livekit/token.js';
import { LiveKitClient, buildCallMetadata } from '../src/livekit/client.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { captureLogger } from './helpers/capture.js';

const API_KEY = 'APIkey123';
const API_SECRET = 'secret-value-long-enough';
const CALL_SESSION_ID = '11111111-2222-4333-8444-555555555555';

/** Signs a webhook exactly as LiveKit does: token carries the body digest. */
function signBody(body: string, opts: { key?: string; secret?: string; digest?: string } = {}): string {
  return signAccessToken(opts.key ?? API_KEY, opts.secret ?? API_SECRET, {
    identity: 'livekit',
    ttlSeconds: 300,
    sha256: opts.digest ?? createHash('sha256').update(body).digest('base64'),
  });
}

function makeHandler(): { handler: LiveKitWebhookHandler; runtime: FakeRuntimeStore; lines: string[] } {
  const { logger, lines } = captureLogger();
  const runtime = new FakeRuntimeStore();
  runtime.seedSession({ id: CALL_SESSION_ID });
  return {
    handler: new LiveKitWebhookHandler({ apiKey: API_KEY, apiSecret: API_SECRET, runtime, logger }),
    runtime,
    lines,
  };
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt-1',
    event: 'participant_joined',
    room: { name: `aida-${CALL_SESSION_ID}`, sid: 'RM_1' },
    participant: { sid: 'PA_agent', identity: 'agent-aida-prime', kind: 'AGENT' },
    ...overrides,
  });
}

test('a correctly signed webhook is accepted and recorded', async () => {
  const { handler, runtime } = makeHandler();
  const body = event();
  const outcome = await handler.handle(Buffer.from(body), `Bearer ${signBody(body)}`);

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.event, 'participant_joined');
  assert.equal(runtime.participants.get(CALL_SESSION_ID)?.get('PA_agent')?.kind, 'AGENT');
  // The agent participant SID becomes the handle for later data sends.
  assert.equal((await runtime.getCallSession(CALL_SESSION_ID))?.agentParticipantSid, 'PA_agent');
  assert.deepEqual(runtime.eventTypes(CALL_SESSION_ID), ['livekit.participant_joined']);
});

test('a valid token replayed over a DIFFERENT body is rejected', async () => {
  const { handler, runtime } = makeHandler();
  const original = event();
  const tampered = event({ participant: { sid: 'PA_attacker', identity: 'attacker' } });

  // Signature verifies, but the digest claim belongs to the original body.
  const outcome = await handler.handle(Buffer.from(tampered), `Bearer ${signBody(original)}`);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'body digest mismatch');
  assert.equal(runtime.participants.size, 0);
});

test('a webhook signed with the wrong secret or key is rejected', async () => {
  const { handler } = makeHandler();
  const body = event();

  const wrongSecret = await handler.handle(Buffer.from(body), `Bearer ${signBody(body, { secret: 'other' })}`);
  assert.equal(wrongSecret.accepted, false);
  assert.equal(wrongSecret.reason, 'bad signature');

  const wrongKey = await handler.handle(Buffer.from(body), `Bearer ${signBody(body, { key: 'OtherKey' })}`);
  assert.equal(wrongKey.accepted, false);
  assert.equal(wrongKey.reason, 'issuer mismatch');
});

test('a missing or malformed authorization header is rejected', async () => {
  const { handler } = makeHandler();
  const body = event();
  assert.equal((await handler.handle(Buffer.from(body), undefined)).reason, 'missing authorization header');
  assert.equal((await handler.handle(Buffer.from(body), 'Bearer not.a.jwt.at.all')).reason, 'malformed token');
});

test('an expired token is rejected', () => {
  const body = event();
  const expired = signAccessToken(API_KEY, API_SECRET, {
    identity: 'livekit',
    ttlSeconds: -60,
    sha256: createHash('sha256').update(body).digest('base64'),
  });
  const result = verifyWebhook(body, `Bearer ${expired}`, API_KEY, API_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'token expired');
});

test('a duplicate delivery is acknowledged once and processed once', async () => {
  const { handler, runtime } = makeHandler();
  const body = event();
  const auth = `Bearer ${signBody(body)}`;

  const first = await handler.handle(Buffer.from(body), auth);
  const second = await handler.handle(Buffer.from(body), auth);

  assert.equal(first.duplicate, undefined);
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  // LiveKit retries are expected traffic: acknowledged, never re-applied.
  assert.equal(runtime.eventTypes(CALL_SESSION_ID).length, 1);
});

test('participant_left and room_finished update the session', async () => {
  const { handler, runtime } = makeHandler();
  const joined = event();
  await handler.handle(Buffer.from(joined), `Bearer ${signBody(joined)}`);

  const left = event({ id: 'evt-2', event: 'participant_left' });
  await handler.handle(Buffer.from(left), `Bearer ${signBody(left)}`);
  assert.equal(runtime.participants.get(CALL_SESSION_ID)?.get('PA_agent')?.left, true);

  const finished = event({ id: 'evt-3', event: 'room_finished', participant: undefined });
  await handler.handle(Buffer.from(finished), `Bearer ${signBody(finished)}`);
  const session = await runtime.getCallSession(CALL_SESSION_ID);
  assert.equal(session?.state, 'room-finished');
  assert.ok(session?.endedAt);
});

test('a webhook for an unknown room is acknowledged without inventing state', async () => {
  const { handler, runtime } = makeHandler();
  const body = event({ id: 'evt-9', room: { name: 'someone-elses-room', sid: 'RM_X' } });
  const outcome = await handler.handle(Buffer.from(body), `Bearer ${signBody(body)}`);
  assert.equal(outcome.accepted, true);
  assert.equal(runtime.participants.size, 0);
});

test('room names map back to call session ids only when well formed', () => {
  assert.equal(callSessionIdFromRoom(`aida-${CALL_SESSION_ID}`), CALL_SESSION_ID);
  assert.equal(callSessionIdFromRoom('aida-not-a-uuid'), undefined);
  assert.equal(callSessionIdFromRoom('other-room'), undefined);
  assert.equal(callSessionIdFromRoom(undefined), undefined);
});

test('dispatch metadata is restricted to the allowlist', () => {
  const metadata = buildCallMetadata({
    callSessionId: 'cs-1',
    tenantId: 'tenant-1',
    businessName: 'Acme',
    prompt: 'p',
    locale: 'en-US',
    didE164: '+1555',
    // Extra fields a future table might grow must not survive.
    ...({ model: 'gpt', voice: 'nova', identityUserId: 42 } as object),
  });
  assert.equal('model' in metadata, false);
  assert.equal('voice' in metadata, false);
  assert.equal('identityUserId' in metadata, false);
  assert.equal(metadata.businessName, 'Acme');
});

test('the LiveKit client signs REST calls and reports failures as upstream errors', async () => {
  const { logger } = captureLogger();
  const seen: Array<{ url: string; auth?: string; body: unknown }> = [];
  const client = new LiveKitClient({
    url: 'wss://acme.livekit.cloud',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    agentName: 'aida-prime',
    timeoutMs: 200,
    logger,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.authorization,
        body: JSON.parse(String(init?.body)),
      });
      return String(input).includes('CreateRoom') ? new Response('{}', { status: 200 }) : new Response('{}', { status: 500 });
    }) as typeof fetch,
  });

  await client.createRoom('aida-cs-1');
  // ws:// project URL is translated to the https twirp endpoint.
  assert.equal(seen[0]?.url, 'https://acme.livekit.cloud/twirp/livekit.RoomService/CreateRoom');
  assert.ok(seen[0]?.auth?.startsWith('Bearer '));

  await assert.rejects(
    client.dispatchAidaPrime('aida-cs-1', {
      callSessionId: 'cs-1',
      tenantId: 't',
      businessName: 'Acme',
      prompt: 'p',
      locale: 'en-US',
      didE164: '+1555',
    }),
    /returned 500/,
  );
});
