import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Room } from '@livekit/rtc-node';
import { credential, digest, profileSnapshot, parseBinding, CredentialRejected } from '../src/agent/contract.js';
import type { Admission, AdmissionStore } from '../src/agent/store.js';
import { BootstrapAuthority, type AgentLiveKit, type Participant } from '../src/agent/authority.js';
import { NativeCallOrchestrator } from '../src/agent/orchestrator.js';
import { AgentMonitor } from '../src/agent/monitor.js';
import { NativeAdmissionAuthority } from '../src/agent/native.js';
import { agentConfig } from '../src/agent/config.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';
import { FakeAri, FakeEventSink } from './helpers/fakeAri.js';
import { TakeoverManager } from '../src/takeover/takeoverManager.js';
import { captureLogger } from './helpers/capture.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bootstrap-v1.json', import.meta.url), 'utf8'));
const id: string = fixture.dispatch.callSessionId;
class MemoryAdmissions implements AdmissionStore {
  rows = new Map<string, Admission>();
  async create(a: Admission) { if (this.rows.has(a.callId)) throw new Error('duplicate'); this.rows.set(a.callId, structuredClone(a)); }
  async get(id: string) { return structuredClone(this.rows.get(id)); }
  async dispatched(id: string, dispatchId: string) { Object.assign(this.rows.get(id)!, { dispatchId, status: 'dispatched' }); }
  async consume(a: Admission, b: Parameters<AdmissionStore['consume']>[1]) {
    const row = this.rows.get(a.callId)!;
    if (row.status !== 'dispatched') throw new CredentialRejected();
    Object.assign(row, b, { status: 'admitted' }); return row.profile;
  }
  async transition(id: string, status: 'ready' | 'fallback' | 'ended') {
    const row = this.rows.get(id); if (!row || row.status === status || row.status === 'ended' || (status === 'ready' && row.status !== 'admitted')) return false;
    row.status = status; return true;
  }
}
function setup() {
  const runtime = new FakeRuntimeStore();
  runtime.seedSession({ id, roomName: `aida-${id}`, tenantId: '42', didE164: fixture.response.profileSnapshot.didE164,
    officePulseInstanceId: 'op-test', asteriskLinkedId: 'linked', destinationId: 'queue42', config: { profileId: 'profile42' }, disposition: 'SCREEN' });
  const store = new MemoryAdmissions();
  const a: Admission = { callId: id, roomName: `aida-${id}`, tenantId: '42', instanceId: 'op-test', linkedId: 'linked',
    profile: profileSnapshot(fixture.response.profileSnapshot), bootstrapHash: digest(fixture.dispatch.bootstrapToken), routeHash: digest(fixture.request.routeToken),
    expiresAt: Date.now() + 120000, dispatchId: 'dispatch42', status: 'dispatched' };
  store.rows.set(id, a);
  const participants: Participant[] = [
    { sid: 'PA_sip', identity: 'sip-caller', kind: 3, attributes: { 'sip.aidaRouteToken': fixture.request.routeToken } },
    { sid: 'PA_agent', identity: 'agent-1', kind: 4 },
  ];
  const livekit: AgentLiveKit = { listParticipants: async () => participants, dispatchIdentity: async () => 'agent-1',
    dispatchAgent: async () => 'dispatch42', createRoom: async () => {} };
  const native = { authorized: async () => true, resolve: async () => undefined };
  const authority = new BootstrapAuthority({ store, runtime, native, livekit, routeAttribute: 'sip.aidaRouteToken', instanceId: 'op-test' });
  return { runtime, store, a, participants, livekit, native, authority };
}
test('Agent shared fixture produces its exact allowlisted response and consumes once', async () => {
  const h = setup();
  assert.deepEqual(await h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request), fixture.response);
  await assert.rejects(h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request), CredentialRejected);
  assert.equal(h.store.rows.get(id)?.agentSid, 'PA_agent');
});
test('credential, tenant, room, dispatch and SIP mismatches never consume either credential', async t => {
  const cases: Record<string, (h: ReturnType<typeof setup>) => void> = {
    expired: h => { h.a.expiresAt = Date.now() - 1; },
    bootstrap: h => { h.a.bootstrapHash = digest(credential()); },
    route: h => { h.a.routeHash = digest(credential()); },
    room: h => { h.a.roomName = 'wrong'; },
    instance: h => { h.a.instanceId = 'wrong'; },
    tenant: h => { h.a.tenantId = '43'; },
    disabled: h => { h.native.authorized = async () => false; },
    ended: h => { h.runtime.sessions.get(id)!.endedAt = new Date().toISOString(); },
    sipSid: h => { h.participants[0]!.sid = 'other'; },
    sipKind: h => { h.participants[0]!.kind = 'STANDARD'; },
    extraSip: h => { h.participants.push({ ...h.participants[0]!, sid: 'other' }); },
    extraAgent: h => { h.participants.push({ ...h.participants[1]!, sid: 'other' }); },
    forgedAgentName: h => { h.participants[1]!.kind = 'STANDARD'; },
    wrongDispatch: h => { h.livekit.dispatchIdentity = async () => 'unrelated-agent'; },
    missingAttribute: h => { h.participants[0]!.attributes = {}; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const h = setup(); mutate(h);
    await assert.rejects(h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request), CredentialRejected);
    assert.equal(h.store.rows.get(id)?.status, 'dispatched');
  });
});
test('strict profile and request validation reject extras, duplicates, null and unsafe tenant IDs', () => {
  for (const profile of [ { ...fixture.response.profileSnapshot, model: 'bad' }, { ...fixture.response.profileSnapshot, prompt: null },
    { ...fixture.response.profileSnapshot, tenantId: '9007199254740992' }, { ...fixture.response.profileSnapshot, locale: 'fr-FR' } ]) assert.throws(() => profileSnapshot(profile));
  const raw = JSON.stringify(fixture.request);
  assert.deepEqual(parseBinding(Buffer.from(raw)), fixture.request);
  assert.throws(() => parseBinding(Buffer.from(raw.replace('{', '{"roomName":"bad",'))));
  assert.throws(() => parseBinding(Buffer.from(raw.replace('{', '{"room\\u004eame":"bad",'))));
  assert.throws(() => parseBinding(Buffer.from(JSON.stringify({ ...fixture.request, tenantId: '43' }))));
});
test('bootstrap HTTP is credential authenticated on public listener and never logs secrets or profiles', async t => {
  const h = setup(); const { logger, lines } = captureLogger();
  const server = new HttpApi(publicApiOptions({ logger, readiness: new Readiness(), trustedServerCidrs: [], trustedProxyCidrs: [],
    maxBodyBytes: 65536, rateLimitPerMinute: 300, routes: [h.authority.route(true)] }));
  await server.listen(0, '127.0.0.1'); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address()!.port}/v1/agent/calls/${id}/bootstrap`;
  const request = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.dispatch.bootstrapToken}` }, body: JSON.stringify(fixture.request) };
  const res = await fetch(url, request); assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.deepEqual(await res.json(), fixture.response);
  assert.equal((await fetch(url, request)).status, 401);
  assert.equal((await fetch(url, { ...request, body: '{"profile":null}' })).status, 400);
  h.store.get = async () => { throw new Error(JSON.stringify(fixture)); };
  assert.equal((await fetch(url, request)).status, 503);
  assert.ok(!lines.join('').includes(fixture.dispatch.bootstrapToken)); assert.ok(!lines.join('').includes(fixture.response.profileSnapshot.prompt));
});
test('native authority requires exact managed DID, unique queue ownership and enabled profile/tenant', async () => {
  const noco = new FakeNocoApi();
  noco.seed('aida_tbl_AssistantProfile', [{ id: 'profile42', revision: 1, iTenantId: 42, enabled: true, business_name: 'Office', prompt: 'Help callers' }]);
  const scope = { contexts: ['tenant42'], queueNames: ['queue42'], didContext: 'ingress' };
  const query = async (sql: string) => sql.includes('SELECT priority') ? didDialplanRows(fixture.response.profileSnapshot.didE164, { queue: 'queue42', ringsBeforeAi: 3 }) as unknown as Record<string, unknown>[] : sql.includes('SELECT name') ? [{ name: 'queue42' }] : [];
  const opts = { scopes: new Map([['42', scope]]), query, noco, tenantEnabled: async () => true, profileIds: new Map<string,string>() };
  const authority = new NativeAdmissionAuthority(opts);
  const request = { didE164: fixture.response.profileSnapshot.didE164, ingressContext: 'ingress', fallbackQueue: 'queue42' };
  assert.equal((await authority.resolve(request, id))?.tenantId, '42');
  assert.equal(await authority.resolve({ ...request, fallbackQueue: 'other' }, id), undefined);
  opts.tenantEnabled = async () => false; assert.equal(await authority.resolve(request, id), undefined);
  opts.tenantEnabled = async () => true;
  noco.tables.get('aida_tbl_AssistantProfile')!.push({ ...noco.tables.get('aida_tbl_AssistantProfile')![0], id: 'other' });
  assert.equal(await authority.resolve(request, id), undefined);
  opts.profileIds.set('42', 'profile42'); assert.ok(await authority.resolve(request, id));
});
test('dispatch contains only v1 credentials and SIP routing returns before agent readiness', async () => {
  const h = setup(); h.runtime.sessions.clear(); h.store.rows.clear(); const order: string[] = []; let metadata: any;
  h.livekit.createRoom = async () => { order.push('room'); };
  h.livekit.dispatchAgent = async (_room, m) => { metadata = m; order.push('dispatch'); return 'dispatch42'; };
  const monitor = { start: async () => { order.push('monitor'); }, stop: async () => {}, close: async () => {} };
  const native = { ...h.native, resolve: async (_: unknown, callId: string) => ({ tenantId: '42', queue: 'queue42', profileId: 'profile42', profileRevision: 1,
    profile: { ...fixture.response.profileSnapshot, callSessionId: callId } }) };
  const o = new NativeCallOrchestrator({ ...h, native, monitor, instanceId: 'op-test', startupTimeoutMs: 30000, available: () => true });
  const request = { officePulseInstanceId: 'op-test', asteriskLinkedId: 'linked', didE164: fixture.response.profileSnapshot.didE164 };
  const result = await o.bootstrapInboundCall(request);
  assert.equal(result.disposition, 'SCREEN'); assert.deepEqual(order, ['room', 'monitor', 'dispatch']);
  assert.deepEqual(Object.keys(metadata), ['callSessionId','bootstrapToken']); assert.equal(metadata.bootstrapToken.length, 43);
  assert.notEqual(metadata.bootstrapToken, result.routeToken); assert.equal(result.sipDestination, result.roomName);
  assert.ok(!JSON.stringify([...h.store.rows.values()]).includes(metadata.bootstrapToken));
  assert.equal((await o.bootstrapInboundCall(request)).disposition, 'FALLBACK'); assert.equal(order.length, 3);
});
class FakeRoom extends EventEmitter { async connect() {} async disconnect() {} }
test('ready is verified separately from join; transcript persistence is metadata only; loss falls back', async t => {
  const h = setup(); await h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request);
  const room = new FakeRoom(); let fallback = 0;
  const monitor = new AgentMonitor({ authority: h.authority, url: 'wss://unused', apiKey: 'test', apiSecret: 'test', fallback: async () => { fallback++; }, roomFactory: () => room as unknown as Room });
  t.after(() => monitor.close()); await monitor.start(id, Date.now() + 30000);
  await monitor.ready(id, Buffer.from(JSON.stringify(fixture.ready)), 'attacker', 'PA_agent'); assert.equal(h.store.rows.get(id)?.status, 'admitted');
  await monitor.ready(id, Buffer.from(JSON.stringify(fixture.ready)), 'agent-1', 'PA_agent'); assert.equal(h.store.rows.get(id)?.status, 'ready');
  await monitor.conversation(id, Buffer.from(JSON.stringify({ type: 'transcript', callId: id, speaker: 'caller', text: 'private words' })), 'PA_agent');
  assert.equal(h.runtime.events.get(id)?.[0]?.eventType, 'conversation-observed'); assert.ok(!JSON.stringify(h.runtime.events.get(id)).includes('private words'));
  room.emit('disconnected'); await new Promise(r => setTimeout(r, 10)); assert.equal(fallback, 1); assert.equal(h.store.rows.get(id)?.status, 'fallback');
});
test('watchdog and storage failure both preserve telephony fallback', async t => {
  for (const storageFailure of [false, true]) {
    const h = setup(); const room = new FakeRoom(); let fallback = 0;
    const monitor = new AgentMonitor({ authority: h.authority, url: 'wss://unused', apiKey: 'x', apiSecret: 'x', fallback: async () => { fallback++; }, roomFactory: () => room as unknown as Room });
    t.after(() => monitor.close()); await monitor.start(id, Date.now() - 1);
    if (storageFailure) h.store.transition = async () => { throw new Error('storage unavailable'); };
    await new Promise(r => setTimeout(r, 1100)); assert.equal(fallback, 1);
  }
});
test('ARI fallback redirects caller, clears only AI legs, and preserves human bridges', async () => {
  const ari = new FakeAri(); const events = new FakeEventSink();
  const manager = new TakeoverManager({ ari, events, logger: captureLogger().logger, drainTimeoutMs: 100, defaultRingTimeoutSeconds: 10, defaultMohClass: 'default', livekitTrunkEndpoint: 'livekit',
    nativeAdmission: { validate: async () => true, failed: async () => {}, ended: async () => {}, fallbackTarget: async () => ({ context: 'aida-agent-queue-fallback', exten: 'queue42' }) } });
  const caller = ari.makeChannel('caller'); ari.setVar('caller', 'AIDA_SIP_DESTINATION', `aida-${id}`); ari.setVar('caller', 'AIDA_ROUTE_TOKEN', credential());
  ari.emitStasisStart(['screen', id], caller); await new Promise(r => setTimeout(r, 10));
  assert.match(ari.originates[0]!.endpoint, /Local\/aida-.*@aida-agent-sip\/n/);
  await manager.fallback(id); assert.deepEqual(ari.continued, [{ channelId: 'caller', context: 'aida-agent-queue-fallback', exten: 'queue42' }]);
  assert.ok(!ari.hangups.some(h => h.channelId === 'caller')); assert.equal(events.types().at(-1), 'pbx-fallback');
  const session = manager.getSession(id)! as { humanAnswered: boolean; fellBack: boolean }; session.humanAnswered = true; session.fellBack = false;
  await manager.fallback(id); assert.equal(ari.continued.length, 1);
});
test('admission is opt-in and rejects incomplete/ambiguous configuration', () => {
  assert.equal(agentConfig({}), undefined);
  assert.throws(() => agentConfig({ NATIVE_ADMISSION_ENABLED: 'true' }));
  const env = { FASTAGI_BIND: '127.0.0.1', NATIVE_ADMISSION_ENABLED: 'true', VOICE_ENABLED: 'true', PBX_INVENTORY_ENABLED: 'true', LIVEKIT_AGENT_NAME: 'aida-prime-bootstrap-dev', LIVEKIT_TRUNK_ENDPOINT: 'livekit', ID_BASE_URL: 'https://id.example.test' };
  assert.equal(agentConfig(env)?.startupTimeoutMs, 30000);
  assert.throws(() => agentConfig({ ...env, LIVEKIT_AGENT_NAME: 'aida-prime' }));
  assert.throws(() => agentConfig({ ...env, ID_BASE_URL: 'https://id.example.test/path' }));
});
test('caller completion is tracked even if bootstrap fails before Stasis', async () => {
  const ari = new FakeAri(); const events = new FakeEventSink(); let completed = false;
  const manager = new TakeoverManager({ ari, events, logger: captureLogger().logger, drainTimeoutMs: 100, defaultRingTimeoutSeconds: 10, defaultMohClass: 'default',
    nativeAdmission: { validate: async () => false, failed: async () => {}, ended: async () => { completed = true; }, fallbackTarget: async () => undefined } });
  const caller = ari.makeChannel('pre-stasis-caller'); manager.observeCaller(id, caller.id);
  await manager.fallback(id); assert.equal(ari.continued.length, 0);
  ari.emitDestroyed(caller, 16); await new Promise(r => setTimeout(r, 10));
  assert.equal(completed, true); assert.ok(events.types().includes('hangup')); assert.equal(manager.sessionCount(), 0);
});
test('fallback racing a human answer cannot break an established human bridge', async () => {
  const ari = new FakeAri(); const events = new FakeEventSink();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new TakeoverManager({ ari, events, logger: captureLogger().logger, drainTimeoutMs: 100, defaultRingTimeoutSeconds: 10, defaultMohClass: 'default', livekitTrunkEndpoint: 'livekit',
    nativeAdmission: { validate: async () => true, failed: async () => {}, ended: async () => {}, fallbackTarget: async () => { await gate; return { context: 'aida-agent-queue-fallback', exten: 'queue42' }; } } });
  const caller = ari.makeChannel('race-caller'); ari.setVar(caller.id, 'AIDA_SIP_DESTINATION', `aida-${id}`); ari.setVar(caller.id, 'AIDA_ROUTE_TOKEN', credential());
  ari.emitStasisStart(['screen', id], caller); await new Promise(r => setTimeout(r, 10));
  const redirect = manager.fallback(id); const human = ari.makeChannel('race-human'); ari.emitStasisStart(['human', id], human);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(manager.getSession(id)?.humanAnswered, false); assert.ok(ari.hangups.some(h => h.channelId === human.id));
  release(); await redirect; assert.equal(ari.continued.length, 1);
});
