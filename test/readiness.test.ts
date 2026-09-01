import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readiness } from '../src/readiness.js';

/**
 * Readiness is reported per dependency, with criticality (issue #9).
 * Losing a cloud dependency degrades screening but the caller still
 * reaches a human locally, so it must not take the service out of service.
 */

function registerAll(): Readiness {
  const readiness = new Readiness();
  readiness.register('ari', 'critical', true);
  readiness.register('asterisk-mysql', 'critical', true);
  readiness.register('runtime-mysql', 'critical', true);
  readiness.register('nocodb', 'degraded', true);
  readiness.register('livekit', 'degraded', true);
  readiness.register('pusher', 'degraded', true);
  readiness.register('provisioning-adapter', 'degraded', true);
  return readiness;
}

test('every dependency is reported independently', () => {
  const readiness = registerAll();
  readiness.set('nocodb', false, 'base unreachable');
  const snapshot = readiness.snapshot();

  assert.deepEqual(Object.keys(snapshot.components).sort(), [
    'ari',
    'asterisk-mysql',
    'livekit',
    'nocodb',
    'provisioning-adapter',
    'pusher',
    'runtime-mysql',
  ]);
  assert.equal(snapshot.components.nocodb?.ready, false);
  assert.equal(snapshot.components.nocodb?.detail, 'base unreachable');
  assert.equal(snapshot.components.livekit?.ready, true, 'one failure must not mask the others');
});

test('losing a cloud dependency degrades without taking the service down', () => {
  for (const degraded of ['nocodb', 'livekit', 'pusher', 'provisioning-adapter']) {
    const readiness = registerAll();
    readiness.set(degraded, false);
    const snapshot = readiness.snapshot();
    // The caller still reaches a human through the local fallback.
    assert.equal(snapshot.ready, true, `${degraded} must not fail readiness`);
    assert.equal(snapshot.fullyOperational, false, `${degraded} must still be visible as degraded`);
  }
});

test('losing a critical dependency fails readiness', () => {
  for (const critical of ['ari', 'asterisk-mysql', 'runtime-mysql']) {
    const readiness = registerAll();
    readiness.set(critical, false);
    assert.equal(readiness.snapshot().ready, false, `${critical} must fail readiness`);
  }
});

test('observers see each transition once, so status can be recorded durably', () => {
  const readiness = registerAll();
  const seen: Array<{ name: string; ready: boolean }> = [];
  readiness.observe((name, ready) => seen.push({ name, ready }));

  readiness.set('livekit', false, 'timeout');
  readiness.set('livekit', false, 'timeout'); // unchanged: not a transition
  readiness.set('livekit', true);

  assert.deepEqual(seen, [
    { name: 'livekit', ready: false },
    { name: 'livekit', ready: true },
  ]);
});

test('a changed detail on the same state is still a transition worth recording', () => {
  const readiness = registerAll();
  const details: Array<string | undefined> = [];
  readiness.observe((_name, _ready, detail) => details.push(detail));
  readiness.set('nocodb', false, 'timeout');
  readiness.set('nocodb', false, 'base missing');
  assert.deepEqual(details, ['timeout', 'base missing']);
});

test('an unregistered component is never invented by a status update', () => {
  const readiness = registerAll();
  readiness.set('not-a-dependency', false);
  assert.equal('not-a-dependency' in readiness.snapshot().components, false);
});

test('a fresh registry with nothing registered is not ready', () => {
  assert.equal(new Readiness().snapshot().ready, false);
});
