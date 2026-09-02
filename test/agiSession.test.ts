import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastAgiServer } from '../src/agi/fastAgiServer.js';
import type { AgiSession } from '../src/agi/agiSession.js';
import { FakeAsteriskCall } from './helpers/fakeAsteriskCall.js';
import { captureLogger } from './helpers/capture.js';

const BASE_ENV = {
  agi_network: 'yes',
  agi_network_script: 'echo',
  agi_request: 'agi://127.0.0.1:0/echo',
  agi_channel: 'PJSIP/trunk-00000001',
  agi_uniqueid: '1756400000.1',
  agi_callerid: '15551230001',
  agi_extension: '15559870001',
};

async function withServer(
  handler: (session: AgiSession) => Promise<void>,
  fn: (port: number) => Promise<void>,
  opts?: { maxConnections?: number; sessionTimeoutMs?: number },
): Promise<void> {
  const { logger } = captureLogger();
  const server = new FastAgiServer({
    port: 0,
    bind: '127.0.0.1',
    maxConnections: opts?.maxConnections ?? 5,
    sessionTimeoutMs: opts?.sessionTimeoutMs ?? 2000,
    logger,
    handlers: { echo: handler },
  });
  await server.listen();
  try {
    await fn(server.address()?.port as number);
  } finally {
    await server.close();
  }
}

test('parses AGI environment and exchanges variables', async () => {
  let seenEnv: Record<string, string> = {};
  let readVar: string | undefined;
  await withServer(
    async (session) => {
      seenEnv = { ...session.env };
      readVar = await session.getVariable('SOME_VAR');
      await session.setVariable('OUT_VAR', 'value with "quotes" and spaces');
    },
    async (port) => {
      const call = new FakeAsteriskCall(BASE_ENV, { SOME_VAR: 'hello' });
      await call.dial(port);
      await call.waitForHangup();
      assert.equal(call.setVars.get('OUT_VAR'), 'value with "quotes" and spaces');
    },
  );
  assert.equal(seenEnv['agi_uniqueid'], '1756400000.1');
  assert.equal(readVar, 'hello');
});

test('GET VARIABLE for an unset variable resolves undefined', async () => {
  let value: string | undefined = 'sentinel';
  await withServer(
    async (session) => {
      value = await session.getVariable('MISSING');
    },
    async (port) => {
      const call = new FakeAsteriskCall(BASE_ENV, {});
      await call.dial(port);
      await call.waitForHangup();
    },
  );
  assert.equal(value, undefined);
});

test('connection limit refuses excess sessions immediately', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await withServer(
    async () => {
      await gate; // hold the one allowed session open
    },
    async (port) => {
      const first = new FakeAsteriskCall(BASE_ENV, {});
      await first.dial(port);
      await new Promise((r) => setTimeout(r, 100));
      const second = new FakeAsteriskCall(BASE_ENV, {});
      await second.dial(port);
      // The second connection must be destroyed by the server.
      await second.waitForHangup(2000);
      release();
      await first.waitForHangup(2000);
    },
    { maxConnections: 1 },
  );
});

test('session wall-clock deadline destroys stuck sessions', async () => {
  await withServer(
    async () => {
      await new Promise((r) => setTimeout(r, 60_000).unref()); // never finishes on its own
    },
    async (port) => {
      const call = new FakeAsteriskCall(BASE_ENV, {});
      const started = Date.now();
      await call.dial(port);
      await call.waitForHangup(3000);
      assert.ok(Date.now() - started < 2500, 'deadline should fire well before the handler finishes');
    },
    { sessionTimeoutMs: 300 },
  );
});

test('unknown script is closed without a handler crash', async () => {
  await withServer(
    async () => assert.fail('handler must not run'),
    async (port) => {
      const call = new FakeAsteriskCall({ ...BASE_ENV, agi_network_script: 'nope' }, {});
      await call.dial(port);
      await call.waitForHangup();
    },
  );
});
