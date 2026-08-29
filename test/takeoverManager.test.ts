import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TakeoverManager, CHANVAR, type TakeoverCommand } from '../src/takeover/takeoverManager.js';
import { ConflictError, NotFoundError } from '../src/errors.js';
import { FakeAri, FakeEventSink } from './helpers/fakeAri.js';
import { captureLogger } from './helpers/capture.js';
import type { AriChannel } from '../src/ari/types.js';

const CS = 'cs-0001';

function makeManager(drainTimeoutMs = 150): { manager: TakeoverManager; ari: FakeAri; sink: FakeEventSink } {
  const ari = new FakeAri();
  const sink = new FakeEventSink();
  const { logger } = captureLogger();
  const manager = new TakeoverManager({
    ari,
    events: sink,
    logger,
    drainTimeoutMs,
    defaultRingTimeoutSeconds: 20,
    defaultMohClass: 'default',
    livekitTrunkEndpoint: 'livekit-cloud',
  });
  return { manager, ari, sink };
}

/** Drive a caller through SCREEN into a bridged Aida conversation. */
async function screenCall(ari: FakeAri, callSessionId = CS): Promise<{ caller: AriChannel; livekit: AriChannel; bridgeId: string }> {
  const caller = ari.makeChannel('caller-1', 'Up', '15551230001');
  ari.setVar(caller.id, CHANVAR.sipDestination, 'room-1@sip.livekit.test');
  ari.setVar(caller.id, CHANVAR.routeToken, 'tok-1');
  ari.emitStasisStart(['screen', callSessionId], caller);
  await tick();
  assert.equal(ari.originates.length, 1, 'exactly one livekit originate');
  const livekit = ari.makeChannel('livekit-1', 'Up');
  ari.emitStasisStart(['livekit', callSessionId], livekit);
  await tick();
  const bridgeId = [...ari.bridges.keys()][0] as string;
  return { caller, livekit, bridgeId };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const CMD: TakeoverCommand = {
  callSessionId: CS,
  idempotencyKey: 'key-1',
  destinationType: 'EXTENSION',
  context: 'office-main',
  exten: '100',
};

test('screen flow: caller answered, bridge created, livekit originated through the trunk with headers', async () => {
  const { ari, sink } = makeManager();
  const { caller, livekit, bridgeId } = await screenCall(ari);
  assert.deepEqual(ari.answered, [caller.id]);
  const originate = ari.originates[0];
  assert.ok(originate);
  assert.equal(originate.endpoint, 'PJSIP/room-1@sip.livekit.test@livekit-cloud');
  assert.equal(originate.variables?.['PJSIP_HEADER(add,X-Aida-Call-Session)'], CS);
  assert.equal(originate.variables?.['PJSIP_HEADER(add,X-Aida-Route-Token)'], 'tok-1');
  const bridge = ari.bridges.get(bridgeId);
  assert.ok(bridge?.channels.has(caller.id));
  assert.ok(bridge?.channels.has(livekit.id));
  assert.deepEqual(sink.types(), ['screening-started', 'aida-connected']);
});

test('takeover happy path: single originate, MOH, answer bridges human, drain removes only aida', async () => {
  const { manager, ari, sink } = makeManager(120);
  const { caller, livekit, bridgeId } = await screenCall(ari);

  const ack = await manager.takeover(CMD);
  assert.equal(ack.status, 'ringing');
  assert.equal(ari.originates.length, 2);
  const humanOriginate = ari.originates[1];
  assert.equal(humanOriginate?.endpoint, 'Local/100@office-main');
  assert.equal(humanOriginate?.timeoutSeconds, 20);
  assert.deepEqual(ari.mohStarts, [{ bridgeId, mohClass: 'default' }]);

  const human = ari.originatedChannels[1] as AriChannel;
  ari.emitStateChange(human, 'Ringing');
  await tick();
  ari.emitStasisStart(['human', CS, 'key-1'], human);
  await tick();

  // Human is in the bridge with the caller immediately; MOH stopped.
  assert.deepEqual(ari.mohStops, [bridgeId]);
  const bridge = ari.bridges.get(bridgeId);
  assert.ok(bridge?.channels.has(human.id));
  assert.ok(bridge?.channels.has(caller.id));

  // Drain deadline removes only the livekit leg.
  await tick(200);
  assert.deepEqual(ari.removedFromBridge, [{ bridgeId, channelId: livekit.id }]);
  assert.deepEqual(ari.hangups.map((h) => h.channelId), [livekit.id]);
  assert.ok(bridge?.channels.has(caller.id), 'caller never leaves the bridge');
  assert.ok(bridge?.channels.has(human.id), 'human never leaves the bridge');
  assert.deepEqual(sink.types(), [
    'screening-started',
    'aida-connected',
    'takeover-requested',
    'ringing',
    'answered',
    'bridged',
    'aida-drained',
  ]);

  // Replay after completion returns the recorded outcome.
  const replay = await manager.takeover(CMD);
  assert.equal(replay.status, 'answered');
  assert.equal(ari.originates.length, 2, 'replay never re-originates');
});

test('drain-ack removes aida before the deadline', async () => {
  const { manager, ari } = makeManager(5_000);
  const { livekit } = await screenCall(ari);
  await manager.takeover(CMD);
  const human = ari.originatedChannels[1] as AriChannel;
  ari.emitStasisStart(['human', CS, 'key-1'], human);
  await tick();
  const ack = await manager.acknowledgeDrain(CS);
  assert.equal(ack.status, 'drained');
  assert.deepEqual(ari.hangups.map((h) => h.channelId), [livekit.id]);
  // A second ack is a no-op.
  assert.equal((await manager.acknowledgeDrain(CS)).status, 'already-drained');
});

test('duplicate command while ringing returns in-progress without another originate', async () => {
  const { manager, ari } = makeManager();
  await screenCall(ari);
  await manager.takeover(CMD);
  const dup = await manager.takeover(CMD);
  assert.equal(dup.status, 'in-progress');
  assert.equal(ari.originates.length, 2);
});

test('concurrent different command conflicts', async () => {
  const { manager, ari } = makeManager();
  await screenCall(ari);
  await manager.takeover(CMD);
  await assert.rejects(manager.takeover({ ...CMD, idempotencyKey: 'key-2' }), ConflictError);
  assert.equal(ari.originates.length, 2);
});

test('takeover without an active screened call is rejected', async () => {
  const { manager } = makeManager();
  await assert.rejects(manager.takeover(CMD), NotFoundError);
});

for (const [cause, reason] of [
  [17, 'busy'],
  [21, 'rejected'],
  [19, 'no-answer'],
] as Array<[number, string]>) {
  test(`ring failure cause ${cause} reports ${reason}, stops MOH, caller stays with aida`, async () => {
    const { manager, ari, sink } = makeManager();
    const { caller, livekit, bridgeId } = await screenCall(ari);
    await manager.takeover(CMD);
    const human = ari.originatedChannels[1] as AriChannel;
    ari.emitDestroyed(human, cause);
    await tick();
    assert.deepEqual(ari.mohStops, [bridgeId]);
    const bridge = ari.bridges.get(bridgeId);
    assert.ok(bridge?.channels.has(caller.id));
    assert.ok(bridge?.channels.has(livekit.id), 'aida stays bridged after ring failure');
    assert.equal(ari.hangups.length, 0);
    const failure = sink.events.find((e) => e.eventType === 'takeover-failed');
    assert.equal(failure?.payload?.reason, reason);
    // Replaying the failed command returns the recorded failure.
    assert.equal((await manager.takeover(CMD)).status, reason);
    // A new command with a new key may retry and originates again.
    assert.equal((await manager.takeover({ ...CMD, idempotencyKey: 'key-2' })).status, 'ringing');
    assert.equal(ari.originates.length, 3);
  });
}

test('human hangup during drain keeps aida with the caller', async () => {
  const { manager, ari, sink } = makeManager(5_000);
  const { caller, livekit, bridgeId } = await screenCall(ari);
  await manager.takeover(CMD);
  const human = ari.originatedChannels[1] as AriChannel;
  ari.emitStasisStart(['human', CS, 'key-1'], human);
  await tick();
  ari.emitDestroyed(human, 16);
  await tick();
  const bridge = ari.bridges.get(bridgeId);
  assert.ok(bridge?.channels.has(caller.id));
  assert.ok(bridge?.channels.has(livekit.id), 'aida must NOT be drained after the human is gone');
  assert.equal(ari.hangups.length, 0);
  assert.ok(sink.types().includes('human-hangup'));
  // Pending drain must not fire later.
  const before = ari.hangups.length;
  await manager.acknowledgeDrain(CS).catch(() => {});
  assert.equal(ari.hangups.length, before);
});

test('human hangup after completed drain ends the call', async () => {
  const { manager, ari } = makeManager(50);
  const { caller } = await screenCall(ari);
  await manager.takeover(CMD);
  const human = ari.originatedChannels[1] as AriChannel;
  ari.emitStasisStart(['human', CS, 'key-1'], human);
  await tick(120); // drain deadline passes, aida removed
  ari.emitDestroyed(human, 16);
  await tick();
  assert.ok(ari.hangups.some((h) => h.channelId === caller.id));
});

test('caller hangup during ring tears down other legs and session', async () => {
  const { manager, ari, sink } = makeManager();
  const { caller, livekit } = await screenCall(ari);
  await manager.takeover(CMD);
  const humanId = (ari.originatedChannels[1] as AriChannel).id;
  ari.emitDestroyed(caller, 16);
  await tick();
  assert.ok(ari.hangups.some((h) => h.channelId === livekit.id));
  assert.ok(ari.hangups.some((h) => h.channelId === humanId));
  assert.ok(sink.types().includes('hangup'));
  await assert.rejects(manager.takeover(CMD), NotFoundError);
});

test('answer/hangup race: human answers while caller is gone gets released', async () => {
  const { ari } = makeManager();
  const { caller } = await screenCall(ari);
  ari.emitDestroyed(caller, 16);
  await tick();
  const orphan = ari.makeChannel('late-human', 'Up');
  ari.emitStasisStart(['human', CS, 'key-1'], orphan);
  await tick();
  assert.ok(ari.hangups.some((h) => h.channelId === orphan.id));
});

test('aida lost during screening is reported, caller stays up', async () => {
  const { ari, sink } = makeManager();
  const { caller, livekit } = await screenCall(ari);
  ari.emitDestroyed(livekit, 16);
  await tick();
  assert.ok(sink.types().includes('aida-lost'));
  assert.ok(!ari.hangups.some((h) => h.channelId === caller.id));
});

test('reconciliation rebuilds sessions and prevents duplicate originate for a rediscovered command', async () => {
  const { manager: crashed, ari } = makeManager();
  await screenCall(ari);
  await crashed.takeover(CMD);
  const human = ari.originatedChannels[1] as AriChannel;
  human.state = 'Up'; // originate-to-app: StasisStart implies answered
  ari.emitStasisStart(['human', CS, 'key-1'], human);
  await tick();

  // Simulate a restart: fresh manager over the same live ARI resources.
  const sink2 = new FakeEventSink();
  const { logger } = captureLogger();
  const fresh = new TakeoverManager({
    ari,
    events: sink2,
    logger,
    drainTimeoutMs: 100,
    defaultRingTimeoutSeconds: 20,
    defaultMohClass: 'default',
  });
  const originatesBefore = ari.originates.length;
  await fresh.reconcile();
  const replay = await fresh.takeover(CMD);
  assert.equal(replay.status, 'answered');
  assert.equal(ari.originates.length, originatesBefore, 'reconciled command never re-originates');
  const session = fresh.getSession(CS);
  assert.ok(session?.bridgeId, 'bridge rediscovered');
  assert.equal(session?.humanChannelId, human.id);
});
