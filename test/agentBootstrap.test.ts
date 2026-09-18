import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import mysql from 'mysql2/promise';
import { DataPacketKind, RoomEvent, type Room } from '@livekit/rtc-node';
import { credential, digest, profileSnapshot, parseBinding, CredentialRejected, type DispatchMetadata, type ProfileSnapshot } from '../src/agent/contract.js';
import { MysqlAdmissionStore, type Admission, type AdmissionStore } from '../src/agent/store.js';
import { BootstrapAuthority, type AgentLiveKit, type Participant } from '../src/agent/authority.js';
import { NativeCallOrchestrator } from '../src/agent/orchestrator.js';
import { AgentMonitor } from '../src/agent/monitor.js';
import { NativeAdmissionAuthority, identityTenantEnabled, type CallScope } from '../src/agent/native.js';
import { AgentConfigCache, nocoProfileSource, type CachedProfile } from '../src/agent/profileCache.js';
import { agentConfig } from '../src/agent/config.js';
import { ConfigError } from '../src/errors.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';
import { FakeAri, FakeEventSink } from './helpers/fakeAri.js';
import { TakeoverManager } from '../src/takeover/takeoverManager.js';
import { captureLogger } from './helpers/capture.js';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';

class FakeRoom extends EventEmitter { async connect() {} async disconnect() {} }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bootstrap-v2.json', import.meta.url), 'utf8'));
const id: string = fixture.dispatch.callSessionId;
const INSTANCE: string = fixture.dispatch.pbxInstanceId;
const CONTEXT: string = fixture.dispatch.context;
const DID: string = fixture.response.profileSnapshot.didE164;
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
  runtime.seedSession({ id, roomName: `aida-${id}`, tenantId: '42', didE164: DID, officePulseInstanceId: INSTANCE, pbxContext: CONTEXT, ingressContext: 'ingress',
    asteriskLinkedId: 'linked', destinationId: 'queue42', config: { profileId: 'profile42' }, disposition: 'SCREEN' });
  const store = new MemoryAdmissions();
  const a: Admission = { callId: id, roomName: `aida-${id}`, tenantId: '42', instanceId: INSTANCE, pbxInstanceId: INSTANCE, context: CONTEXT, ingressContext: 'ingress', linkedId: 'linked',
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
  const authority = new BootstrapAuthority({ store, runtime, native, livekit, routeAttribute: 'sip.aidaRouteToken', instanceId: INSTANCE });
  return { runtime, store, a, participants, livekit, native, authority };
}
test('Agent shared fixture produces its exact allowlisted v2 response and consumes once', async () => {
  const h = setup();
  assert.deepEqual(await h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request), fixture.response);
  await assert.rejects(h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request), CredentialRejected);
  assert.equal(h.store.rows.get(id)?.agentSid, 'PA_agent');
});
test('credential, scope, tenant, room, dispatch and SIP mismatches never consume either credential', async t => {
  const cases: Record<string, (h: ReturnType<typeof setup>) => void> = {
    expired: h => { h.a.expiresAt = Date.now() - 1; },
    bootstrap: h => { h.a.bootstrapHash = digest(credential()); },
    route: h => { h.a.routeHash = digest(credential()); },
    room: h => { h.a.roomName = 'wrong'; },
    instance: h => { h.a.instanceId = 'wrong'; },
    pbxInstance: h => { h.a.pbxInstanceId = 'other-pbx'; },
    context: h => { h.a.context = 'other-office'; },
    ingress: h => { h.a.ingressContext = 'elsewhere'; },
    callContext: h => { h.runtime.sessions.get(id)!.pbxContext = 'other-office'; },
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
test('re-derived ownership is checked for the pinned scope, never a request value', async () => {
  const h = setup(); const seen: unknown[] = [];
  h.native.authorized = async (...args: unknown[]) => { seen.push(args); return true; };
  await h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request);
  assert.deepEqual(seen, [[{ pbxInstanceId: INSTANCE, context: CONTEXT, ingressContext: 'ingress' }, DID, 'queue42', 'profile42']]);
});
test('strict profile and request validation reject v1, missing scope, extras, duplicates, null and unsafe tenant IDs', () => {
  const snapshot = fixture.response.profileSnapshot;
  const { pbxInstanceId: _instance, ...noInstance } = snapshot; const { context: _context, ...noContext } = snapshot; const { tenantId: _tenant, ...noTenant } = snapshot;
  for (const profile of [{ ...snapshot, schemaVersion: 1 }, noInstance, noContext, { ...snapshot, context: 'bad ctx' }, { ...snapshot, pbxInstanceId: 'x'.repeat(81) },
    { ...snapshot, tenantId: 42 }, { ...snapshot, model: 'bad' }, { ...snapshot, prompt: null }, { ...snapshot, tenantId: '9007199254740992' }, { ...snapshot, locale: 'fr-FR' },
    { schemaVersion: 1, callSessionId: id, tenantId: '42', businessName: 'v1', prompt: 'no scope', locale: 'en-US', didE164: DID }]) assert.throws(() => profileSnapshot(profile), JSON.stringify(profile));
  // tenantId is optional customer identity; the routing scope is not.
  assert.deepEqual(profileSnapshot(noTenant), noTenant);
  assert.deepEqual(profileSnapshot(snapshot), snapshot);
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
test('consume() pins the routing scope on snapshot, admission and call record and rejects a stored v1 snapshot without writing', async t => {
  const h = setup();
  const binding = { bootstrapHash: h.a.bootstrapHash, routeHash: h.a.routeHash, sipIdentity: 'sip-caller', sipSid: 'PA_sip', agentIdentity: 'agent-1', agentSid: 'PA_agent' };
  const call = { id, tenant_id: '42', room_name: `aida-${id}`, officepulse_instance_id: INSTANCE, pbx_context: CONTEXT, ingress_context: 'ingress', asterisk_linked_id: 'linked',
    disposition: 'SCREEN', state: 'screening', ended_at: null, did_e164: DID };
  let rows: { call: Record<string, unknown>; admission: Admission }; const writes: string[] = [];
  const conn = {
    beginTransaction: async () => {}, commit: async () => { writes.push('commit'); }, rollback: async () => { writes.push('rollback'); }, release: () => {},
    execute: async (sql: string) => {
      if (sql.startsWith('SELECT * FROM call_session')) return [[rows.call], []];
      if (sql.startsWith('SELECT *, UNIX_TIMESTAMP')) return [[{ call_id: id, status: 'dispatched', data: JSON.stringify(rows.admission), dispatch_id: 'dispatch42', now_ms: Date.now() }], []];
      writes.push(sql.split(' ')[0]!); return [{ affectedRows: 1 }, []];
    },
  };
  t.mock.method(mysql, 'createPool', () => ({ getConnection: async () => conn, end: async () => {} }));
  const store = new MysqlAdmissionStore({ host: 'unused', port: 3306, user: 'unused', password: 'unused', database: 'aidacalls_db' });
  const run = async (callRow: Record<string, unknown>, stored: Admission, expected = stored) => {
    rows = { call: callRow, admission: stored }; writes.length = 0;
    try { return { profile: await store.consume(expected, binding), writes: [...writes] }; } catch (error) { return { error, writes: [...writes] }; }
  };
  const ok = await run(call, h.a);
  assert.deepEqual(ok.profile, h.a.profile); assert.deepEqual(ok.writes, ['UPDATE', 'UPDATE', 'INSERT', 'commit']);
  const v1 = { schemaVersion: 1, callSessionId: id, tenantId: '42', businessName: 'Example Office', prompt: 'Ask how we can help.', locale: 'en-US', didE164: DID } as unknown as ProfileSnapshot;
  const cases: [string, Record<string, unknown>, Admission, Admission?][] = [
    ['call context', { ...call, pbx_context: 'other-office' }, h.a],
    ['call context absent', { ...call, pbx_context: null }, h.a],
    ['call instance', { ...call, officepulse_instance_id: 'other-pbx' }, h.a],
    ['admission context', call, { ...h.a, context: 'other-office' }],
    ['expected context', call, h.a, { ...h.a, context: 'other-office' }],
    ['expected instance', call, h.a, { ...h.a, pbxInstanceId: 'other-pbx' }],
    ['snapshot context', call, { ...h.a, profile: { ...h.a.profile, context: 'other-office' } }],
    ['snapshot instance', call, { ...h.a, profile: { ...h.a.profile, pbxInstanceId: 'other-pbx' } }],
    ['stored v1 snapshot', call, { ...h.a, profile: v1 }],
  ];
  for (const [name, callRow, stored, expected] of cases) {
    const result = await run(callRow, stored, expected);
    assert.ok(result.error instanceof CredentialRejected, name); assert.deepEqual(result.writes, ['rollback'], name);
  }
});
const ownershipQuery = async (sql: string) => sql.includes('SELECT priority')
  ? didDialplanRows(DID, { queue: 'queue42', ringsBeforeAi: 3 }) as unknown as Record<string, unknown>[]
  : sql.includes('SELECT context') ? [{ context: 'tenant42' }] : sql.includes('SELECT name') ? [{ name: 'queue42' }] : [];
const CACHED: CachedProfile = { tenantId: '42', pbxInstanceId: 'op-test', context: 'tenant42', did: '', profileId: 'profile42', profileRevision: 1, businessName: 'Office', prompt: 'Help callers' };
const lookup = (cached: Map<string, CachedProfile>) => ({ get: (context: string, did: string) => cached.get(`${context}\0${did}`) });
const SCOPE: CallScope = { pbxInstanceId: 'op-test', context: 'tenant42', ingressContext: 'ingress' };

test('native authority derives the owning context from Asterisk rows and the cached assignment, never a call-path config read', async () => {
  const cached = new Map([['tenant42\0', { ...CACHED }]]);
  const seen: string[] = [];
  const authority = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: async (sql, values) => { seen.push(sql); if (sql.includes('SELECT context')) assert.match(sql, /BINARY exten=\? AND priority=1 AND app='NoOp' AND BINARY appdata=\? LIMIT 2$/); if (sql.includes('SELECT priority')) assert.deepEqual(values, ['ingress', DID]); return ownershipQuery(sql); }, profiles: lookup(cached) });
  const request = { didE164: DID, ingressContext: 'ingress', fallbackQueue: 'queue42' };
  const resolved = await authority.resolve(request, id);
  assert.equal(resolved?.pbxInstanceId, 'op-test'); assert.equal(resolved?.context, 'tenant42'); assert.equal(resolved?.tenantId, '42');
  assert.equal(resolved?.profileId, 'profile42'); assert.equal(resolved?.queue, 'queue42');
  assert.equal(resolved?.profile.businessName, 'Office'); assert.equal(resolved?.profile.didE164, DID); assert.equal(resolved?.profile.context, 'tenant42'); assert.equal(resolved?.profile.schemaVersion, 2);
  assert.deepEqual(seen.map(sql => sql.split(' ')[1]), ['priority,app,appdata', 'context', 'name']);
  assert.equal(await authority.resolve({ ...request, fallbackQueue: 'other' }, id), undefined);
  assert.equal(await authority.resolve({ ...request, ingressContext: 'bad ctx' }, id), undefined);
  assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'profile42'), true);
  assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'replaced-profile'), false);
  assert.equal(await authority.authorized(SCOPE, DID, 'other', 'profile42'), false);
  assert.equal(await authority.authorized({ ...SCOPE, pbxInstanceId: 'other-pbx' }, DID, 'queue42', 'profile42'), false);
  assert.equal(await authority.authorized({ ...SCOPE, context: 'tenant43' }, DID, 'queue42', 'profile42'), false);
  // A DID-specific assignment takes precedence over the context default.
  cached.set(`tenant42\0${DID}`, { ...CACHED, did: DID, profileId: 'profile-did' });
  assert.equal((await authority.resolve(request, id))?.profileId, 'profile-did');
  assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'profile42'), false);
  assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'profile-did'), true);
  cached.delete(`tenant42\0${DID}`);
  // A revocation observed by the last background refresh still fails closed.
  cached.delete('tenant42\0');
  assert.equal(await authority.resolve(request, id), undefined);
  assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'profile42'), false);
});
test('an absent, foreign or ambiguous queue marker, a missing queue row, or a route from another ingress context never admits a call', async () => {
  const profiles = lookup(new Map([['tenant42\0', { ...CACHED }]]));
  const request = { didE164: DID, ingressContext: 'ingress', fallbackQueue: 'queue42' };
  for (const markers of [[], [{ context: 'tenant42' }, { context: 'tenant43' }]]) {
    const authority = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: async sql => sql.includes('SELECT context') ? markers : ownershipQuery(sql), profiles });
    assert.equal(await authority.resolve(request, id), undefined, JSON.stringify(markers));
    assert.equal(await authority.authorized(SCOPE, DID, 'queue42', 'profile42'), false, JSON.stringify(markers));
  }
  // The marker names a context with no assignment: the caller stays on the PBX queue.
  const foreign = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: async sql => sql.includes('SELECT context') ? [{ context: 'tenant43' }] : ownershipQuery(sql), profiles });
  assert.equal(await foreign.resolve(request, id), undefined);
  assert.equal(await foreign.authorized(SCOPE, DID, 'queue42', 'profile42'), false);
  const missing = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: async sql => sql.includes('SELECT name') ? [] : ownershipQuery(sql), profiles });
  assert.equal(await missing.resolve(request, id), undefined);
  // The route is looked up in the call's pinned ingress context; another context's rows do not count.
  const elsewhere = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: async (sql, values) => sql.includes('SELECT priority') && values[0] !== 'ingress' ? [] : ownershipQuery(sql), profiles });
  assert.equal(await elsewhere.resolve({ ...request, ingressContext: 'elsewhere' }, id), undefined);
  assert.equal(await elsewhere.authorized({ ...SCOPE, ingressContext: 'elsewhere' }, DID, 'queue42', 'profile42'), false);
  assert.equal(await elsewhere.authorized(SCOPE, DID, 'queue42', 'profile42'), true);
});
test('once configuration is cached, admission, credential consumption and monitoring issue no Identity/NocoDB request', async t => {
  const noco = new FakeNocoApi();
  noco.seed('aida_tbl_ProfileAssignment', [{ id: 'a1', iTenantId: 42, pbx_instance_id: 'op-test', context: 'tenant42', did: null, profile_id: 'profile42', enabled: 1 }]);
  noco.seed('aida_tbl_AssistantProfile', [{ id: 'profile42', revision: 1, iTenantId: 42, enabled: true, business_name: 'Office', prompt: 'Help callers' }]);
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, 'op-test') });
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.status().complete, true);

  // Both configuration services now fail; a call in flight must not notice.
  const reads = noco.calls.length;
  noco.failOn = '*';
  const attempted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => { attempted.push(String(input)); throw new Error('configuration service unavailable'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const native = new NativeAdmissionAuthority({ pbxInstanceId: 'op-test', query: ownershipQuery, profiles: cache });
  const runtime = new FakeRuntimeStore(); const store = new MemoryAdmissions();
  const participants: Participant[] = [];
  let dispatched: DispatchMetadata | undefined;
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
  // Asterisk's context, DID and CID all survive into the durable call record, with the routing scope pinned.
  const record = await runtime.getCallSession(call);
  assert.equal(record?.didE164, DID); assert.equal(record?.callerNumber, '15551230001');
  assert.equal(record?.destinationId, 'queue42'); assert.equal(record?.config.profileId, 'profile42');
  assert.equal(record?.pbxContext, 'tenant42'); assert.equal(record?.ingressContext, 'ingress'); assert.equal(record?.tenantId, '42');
  assert.deepEqual(runtime.events.get(call)?.[0], { eventType: 'call-arrived', payload: { ingressContext: 'ingress', context: 'tenant42', queue: 'queue42', callerIdPresent: true },
    sequenceNumber: 1, createdAt: runtime.events.get(call)![0]!.createdAt });
  assert.deepEqual(dispatched, { callSessionId: call, bootstrapToken: dispatched!.bootstrapToken, pbxInstanceId: 'op-test', context: 'tenant42' });
  const admission = store.rows.get(call)!;
  assert.equal(admission.pbxInstanceId, 'op-test'); assert.equal(admission.context, 'tenant42'); assert.equal(admission.ingressContext, 'ingress'); assert.equal(admission.tenantId, '42');

  participants.push({ sid: 'PA_sip', identity: 'sip-caller', kind: 3, attributes: { 'sip.aidaRouteToken': decision.routeToken! } },
    { sid: 'PA_agent', identity: 'agent-1', kind: 4 });
  const admitted = await authority.authorize(call, dispatched!.bootstrapToken, { roomName: decision.roomName!,
    sipParticipantIdentity: 'sip-caller', sipParticipantSid: 'PA_sip', routeToken: decision.routeToken! });
  assert.equal(admitted.profileSnapshot.prompt, 'Help callers');
  assert.equal(admitted.profileSnapshot.callSessionId, call);
  assert.equal(admitted.profileSnapshot.pbxInstanceId, 'op-test'); assert.equal(admitted.profileSnapshot.context, 'tenant42'); assert.equal(admitted.profileSnapshot.tenantId, '42');

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
test('dispatch carries exactly the v2 credential and scope, SIP routing returns before agent readiness, and a foreign instance falls back', async () => {
  const h = setup(); h.runtime.sessions.clear(); h.store.rows.clear(); const order: string[] = []; let metadata: any;
  h.livekit.createRoom = async () => { order.push('room'); };
  h.livekit.dispatchAgent = async (_room, m) => { metadata = m; order.push('dispatch'); return 'dispatch42'; };
  const monitor = { start: async () => { order.push('monitor'); }, stop: async () => {}, close: async () => {} };
  const resolution = (callId: string, pbxInstanceId = INSTANCE) => ({ pbxInstanceId, context: CONTEXT, tenantId: '42', queue: 'queue42', profileId: 'profile42', profileRevision: 1,
    profile: { ...fixture.response.profileSnapshot, callSessionId: callId } });
  const native = { ...h.native, resolve: async (_: unknown, callId: string) => resolution(callId) };
  const o = new NativeCallOrchestrator({ ...h, native, monitor, instanceId: INSTANCE, startupTimeoutMs: 30000, available: () => true });
  const request = { officePulseInstanceId: INSTANCE, asteriskLinkedId: 'linked', didE164: DID, ingressContext: 'ingress', fallbackQueue: 'queue42' };
  const result = await o.bootstrapInboundCall(request);
  assert.equal(result.disposition, 'SCREEN'); assert.deepEqual(order, ['room', 'monitor', 'dispatch']);
  assert.deepEqual(Object.keys(metadata), ['callSessionId','bootstrapToken','pbxInstanceId','context']); assert.equal(metadata.bootstrapToken.length, 43);
  assert.equal(metadata.pbxInstanceId, INSTANCE); assert.equal(metadata.context, CONTEXT);
  assert.notEqual(metadata.bootstrapToken, result.routeToken); assert.equal(result.sipDestination, result.roomName);
  assert.ok(!JSON.stringify([...h.store.rows.values()]).includes(metadata.bootstrapToken));
  assert.equal((await o.bootstrapInboundCall(request)).disposition, 'FALLBACK'); assert.equal(order.length, 3);
  // A resolution naming another PBX instance is never admitted here.
  h.runtime.sessions.clear(); h.store.rows.clear();
  const foreign = new NativeCallOrchestrator({ ...h, native: { ...h.native, resolve: async (_: unknown, callId: string) => resolution(callId, 'other-pbx') }, monitor, instanceId: INSTANCE, startupTimeoutMs: 30000, available: () => true });
  assert.equal((await foreign.bootstrapInboundCall({ ...request, asteriskLinkedId: 'linked-2' })).disposition, 'FALLBACK'); assert.equal(order.length, 3);
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
test('a failing telephony fallback still releases the room and its watchdog timer', async t => {
  // A leaked monitor keeps polling LiveKit every second for the life of the
  // process, which starves later calls' room connections until a restart.
  const h = setup(); const room = new FakeRoom(); let attempts = 0;
  const monitor = new AgentMonitor({ authority: h.authority, url: 'wss://unused', apiKey: 'x', apiSecret: 'x',
    fallback: async () => { attempts++; throw new Error('ARI channel is gone'); }, roomFactory: () => room as unknown as Room });
  t.after(() => monitor.close());
  await monitor.start(id, Date.now() - 1);
  assert.equal(monitor.isMonitoring(id), true);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(attempts, 1);
  assert.equal(monitor.isMonitoring(id), false, 'the room must be released even though fallback threw');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(attempts, 1, 'the watchdog timer must not keep firing after release');
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
test('admission is opt-in, rejects incomplete/ambiguous configuration and refuses the retired profile map', () => {
  assert.equal(agentConfig({}), undefined);
  assert.throws(() => agentConfig({ NATIVE_ADMISSION_ENABLED: 'true' }));
  const env = { FASTAGI_BIND: '127.0.0.1', NATIVE_ADMISSION_ENABLED: 'true', VOICE_ENABLED: 'true', PBX_INVENTORY_ENABLED: 'true', LIVEKIT_AGENT_NAME: 'aida-prime-bootstrap-dev', LIVEKIT_TRUNK_ENDPOINT: 'livekit', ID_BASE_URL: 'https://id.example.test' };
  assert.equal(agentConfig(env)?.startupTimeoutMs, 30000);
  assert.equal('profileIds' in agentConfig(env)!, false);
  const retired = (error: ConfigError) => error instanceof ConfigError && error.problems.length === 1 &&
    error.problems[0] === 'AGENT_PROFILE_IDS_JSON is retired: assistant profiles are assigned per context/DID in PlatformConfig aida_tbl_ProfileAssignment through AidaAdmin. See docs/AGENT_BOOTSTRAP.md';
  assert.throws(() => agentConfig({ ...env, AGENT_PROFILE_IDS_JSON: '{"42":"example-profile-id"}' }), retired);
  assert.throws(() => agentConfig({ AGENT_PROFILE_IDS_JSON: '{}' }), retired, 'refused even while admission is disabled');
  assert.equal(agentConfig({ AGENT_PROFILE_IDS_JSON: ' ' }), undefined);
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

test('RTC data callback accepts reliable ready and transcripts and ignores lossy packets', async t => {
  const h = setup(); await h.authority.authorize(id, fixture.dispatch.bootstrapToken, fixture.request);
  const room = new FakeRoom(); const observations: Array<Record<string, unknown>> = [];
  const monitor = new AgentMonitor({ authority: h.authority, url: 'wss://unused', apiKey: 'x', apiSecret: 'x',
    fallback: async () => {}, roomFactory: () => room as unknown as Room,
    logger: { info: (_msg, fields) => { observations.push(fields ?? {}); }, warn: () => {} } });
  t.after(() => monitor.close()); await monitor.start(id, Date.now() + 30000);
  const sender = { identity: 'agent-1', sid: 'PA_agent' };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const ready = Buffer.from(JSON.stringify(fixture.ready));
  for (const kind of [DataPacketKind.KIND_LOSSY, undefined]) {
    room.emit(RoomEvent.DataReceived, ready, sender, kind, 'aida.event.agent_ready');
    await flush(); assert.equal(h.store.rows.get(id)?.status, 'admitted');
  }
  room.emit(RoomEvent.DataReceived, ready, sender, DataPacketKind.KIND_RELIABLE, 'aida.event.agent_ready');
  await flush(); assert.equal(h.store.rows.get(id)?.status, 'ready');
  const transcript = Buffer.from(JSON.stringify({ type: 'transcript', callId: id, speaker: 'caller', text: 'private-utterance' }));
  room.emit(RoomEvent.DataReceived, transcript, sender, DataPacketKind.KIND_LOSSY, 'transcript');
  await flush(); assert.equal(h.runtime.events.get(id)?.length ?? 0, 0);
  room.emit(RoomEvent.DataReceived, transcript, sender, DataPacketKind.KIND_RELIABLE, 'transcript');
  await flush(); assert.equal(h.runtime.events.get(id)?.[0]?.eventType, 'conversation-observed');
  for (const entry of observations) assert.equal(entry.reliable, entry.kind === DataPacketKind.KIND_RELIABLE);
  assert.ok(!JSON.stringify(observations).includes('private-utterance'));
  assert.ok(!JSON.stringify(h.runtime.events.get(id)).includes('private-utterance'));
});
