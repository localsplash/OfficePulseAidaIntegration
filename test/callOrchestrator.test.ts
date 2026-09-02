import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallOrchestrator } from '../src/orchestrator/callOrchestrator.js';
import { FallbackResolver } from '../src/orchestrator/fallbackResolver.js';
import { NocoConfigRepository } from '../src/nocodb/configRepository.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { FakeLiveKit, FakeNocoApi, FakeNotifier, seedHealthyBase } from './helpers/fakeCloud.js';
import { captureLogger } from './helpers/capture.js';

const DID = '+15559870001';

interface Harness {
  orchestrator: CallOrchestrator;
  noco: FakeNocoApi;
  runtime: FakeRuntimeStore;
  realtime: FakeRealtimeStore;
  livekit: FakeLiveKit;
  notifier: FakeNotifier;
  lines: string[];
}

function makeHarness(opts: { operatorDefault?: { context: string; exten: string } } = {}): Harness {
  const { logger, lines } = captureLogger();
  const noco = new FakeNocoApi();
  const runtime = new FakeRuntimeStore();
  const realtime = new FakeRealtimeStore();
  const livekit = new FakeLiveKit();
  const notifier = new FakeNotifier();
  seedHealthyBase(noco);

  // The local projection the DID provisioning path writes.
  realtime.objects.set('EXTENSION|ext-1', {
    kind: 'EXTENSION',
    external_id: 'ext-1',
    tenant_id: 'tenant-1',
    context: 'office-main',
    exten: '100',
    endpoint_id: '100-abc123',
    enabled: 1,
  });
  runtime.fallbacks.set('route-1', {
    didRouteId: 'route-1',
    tenantId: 'tenant-1',
    didE164: DID,
    destinationType: 'EXTENSION',
    destinationId: 'ext-1',
    enabled: true,
  });

  const fallbackResolver = new FallbackResolver({
    runtime,
    realtime,
    logger,
    operatorDefault: opts.operatorDefault,
  });

  const orchestrator = new CallOrchestrator({
    config: new NocoConfigRepository(noco),
    runtime,
    livekit,
    notifier,
    fallbackResolver,
    logger,
    livekitSipHost: 'sip.livekit.test',
    defaultLocale: 'en-US',
  });
  return { orchestrator, noco, runtime, realtime, livekit, notifier, lines };
}

const REQUEST = {
  officePulseInstanceId: 'op-primary',
  asteriskLinkedId: 'linked-1',
  callerNumber: '15551230001',
  didE164: DID,
};

test('SCREEN: resolves route from NocoDB, pins configuration, dispatches aida-prime', async () => {
  const h = makeHarness();
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);

  assert.equal(decision.disposition, 'SCREEN');
  assert.ok(decision.callSessionId);
  assert.equal(decision.roomName, `aida-${decision.callSessionId}`);
  assert.equal(decision.sipDestination, `aida-${decision.callSessionId}@sip.livekit.test`);

  // Configuration ids AND revisions are pinned onto the session.
  const session = await h.runtime.getCallSession(decision.callSessionId as string);
  assert.deepEqual(session?.config, {
    didRouteId: 'route-1',
    didRouteRevision: 11,
    profileId: 'profile-1',
    profileRevision: 3,
    tenantRevision: 7,
  });
  assert.equal(session?.tenantId, 'tenant-1');
  assert.equal(session?.destinationType, 'EXTENSION');
  assert.equal(session?.destinationId, 'ext-1');

  // Room created before dispatch, and the agent is the configured one.
  assert.deepEqual(h.livekit.rooms, [decision.roomName]);
  assert.equal(h.livekit.dispatches.length, 1);
});

test('dispatch metadata is the allowlist only — no model/STT/TTS/voice, no identity fields', async () => {
  const h = makeHarness();
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  const metadata = h.livekit.dispatches[0]?.metadata as unknown as Record<string, unknown>;
  assert.ok(metadata);

  assert.deepEqual(Object.keys(metadata).sort(), [
    'businessName',
    'callSessionId',
    'didE164',
    'failedTransferStatement',
    'locale',
    'objective',
    'openingStatement',
    'prompt',
    'tenantId',
    'tone',
    'transferStatement',
  ]);
  assert.equal(metadata.callSessionId, decision.callSessionId);
  assert.equal(metadata.businessName, 'Acme Dental');
  assert.equal(metadata.locale, 'en-US');
  // Inherited from the predefined agent, never sent per call.
  for (const forbidden of ['model', 'stt', 'tts', 'voice', 'identityUserId', 'callerNumber']) {
    assert.equal(forbidden in metadata, false, `${forbidden} must not be sent`);
  }
});

test('call arrival is published to the destination extension device', async () => {
  const h = makeHarness();
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(h.notifier.alerts.length, 1);
  assert.equal(h.notifier.alerts[0]?.deviceId, 'device-1');
  assert.equal(h.notifier.alerts[0]?.alert.callSessionId, decision.callSessionId);
});

test('a failing notifier never blocks the caller', async () => {
  const h = makeHarness();
  h.notifier.fail = true;
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.disposition, 'SCREEN');
});

test('NocoDB unavailable degrades to this DID\'s own local destination', async () => {
  const h = makeHarness();
  h.noco.failOn = '*';
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);

  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallbackReason, 'nocodb-unavailable');
  assert.deepEqual(decision.fallback, {
    context: 'office-main',
    exten: '100',
    source: 'did-projection',
    tenantId: 'tenant-1',
  });
  assert.equal(h.livekit.dispatches.length, 0);
});

