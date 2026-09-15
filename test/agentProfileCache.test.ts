import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentConfigCache, cachedProfileSnapshot, nocoProfileSource, type CachedProfile } from '../src/agent/profileCache.js';
import { FakeNocoApi } from './helpers/fakeCloud.js';
import { captureLogger } from './helpers/capture.js';

const CALL = { callSessionId: '11111111-2222-4333-8444-555555555555', tenantId: '42', didE164: '+15559870001' };
const row = (over: Record<string, unknown> = {}) => ({ id: 'profile42', revision: 3, iTenantId: 42, enabled: true,
  business_name: 'Acme Dental', prompt: 'Greet the caller.', tone: 'warm', opening_statement: 'Thanks for calling.', ...over });
function seeded(rows: Record<string, unknown>[] = [row()]): FakeNocoApi {
  const noco = new FakeNocoApi(); noco.seed('aida_tbl_AssistantProfile', rows); return noco;
}

test('PlatformConfig loading selects exactly one enabled profile and validates it with the Agent allowlist', async () => {
  const noco = seeded();
  assert.deepEqual(await nocoProfileSource(noco, new Map()).profile('42'), { profileId: 'profile42', profileRevision: 3,
    businessName: 'Acme Dental', prompt: 'Greet the caller.', tone: 'warm', openingStatement: 'Thanks for calling.' });
  // Two enabled profiles are ambiguous until AGENT_PROFILE_IDS_JSON selects one.
  const ambiguous = seeded([row(), row({ id: 'profile43' })]);
  assert.equal(await nocoProfileSource(ambiguous, new Map()).profile('42'), undefined);
  assert.equal((await nocoProfileSource(ambiguous, new Map([['42', 'profile43']])).profile('42'))?.profileId, 'profile43');
  assert.equal(await nocoProfileSource(seeded([row({ enabled: false })]), new Map()).profile('42'), undefined);
  assert.equal(await nocoProfileSource(seeded([row({ id: 'has spaces' })]), new Map()).profile('42'), undefined);
  assert.equal(await nocoProfileSource(seeded([row({ prompt: '' })]), new Map()).profile('42'), undefined);
  assert.equal(await nocoProfileSource(seeded([row({ prompt: 'x'.repeat(12001) })]), new Map()).profile('42'), undefined);
  assert.equal(await nocoProfileSource(seeded([]), new Map()).profile('42'), undefined);
});

test('a cached profile builds the per-call snapshot without re-reading configuration', () => {
  const entry: CachedProfile = { profileId: 'profile42', profileRevision: 3, businessName: 'Acme Dental', prompt: 'Greet the caller.' };
  assert.deepEqual(cachedProfileSnapshot(entry, CALL), { schemaVersion: 1, callSessionId: CALL.callSessionId, tenantId: '42',
    businessName: 'Acme Dental', prompt: 'Greet the caller.', locale: 'en-US', didE164: '+15559870001' });
  assert.throws(() => cachedProfileSnapshot(entry, { ...CALL, didE164: 'not-e164' }));
});

test('a configuration outage after a successful load keeps serving the cached values', async () => {
  const noco = seeded();
  const { logger, lines } = captureLogger();
  const cache = new AgentConfigCache({ tenantIds: ['42'], source: nocoProfileSource(noco, new Map()), logger });
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.get('42')?.profileId, 'profile42');
  assert.equal(cache.status().complete, true);
  const loadedAt = cache.status().lastCompleteAt;

  noco.failOn = '*';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('42')?.profileId, 'profile42', 'an outage must never evict a loaded profile');
  assert.equal(cache.status().lastCompleteAt, loadedAt);
  assert.match(cache.status().lastError ?? '', /Error/);
  assert.ok(lines.some(line => line.includes('serving cached values')));
  // Never log the business prompt while reporting a configuration failure.
  assert.ok(!lines.join('').includes('Greet the caller.'));

  noco.failOn = null;
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.status().lastError, undefined);
});

test('an authoritative revocation removes the tenant so admission fails closed', async () => {
  const noco = seeded();
  const cache = new AgentConfigCache({ tenantIds: ['42'], source: nocoProfileSource(noco, new Map()) });
  await cache.refresh();
  noco.seed('aida_tbl_AssistantProfile', [row({ enabled: false })]);
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('42'), undefined);
  assert.equal(cache.status().complete, false);
});

test('the optional Identity check runs only on refresh and tolerates its own outage', async () => {
  const noco = seeded();
  let answer: 'yes' | 'no' | 'down' = 'yes';
  const cache = new AgentConfigCache({ tenantIds: ['42'], source: nocoProfileSource(noco, new Map()),
    tenantEnabled: async () => { if (answer === 'down') throw new Error('Identity runtime unavailable'); return answer === 'yes'; } });
  assert.equal(await cache.refresh(), true);
  answer = 'down';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('42')?.profileId, 'profile42', 'an Identity outage must not disable a loaded tenant');
  answer = 'no';
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.get('42'), undefined, 'a disabled tenant is revoked at the next refresh');
});

test('refresh runs on its own timer and stops cleanly', async () => {
  const noco = seeded();
  const cache = new AgentConfigCache({ tenantIds: ['42'], source: nocoProfileSource(noco, new Map()), refreshMs: 20 });
  cache.start(); cache.start(); // starting twice must not create a second timer
  for (let i = 0; i < 50 && !cache.get('42'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(cache.get('42')?.profileId, 'profile42');
  cache.stop();
  const attempts = noco.calls.length;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(noco.calls.length, attempts);
});
