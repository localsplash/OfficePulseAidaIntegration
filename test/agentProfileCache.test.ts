import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentConfigCache, assignmentKey, cachedProfileSnapshot, nocoProfileSource, type CachedProfile } from '../src/agent/profileCache.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';
import { captureLogger } from './helpers/capture.js';

const INSTANCE = 'op-test';
const CALL = { callSessionId: '11111111-2222-4333-8444-555555555555', didE164: '+15559870001' };
const profile = (over: Record<string, unknown> = {}) => ({ id: 'profile42', revision: 3, iTenantId: 42, enabled: 1,
  business_name: 'Acme Dental', prompt: 'Greet the caller.', tone: 'warm', opening_statement: 'Thanks for calling.', ...over });
const assignment = (over: Record<string, unknown> = {}) => ({ id: 'a1', iTenantId: 42, pbx_instance_id: INSTANCE, context: 'acme', did: null, profile_id: 'profile42', enabled: 1, ...over });
function seeded(assignments: Record<string, unknown>[] = [assignment()], profiles: Record<string, unknown>[] = [profile()]): FakeNocoApi {
  const noco = new FakeNocoApi(); noco.seed('aida_tbl_ProfileAssignment', assignments); noco.seed('aida_tbl_AssistantProfile', profiles); return noco;
}
const ENTRY: CachedProfile = { tenantId: '42', pbxInstanceId: INSTANCE, context: 'acme', did: '', profileId: 'profile42', profileRevision: 3,
  businessName: 'Acme Dental', prompt: 'Greet the caller.', tone: 'warm', openingStatement: 'Thanks for calling.' };

test('PlatformConfig assignments of this instance load their profile, normalize a null DID to the context default and validate with the Agent allowlist', async () => {
  const source = nocoProfileSource(seeded([assignment(), assignment({ id: 'a2', pbx_instance_id: 'other-pbx', context: 'elsewhere' }),
    assignment({ id: 'a3', enabled: 0, context: 'off' }), assignment({ id: 'a4', did: '+15559870001' })]), INSTANCE);
  const rows = await source.assignments();
  assert.deepEqual(rows, [{ tenantId: '42', pbxInstanceId: INSTANCE, context: 'acme', did: '', profileId: 'profile42' },
    { tenantId: '42', pbxInstanceId: INSTANCE, context: 'acme', did: '+15559870001', profileId: 'profile42' }]);
  assert.deepEqual(await source.profile(rows[0]!), ENTRY);
  // The column is stored as 1/0; a boolean filter pushed into NocoDB matches nothing.
  for (const enabled of [1, '1', true]) assert.equal((await nocoProfileSource(seeded(undefined, [profile({ enabled })]), INSTANCE).profile(rows[0]!))?.profileId, 'profile42', String(enabled));
  for (const enabled of [0, '0', false, null]) assert.equal(await nocoProfileSource(seeded(undefined, [profile({ enabled })]), INSTANCE).profile(rows[0]!), undefined, String(enabled));
  // Authoritative negatives: missing, duplicated id, another customer's profile, invalid or oversized text.
  for (const profiles of [[], [profile(), profile()], [profile({ iTenantId: 43 })], [profile({ prompt: '' })], [profile({ prompt: 'x'.repeat(12001) })]]) {
    assert.equal(await nocoProfileSource(seeded(undefined, profiles), INSTANCE).profile(rows[0]!), undefined);
  }
});

test('a cached assignment builds the v2 per-call snapshot without re-reading configuration', () => {
  assert.deepEqual(cachedProfileSnapshot(ENTRY, CALL), { schemaVersion: 2, callSessionId: CALL.callSessionId, pbxInstanceId: INSTANCE, context: 'acme', tenantId: '42',
    businessName: 'Acme Dental', prompt: 'Greet the caller.', locale: 'en-US', didE164: '+15559870001', tone: 'warm', openingStatement: 'Thanks for calling.' });
  assert.throws(() => cachedProfileSnapshot(ENTRY, { ...CALL, didE164: 'not-e164' }));
  assert.equal(assignmentKey('acme', ''), 'acme\0');
});

test('DID-specific and context-default assignments resolve independently; a removed or disabled assignment is evicted at the next refresh', async () => {
  const noco = seeded([assignment(), assignment({ id: 'a4', did: '+15559870001', profile_id: 'profile43' })], [profile(), profile({ id: 'profile43', revision: 1 })]);
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE) });
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.get('acme', '')?.profileId, 'profile42');
  assert.equal(cache.get('acme', '+15559870001')?.profileId, 'profile43');
  assert.equal(cache.get('acme', '+15550000000'), undefined, 'the authority, not the cache, falls back to the context default');
  const status = cache.status();
  assert.deepEqual(status, { configuredAssignments: 2, loadedKeys: ['acme\0', 'acme\0+15559870001'], complete: true, lastAttemptAt: status.lastAttemptAt, lastCompleteAt: status.lastCompleteAt });
  noco.seed('aida_tbl_ProfileAssignment', [assignment({ enabled: 0 }), assignment({ id: 'a4', did: '+15559870001', profile_id: 'profile43' })]);
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.get('acme', ''), undefined, 'a disabled assignment fails closed at the next refresh');
  assert.equal(cache.get('acme', '+15559870001')?.profileId, 'profile43');
  noco.seed('aida_tbl_ProfileAssignment', []);
  assert.equal(await cache.refresh(), false);
  assert.deepEqual(cache.status().loadedKeys, []);
  assert.equal(cache.status().configuredAssignments, 0);
});

