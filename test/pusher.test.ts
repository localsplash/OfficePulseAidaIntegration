import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PusherNotifier, queueChannel } from '../src/notify/pusher.js';
import { RuntimeCallEventSink } from '../src/runtime/callEventSink.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { captureLogger } from './helpers/capture.js';

test('Pusher channels are deterministic, bounded and separator-safe', () => {
  assert.equal(queueChannel('officepulse-dev','office','sales'), 'aida;officepulse-dev;office;sales');
  const scope = ['x'.repeat(80), 'y'.repeat(40), 'z'.repeat(80)];
  assert.equal(queueChannel(scope[0]!,scope[1]!,scope[2]!), 'aida;h;' + createHash('sha256').update('aida;' + scope.join(';')).digest('hex').slice(0,40));
  assert.throws(() => queueChannel('dev','a;b','queue'), /invalid/);
});

test('Pusher sends only the allowed state payload to a public queue channel', async () => {
  let sent: any;
  const notifier = new PusherNotifier({ appId: '123', key: 'public', secret: 'secret', cluster: 'us2', timeoutMs: 100,
    logger: captureLogger().logger, fetchImpl: async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response('{}'); } });
  await notifier.publishCallState('aida;dev;office;sales', { v: 1, eventId: 'event', callSessionId: 'call', state: 'screening', occurredAt: 'now', callerNumber: 'private' } as any);
  assert.equal(sent.name, 'call'); assert.equal(sent.channel, 'aida;dev;office;sales');
  assert.deepEqual(JSON.parse(sent.data), { v: 1, eventId: 'event', callSessionId: 'call', state: 'screening', occurredAt: 'now' });
});

test('notifier failures and latency never affect persistence; repeated state emits no duplicate alert', async () => {
  const runtime = new FakeRuntimeStore(); const call = runtime.seedSession({ state: 'arrived', destinationType: 'QUEUE', destinationId: 'sales', pbxContext: 'office' });
  const alerts: any[] = [];
  const sink = new RuntimeCallEventSink(runtime, captureLogger().logger, undefined, { ping: async () => true, publishCallState: async (channel, alert) => { alerts.push({channel,alert}); throw new Error('offline'); } });
  for (const eventType of ['screening-started', 'aida-connected', 'takeover-requested', 'ringing', 'takeover-failed', 'hangup']) {
    assert.equal(await sink.postCallEvent(call.id, { eventType, idempotencyKey: eventType, occurredAt: new Date().toISOString() }), true);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(alerts.map(a => a.alert.state), ['screening','ringing','screening','ended']);
  assert.equal((await runtime.listCallEvents(call.id)).length, 6);
  const slow = new RuntimeCallEventSink(runtime, captureLogger().logger, undefined, { ping: async () => true, publishCallState: () => new Promise(() => {}) });
  const other = runtime.seedSession({ state: 'arrived', destinationType: 'QUEUE', destinationId: 'sales', pbxContext: 'office' });
  assert.equal(await slow.postCallEvent(other.id, { eventType: 'screening-started', idempotencyKey: 'slow', occurredAt: new Date().toISOString() }), true);
});
