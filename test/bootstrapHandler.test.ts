import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastAgiServer } from '../src/agi/fastAgiServer.js';
import { createBootstrapHandler } from '../src/agi/bootstrapHandler.js';
import { nativePbxFallback, type BootstrapDecision, type BootstrapRequest, type BootstrapDecider } from '../src/agi/bootstrapHandler.js';
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

/**
 * Runs one fake inbound call against a FastAGI server whose orchestrator is
 * stubbed, so this suite covers the AGI variable contract exactly — the
 * canonical native admission remains unavailable until PBX mapping is defined.
 */
async function runCall(
  decide: (request: BootstrapRequest) => Promise<BootstrapDecision> | BootstrapDecision,
  channelVars: Record<string, string> = CHANNEL_VARS,
): Promise<{ call: FakeAsteriskCall; requests: BootstrapRequest[]; logLines: string[] }> {
  const { logger, lines } = captureLogger();
  const requests: BootstrapRequest[] = [];
  const orchestrator = {
    async bootstrapInboundCall(request: BootstrapRequest): Promise<BootstrapDecision> {
      requests.push(request);
      return decide(request);
    },
  } as unknown as BootstrapDecider;

  const server = new FastAgiServer({
    port: 0,
    bind: '127.0.0.1',
    maxConnections: 5,
    sessionTimeoutMs: 5000,
    logger,
    handlers: {
      bootstrap: createBootstrapHandler({ orchestrator, officePulseInstanceId: 'op-env', logger }),
    },
  });
  await server.listen();
  const call = new FakeAsteriskCall(CALL_ENV, channelVars);
  try {
    await call.dial(server.address()?.port as number);
    await call.waitForHangup(4000);
  } finally {
    await server.close();
  }
  return { call, requests, logLines: lines };
}

test('SCREEN sets the routing variables Asterisk needs to join LiveKit', async () => {
  const { call, requests } = await runCall(() => ({
    disposition: 'SCREEN',
    callSessionId: 'cs-1',
    roomName: 'aida-cs-1',
    sipDestination: 'aida-cs-1@sip.livekit.test',
  }));

  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'SCREEN');
  assert.equal(call.setVars.get('AIDA_CALL_SESSION_ID'), 'cs-1');
  assert.equal(call.setVars.get('AIDA_ROOM_NAME'), 'aida-cs-1');
  assert.equal(call.setVars.get('AIDA_SIP_DESTINATION'), 'aida-cs-1@sip.livekit.test');

  assert.deepEqual(requests[0], {
    officePulseInstanceId: 'op-primary',
    asteriskLinkedId: '1756400100.42',
    callerNumber: '15551230001',
    didE164: '15559870001',
  });
});

test('FALLBACK sets the resolved destination for the dialplan to dial', async () => {
  const { call } = await runCall(() => ({
    disposition: 'FALLBACK',
    fallbackReason: 'nocodb-unavailable',
    fallback: { context: 'office-main', exten: '100', source: 'did-projection', tenantId: 'tenant-1' },
  }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
  assert.equal(call.setVars.get('AIDA_FALLBACK_CONTEXT'), 'office-main');
  assert.equal(call.setVars.get('AIDA_FALLBACK_EXTENSION'), '100');
});

test('FALLBACK without a resolved destination still marks the disposition', async () => {
  const { call } = await runCall(() => ({ disposition: 'FALLBACK', fallbackReason: 'no-enabled-route' }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
  assert.equal(call.setVars.has('AIDA_FALLBACK_CONTEXT'), false);
});

test('REJECT sets only the disposition', async () => {
  const { call } = await runCall(() => ({ disposition: 'REJECT' }));
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'REJECT');
  assert.equal(call.setVars.has('AIDA_ROOM_NAME'), false);
});

test('an unexpected orchestrator failure still yields FALLBACK, never a stranded caller', async () => {
  const { call } = await runCall(() => {
    throw new Error('unforeseen');
  });
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
});

test('missing linkedid falls back to uniqueid; missing instance id falls back to config', async () => {
  const { requests } = await runCall(() => ({ disposition: 'REJECT' }), {});
  assert.equal(requests[0]?.asteriskLinkedId, '1756400100.42');
  assert.equal(requests[0]?.officePulseInstanceId, 'op-env');
});

test('an anonymous caller is reported as absent rather than as literal text', async () => {
  const { requests } = await runCall(() => ({ disposition: 'REJECT' }), {
    ...CHANNEL_VARS,
  });
  assert.equal(requests[0]?.callerNumber, '15551230001');

  const anonymous = await runCallWithEnv({ ...CALL_ENV, agi_callerid: 'Anonymous' });
  assert.equal(anonymous.requests[0]?.callerNumber, undefined);
});

async function runCallWithEnv(env: Record<string, string>): Promise<{ requests: BootstrapRequest[] }> {
  const { logger } = captureLogger();
  const requests: BootstrapRequest[] = [];
  const orchestrator = {
    async bootstrapInboundCall(request: BootstrapRequest): Promise<BootstrapDecision> {
      requests.push(request);
      return { disposition: 'REJECT' };
    },
  } as unknown as BootstrapDecider;
  const server = new FastAgiServer({
    port: 0,
    bind: '127.0.0.1',
    maxConnections: 5,
    sessionTimeoutMs: 5000,
    logger,
    handlers: {
      bootstrap: createBootstrapHandler({ orchestrator, officePulseInstanceId: 'op-env', logger }),
    },
  });
  await server.listen();
  const call = new FakeAsteriskCall(env, CHANNEL_VARS);
  try {
    await call.dial(server.address()?.port as number);
    await call.waitForHangup(4000);
  } finally {
    await server.close();
  }
  return { requests };
}

test('canonical native fallback keeps PBX-owned destination variables without a config lookup', async () => {
  const { call } = await runCall(nativePbxFallback.bootstrapInboundCall, {
    ...CHANNEL_VARS, AIDA_FALLBACK_CONTEXT: 'pbx-owned', AIDA_FALLBACK_EXTENSION: 'support',
  });
  assert.equal(call.setVars.get('AIDA_DISPOSITION'), 'FALLBACK');
  assert.equal(call.setVars.has('AIDA_FALLBACK_CONTEXT'), false);
  assert.equal(call.setVars.has('AIDA_FALLBACK_EXTENSION'), false);
});
