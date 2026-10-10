import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { MysqlRuntimeStore } from '../src/runtime/mysqlRuntimeStore.js';
import { migrateRuntime } from '../src/runtime/migrate.js';

// Dedicated, disposable schema only. Never reads or changes a deployed database.
const url = process.env.TEST_RUNTIME_QUERIES_MYSQL_URL;
test('AidaAdmin runtime reads filter by state, tenant, window and type', { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  const database = parsed.pathname.slice(1);
  assert.equal(database, 'aida_runtime_queries_test');
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database };
  const sql = await mysql.createConnection({ ...config, database: undefined });
  await sql.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await sql.query(`CREATE DATABASE \`${database}\``);
  await sql.query(`USE \`${database}\``);
  await migrateRuntime(config);
  const runtime = new MysqlRuntimeStore(config);
  t.after(async () => { await runtime.close(); await sql.query(`DROP DATABASE IF EXISTS \`${database}\``); await sql.end(); });

  const call = async (tenantId: string) => {
    const id = randomUUID();
    await runtime.createCallSession({ id, asteriskLinkedId: randomUUID(), officePulseInstanceId: 'queries-test', tenantId,
      didE164: '+15555550123', config: { profileId: 'profile-1' }, disposition: 'SCREEN', state: 'screening' });
    return id;
  };
  const active = await call('1');
  const orphaned = await call('1');
  const ended = await call('2');
  await sql.execute('UPDATE call_session SET created_at = NOW() - INTERVAL 7 HOUR WHERE id = ?', [orphaned]);

  await runtime.appendCallEvent(active, { eventType: 'agent.failed', payload: { reason: 'timeout' } });
  await runtime.appendCallEvent(ended, { eventType: 'agent.failed' });
  await runtime.appendCallEvent(ended, { eventType: 'call.ended' });
  await runtime.claimControlCommand({ callSessionId: active, idempotencyKey: 'k1', commandType: 'DRAIN_ACK', status: 'in-progress' });
  await runtime.completeControlCommand(active, 'k1', 'failed', { error: 'no channel' });
  await runtime.claimControlCommand({ callSessionId: ended, idempotencyKey: 'k2', commandType: 'DRAIN_ACK', status: 'in-progress' });
  await runtime.completeControlCommand(ended, 'k2', 'completed');
  // Commands are refused on an ended call, so end it only after its command.
  await runtime.updateCallSession(ended, { state: 'ended', endedAt: new Date().toISOString() });
  await runtime.upsertParticipant(active, { participantSid: 'PA_1', identity: 'agent', kind: 'AGENT' });
  await runtime.markParticipantLeft(active, 'PA_1');
  await runtime.recordWebhookDelivery('livekit', 'delivery-1', 'room_started', active);
  await runtime.setDependencyStatus('ari', false, 'not connected');

  const ids = (calls: Array<{ id: string }>) => calls.map((c) => c.id).sort();
  assert.deepEqual(ids(await runtime.listCallSessions({ state: 'active' })), [active]);
  assert.deepEqual(ids(await runtime.listCallSessions({ state: 'orphaned' })), [orphaned]);
  assert.deepEqual(ids(await runtime.listCallSessions({ state: 'recent' })), [ended]);
  assert.deepEqual(ids(await runtime.listCallSessions({ state: 'all', tenantId: '1' })), [active, orphaned].sort());
  assert.equal((await runtime.listCallSessions({ state: 'all', limit: 1 })).length, 1);
  const [session] = await runtime.listCallSessions({ state: 'recent' });
  assert.equal(session?.config.profileId, 'profile-1');
  assert.ok(session?.endedAt);

  const [command] = await runtime.listControlCommands(active);
  assert.equal(command?.status, 'failed');
  assert.deepEqual(command?.result, { error: 'no channel' });
  assert.ok(command?.createdAt);
  const [participant] = await runtime.listParticipants(active);
  assert.equal(participant?.identity, 'agent');
  assert.ok(participant?.leftAt);
  assert.deepEqual((await runtime.listWebhookDeliveries()).map((d) => [d.deliveryId, d.callSessionId]), [['delivery-1', active]]);
  assert.deepEqual((await runtime.listDependencyStatus()).map((d) => [d.name, d.ready, d.detail]), [['ari', false, 'not connected']]);

  assert.deepEqual((await runtime.listFailedCommands(24)).map((c) => [c.callSessionId, c.tenantId, c.idempotencyKey]), [[active, '1', 'k1']]);
  assert.deepEqual(await runtime.listFailedCommands(24, '2'), []);
  const failures = await runtime.listEventsOfType(['agent.failed'], 24);
  assert.deepEqual(failures.map((e) => e.callSessionId).sort(), [active, ended].sort());
  assert.deepEqual((await runtime.listEventsOfType(['agent.failed'], 24, '1')).map((e) => [e.callSessionId, e.payload]), [[active, { reason: 'timeout' }]]);
  assert.deepEqual(await runtime.listEventsOfType([], 24), []);
});
