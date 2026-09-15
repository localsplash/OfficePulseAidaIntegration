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
import { NativeAdmissionAuthority, identityTenantEnabled } from '../src/agent/native.js';
import { AgentConfigCache, nocoProfileSource, type CachedProfile } from '../src/agent/profileCache.js';
import { agentConfig } from '../src/agent/config.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';
import { FakeAri, FakeEventSink } from './helpers/fakeAri.js';
import { TakeoverManager } from '../src/takeover/takeoverManager.js';
import { captureLogger } from './helpers/capture.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';

class FakeRoom extends EventEmitter { async connect() {} async disconnect() {} }
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
const DID: string = fixture.response.profileSnapshot.didE164;
const ownershipQuery = async (sql: string) => sql.includes('SELECT priority')
  ? didDialplanRows(DID, { queue: 'queue42', ringsBeforeAi: 3 }) as unknown as Record<string, unknown>[]
  : sql.includes('SELECT name') ? [{ name: 'queue42' }] : [];
const SCOPES = new Map([['42', { contexts: ['tenant42'], queueNames: ['queue42'], didContext: 'ingress' }]]);
const CACHED: CachedProfile = { profileId: 'profile42', profileRevision: 1, businessName: 'Office', prompt: 'Help callers' };

test('native authority uses Asterisk route ownership and the cached profile, never a call-path config read', async () => {
  const cached = new Map([['42', { ...CACHED }]]);
  const authority = new NativeAdmissionAuthority({ scopes: SCOPES, query: ownershipQuery, profiles: { get: tenant => cached.get(tenant) } });
  const request = { didE164: DID, ingressContext: 'ingress', fallbackQueue: 'queue42' };
  const resolved = await authority.resolve(request, id);
  assert.equal(resolved?.tenantId, '42'); assert.equal(resolved?.profileId, 'profile42'); assert.equal(resolved?.queue, 'queue42');
  assert.equal(resolved?.profile.businessName, 'Office'); assert.equal(resolved?.profile.didE164, DID);
  assert.equal(await authority.resolve({ ...request, fallbackQueue: 'other' }, id), undefined);
  assert.equal(await authority.resolve({ ...request, ingressContext: 'elsewhere' }, id), undefined);
  assert.equal(await authority.authorized('42', DID, 'queue42', 'profile42'), true);
  assert.equal(await authority.authorized('42', DID, 'queue42', 'replaced-profile'), false);
  assert.equal(await authority.authorized('42', DID, 'other', 'profile42'), false);
  // A revocation observed by the last background refresh still fails closed.
  cached.delete('42');
  assert.equal(await authority.resolve(request, id), undefined);
  assert.equal(await authority.authorized('42', DID, 'queue42', 'profile42'), false);
});
test('once configuration is cached, admission, credential consumption and monitoring issue no Identity/NocoDB request', async t => {
  const noco = new FakeNocoApi();
  noco.seed('aida_tbl_AssistantProfile', [{ id: 'profile42', revision: 1, iTenantId: 42, enabled: true, business_name: 'Office', prompt: 'Help callers' }]);
  const cache = new AgentConfigCache({ tenantIds: ['42'], source: nocoProfileSource(noco, new Map()) });
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.status().complete, true);

  // Both configuration services now fail; a call in flight must not notice.
  const reads = noco.calls.length;
  noco.failOn = '*';
  const attempted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => { attempted.push(String(input)); throw new Error('configuration service unavailable'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const native = new NativeAdmissionAuthority({ scopes: SCOPES, query: ownershipQuery, profiles: cache });
  const runtime = new FakeRuntimeStore(); const store = new MemoryAdmissions();
  const participants: Participant[] = [];
  let dispatched: { callSessionId: string; bootstrapToken: string } | undefined;
  const livekit: AgentLiveKit = { listParticipants: async () => participants, dispatchIdentity: async () => 'agent-1',
    dispatchAgent: async (_room, metadata) => { dispatched = metadata; return 'dispatch42'; }, createRoom: async () => {} };
  const authority = new BootstrapAuthority({ store, runtime, native, livekit, routeAttribute: 'sip.aidaRouteToken', instanceId: 'op-test' });
  const orchestrator = new NativeCallOrchestrator({ runtime, store, native, livekit,
    monitor: { start: async () => {}, stop: async () => {}, close: async () => {} },
    instanceId: 'op-test', startupTimeoutMs: 30000, available: () => true });

  const decision = await orchestrator.bootstrapInboundCall({ officePulseInstanceId: 'op-test', asteriskLinkedId: 'linked-19',
    asteriskChannelId: 'ch-19', callerNumber: '15551230001', didE164: DID, ingressContext: 'ingress', fallbackQueue: 'queue42' });
  assert.equal(decision.disposition, 'SCREEN');
  const call = decision.callSessionId!;
  // Asterisk's context, DID and CID all survive into the durable call record.
  const record = await runtime.getCallSession(call);
  assert.equal(record?.didE164, DID); assert.equal(record?.callerNumber, '15551230001');
  assert.equal(record?.destinationId, 'queue42'); assert.equal(record?.config.profileId, 'profile42');
  assert.deepEqual(runtime.events.get(call)?.[0], { eventType: 'call-arrived', payload: { ingressContext: 'ingress', queue: 'queue42', callerIdPresent: true },
    sequenceNumber: 1, createdAt: runtime.events.get(call)![0]!.createdAt });

  participants.push({ sid: 'PA_sip', identity: 'sip-caller', kind: 3, attributes: { 'sip.aidaRouteToken': decision.routeToken! } },
    { sid: 'PA_agent', identity: 'agent-1', kind: 4 });
  const admitted = await authority.authorize(call, dispatched!.bootstrapToken, { roomName: decision.roomName!,
    sipParticipantIdentity: 'sip-caller', sipParticipantSid: 'PA_sip', routeToken: decision.routeToken! });
  assert.equal(admitted.profileSnapshot.prompt, 'Help callers');
  assert.equal(admitted.profileSnapshot.callSessionId, call);

  const room = new FakeRoom();
  const monitor = new AgentMonitor({ authority, url: 'wss://unused', apiKey: 'x', apiSecret: 'x', fallback: async () => {}, roomFactory: () => room as unknown as Room });
  t.after(() => monitor.close());
  await monitor.start(call, Date.now() + 30000);
  await monitor.ready(call, Buffer.from(JSON.stringify({ type: 'aida.event.agent_ready', schemaVersion: 1,
    callSessionId: call, agentIdentity: 'agent-1', agentParticipantSid: 'PA_agent' })), 'agent-1', 'PA_agent');
  assert.equal(store.rows.get(call)?.status, 'ready');
  await new Promise(r => setTimeout(r, 1100)); // at least one watchdog authorization pass
  assert.equal(store.rows.get(call)?.status, 'ready');
  assert.deepEqual(attempted, [], 'no HTTP request may leave the call path');
  assert.equal(noco.calls.length, reads, 'PlatformConfig is read only by startup and background refresh');
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
  assert.equal(agentConfig({ ...env, OPS_IDENTITY_CLIENT_SECRET: 'shared-secret' })?.identitySecret, 'shared-secret');
  assert.equal(agentConfig({ ...env, ID_CLIENT_SECRET: 'native-secret', OPS_IDENTITY_CLIENT_SECRET: 'shared-secret' })?.identitySecret, 'native-secret');
  assert.equal(agentConfig(env)?.configRefreshMs, 300000);
  assert.equal(agentConfig(env)?.identityTenantCheck, false);
  assert.equal(agentConfig({ ...env, AGENT_CONFIG_REFRESH_SECONDS: '60', AGENT_IDENTITY_TENANT_CHECK: 'true' })?.configRefreshMs, 60000);
  assert.equal(agentConfig({ ...env, AGENT_IDENTITY_TENANT_CHECK: 'true' })?.identityTenantCheck, true);
  assert.throws(() => agentConfig({ ...env, AGENT_CONFIG_REFRESH_SECONDS: '5' }));
  assert.throws(() => agentConfig({ ...env, AGENT_IDENTITY_TENANT_CHECK: 'yes' }));
  assert.throws(() => agentConfig({ ...env, LIVEKIT_AGENT_NAME: 'aida-prime' }));
  assert.throws(() => agentConfig({ ...env, ID_BASE_URL: 'https://id.example.test/path' }));
});
test('the background Identity check authenticates and logs rejections without the credential', async () => {
  const seen: RequestInit[] = [];
  const messages: unknown[] = [];
  const enabled = identityTenantEnabled('https://id.example.test', {
    clientSecret: 'do-not-log',
    fetchImpl: async (_url, init) => { seen.push(init ?? {}); return new Response('{"error":"Forbidden"}', { status: 403 }); },
    logger: { warn: (message, fields) => { messages.push({ message, fields }); } },
  });
  await assert.rejects(() => enabled('42'), /Identity runtime unavailable/);
  assert.equal((seen[0]!.headers as Record<string, string>)['X-Id-Client-Secret'], 'do-not-log');
  assert.deepEqual(messages, [{ message: 'Identity tenant validation request failed', fields: { tenantId: '42', status: 403 } }]);
  assert.doesNotMatch(JSON.stringify(messages), /do-not-log|Forbidden/);
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