test('two enabled rows for one key are ambiguous: neither is trusted, the key is evicted and logged without profile text', async () => {
  const noco = seeded();
  const { logger, lines } = captureLogger();
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE), logger });
  assert.equal(await cache.refresh(), true);
  noco.seed('aida_tbl_ProfileAssignment', [assignment(), assignment({ id: 'a2', profile_id: 'profile43' })]);
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('acme', ''), undefined);
  assert.equal(cache.status().complete, false); assert.equal(cache.status().configuredAssignments, 1);
  assert.ok(lines.some(line => line.includes('duplicate-assignment')));
  assert.ok(!lines.join('').includes('Greet the caller.'));
});

test('a profile owned by another customer, or an invalid assignment row, is an authoritative negative', async () => {
  const noco = seeded();
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE) });
  assert.equal(await cache.refresh(), true);
  noco.seed('aida_tbl_AssistantProfile', [profile({ iTenantId: 43 })]);
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('acme', ''), undefined, 'a tenant mismatch evicts the key');
  noco.seed('aida_tbl_AssistantProfile', [profile()]);
  assert.equal(await cache.refresh(), true);
  for (const bad of [{ profile_id: 'has spaces' }, { iTenantId: 'x' }, { did: '15559870001' }, { context: 'bad ctx' }]) {
    noco.seed('aida_tbl_ProfileAssignment', [assignment(bad)]);
    const reads = noco.calls.length;
    assert.equal(await cache.refresh(), false, JSON.stringify(bad));
    assert.equal(cache.status().loadedKeys.length, 0, JSON.stringify(bad));
    assert.equal(noco.calls.length, reads + 1, 'an invalid row never becomes a profile lookup');
    noco.seed('aida_tbl_ProfileAssignment', [assignment()]);
    assert.equal(await cache.refresh(), true);
  }
});

test('a configuration outage after a successful load keeps serving the cached values', async () => {
  const noco = seeded();
  const { logger, lines } = captureLogger();
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE), logger });
  assert.equal(await cache.refresh(), true);
  const loadedAt = cache.status().lastCompleteAt;
  noco.failOn = 'aida_tbl_ProfileAssignment';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('acme', '')?.profileId, 'profile42', 'an assignment outage must never evict a loaded key');
  assert.equal(cache.status().lastCompleteAt, loadedAt);
  assert.match(cache.status().lastError ?? '', /Error/);
  noco.failOn = 'aida_tbl_AssistantProfile';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('acme', '')?.profileId, 'profile42', 'a profile outage must never evict a loaded key');
  assert.ok(lines.some(line => line.includes('serving cached values')));
  // Never log the business prompt while reporting a configuration failure.
  assert.ok(!lines.join('').includes('Greet the caller.'));
  noco.failOn = null;
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.status().lastError, undefined);
});

test('the optional Identity check runs once per distinct tenant on refresh, tolerates its own outage, and revokes every assignment of a disabled tenant', async () => {
  const noco = seeded([assignment(), assignment({ id: 'a2', context: 'acme-two' }), assignment({ id: 'a3', iTenantId: 43, context: 'other', profile_id: 'profile43' })],
    [profile(), profile({ id: 'profile43', iTenantId: 43 })]);
  let answer: 'yes' | 'no' | 'down' = 'yes'; const checked: string[] = [];
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE),
    tenantEnabled: async id => { checked.push(id); if (answer === 'down') throw new Error('Identity runtime unavailable'); return answer === 'yes' || id === '43'; } });
  assert.equal(await cache.refresh(), true);
  assert.deepEqual(checked.sort(), ['42', '43'], 'one check per distinct tenant, not per assignment');
  assert.equal(cache.status().loadedKeys.length, 3);
  answer = 'down';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.status().loadedKeys.length, 3, 'an Identity outage must not disable loaded assignments');
  answer = 'no';
  assert.equal(await cache.refresh(), false);
  assert.deepEqual(cache.status().loadedKeys, ['other\0'], 'a disabled tenant loses all of its assignments at the next refresh');
});

test('refresh runs on its own timer and stops cleanly', async () => {
  const noco = seeded();
  const cache = new AgentConfigCache({ source: nocoProfileSource(noco, INSTANCE), refreshMs: 20 });
  cache.start(); cache.start(); // starting twice must not create a second timer
  for (let i = 0; i < 50 && !cache.get('acme', ''); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(cache.get('acme', '')?.profileId, 'profile42');
  cache.stop();
  const attempts = noco.calls.length;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(noco.calls.length, attempts);
});