test('LiveKit unavailable degrades to the route destination and records the fallback', async () => {
  const h = makeHarness();
  h.livekit.failDispatch = true;
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);

  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallbackReason, 'livekit-unavailable');
  assert.equal(decision.fallback?.context, 'office-main');
  assert.equal(decision.fallback?.exten, '100');

  // The session exists and records why it fell back.
  const [session] = [...h.runtime.sessions.values()];
  assert.equal(session?.disposition, 'FALLBACK');
  assert.ok(h.runtime.eventTypes(session?.id as string).includes('fallback'));
});

test('unknown DID falls back without inventing a destination', async () => {
  const h = makeHarness();
  const decision = await h.orchestrator.bootstrapInboundCall({ ...REQUEST, didE164: '+15550000000' });
  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallbackReason, 'no-enabled-route');
  assert.equal(decision.fallback, undefined);
});

test('unknown DID uses the operator emergency default only when one is configured', async () => {
  const h = makeHarness({ operatorDefault: { context: 'office-main', exten: '000' } });
  const decision = await h.orchestrator.bootstrapInboundCall({ ...REQUEST, didE164: '+15550000000' });
  assert.equal(decision.fallback?.source, 'operator-default');
  assert.equal(decision.fallback?.exten, '000');
});

test('screening disabled routes straight to the destination, not the emergency default', async () => {
  const h = makeHarness({ operatorDefault: { context: 'emergency', exten: '911' } });
  h.noco.seed('did_route', [
    {
      id: 'route-1',
      revision: 11,
      tenant_id: 'tenant-1',
      did_e164: DID,
      assistant_profile_id: 'profile-1',
      destination_type: 'EXTENSION',
      destination_extension_id: 'ext-1',
      destination_ring_group_id: '',
      screening_enabled: false,
      enabled: true,
    },
  ]);
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallbackReason, 'screening-disabled');
  assert.equal(decision.fallback?.source, 'route-destination');
  assert.equal(decision.fallback?.exten, '100');
});

test('a disabled tenant or profile is a fallback, not a screening call', async () => {
  for (const key of ['tenantEnabled', 'profileEnabled'] as const) {
    const h = makeHarness();
    seedHealthyBase(h.noco, { [key]: false });
    const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
    assert.equal(decision.disposition, 'FALLBACK', `${key}=false must fall back`);
    assert.equal(h.livekit.dispatches.length, 0);
  }
});

test('a profile belonging to another tenant is refused', async () => {
  const h = makeHarness();
  h.noco.seed('assistant_profile', [
    {
      id: 'profile-1',
      revision: 3,
      tenant_id: 'tenant-OTHER',
      name: 'Reception',
      business_name: 'Someone Else',
      prompt: 'Leaked prompt',
      enabled: true,
    },
  ]);
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(h.livekit.dispatches.length, 0);
});

test('a retried FastAGI leg reuses the session and never dispatches twice', async () => {
  const h = makeHarness();
  const first = await h.orchestrator.bootstrapInboundCall(REQUEST);
  const second = await h.orchestrator.bootstrapInboundCall(REQUEST);

  assert.equal(second.callSessionId, first.callSessionId);
  assert.equal(second.roomName, first.roomName);
  assert.equal(h.livekit.dispatches.length, 1, 'exactly one agent dispatch per call');
  assert.equal(h.runtime.sessions.size, 1);
});

test('runtime store unavailable still routes the caller to the DID destination', async () => {
  const h = makeHarness();
  h.runtime.failOn = 'createCallSession';
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallbackReason, 'runtime-store-unavailable');
  assert.equal(decision.fallback?.exten, '100');
});

test('a DID whose destination belongs to another tenant is never used', async () => {
  const h = makeHarness({ operatorDefault: { context: 'emergency', exten: '911' } });
  h.noco.failOn = '*';
  // The projection points at a destination provisioned for a DIFFERENT tenant.
  h.realtime.objects.set('EXTENSION|ext-1', {
    kind: 'EXTENSION',
    external_id: 'ext-1',
    tenant_id: 'tenant-OTHER',
    context: 'other-tenant',
    exten: '100',
    endpoint_id: 'x',
    enabled: 1,
  });
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.fallback?.source, 'operator-default');
  assert.equal(decision.fallback?.context, 'emergency');
  assert.ok(h.lines.join('\n').includes('refusing cross-tenant fallback destination'));
});

test('no projection and no operator default leaves no destination rather than a wrong one', async () => {
  const h = makeHarness();
  h.noco.failOn = '*';
  h.runtime.fallbacks.clear();
  const decision = await h.orchestrator.bootstrapInboundCall(REQUEST);
  assert.equal(decision.disposition, 'FALLBACK');
  assert.equal(decision.fallback, undefined);
});

test('the caller number never reaches the agent or the logs', async () => {
  const h = makeHarness();
  await h.orchestrator.bootstrapInboundCall(REQUEST);
  const metadata = JSON.stringify(h.livekit.dispatches[0]?.metadata);
  assert.ok(!metadata.includes('15551230001'));
  assert.ok(!h.lines.join('\n').includes('15551230001'));
});

test('the local fallback is found whether or not Asterisk sends the leading +', async () => {
  // Provisioning normalizes to '+15559870001'; a trunk may present either
  // form. Missing the projection over a plus sign would silently downgrade
  // this DID to the emergency default.
  for (const presented of ['+15559870001', '15559870001']) {
    const h = makeHarness({ operatorDefault: { context: 'emergency', exten: '911' } });
    h.noco.failOn = '*';
    const decision = await h.orchestrator.bootstrapInboundCall({ ...REQUEST, didE164: presented });
    assert.equal(decision.fallback?.source, 'did-projection', `${presented} must find its own destination`);
    assert.equal(decision.fallback?.exten, '100');
  }
});
