import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { MysqlRuntimeStore } from '../src/runtime/mysqlRuntimeStore.js';
import { migrateRuntime } from '../src/runtime/migrate.js';
import type { LiveKitWebhookUpdate } from '../src/runtime/store.js';

// Dedicated webhook test schema only. Never changes a deployed database or PBX.
const url = process.env.TEST_WEBHOOK_MYSQL_URL;
test('MySQL commits LiveKit receipt, participant, agent and event atomically', { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  const database = parsed.pathname.slice(1);
  assert.equal(database, 'aida_webhook_platform_test');
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database };
  const sql = await mysql.createConnection({ ...config, database: undefined });
  await sql.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  await sql.query(`USE \`${database}\``);
  await migrateRuntime(config);
  const runtime = new MysqlRuntimeStore(config);
  const callId = randomUUID();
  const roomName = `aida-${callId}`;
  const delivery: LiveKitWebhookUpdate = { deliveryId: randomUUID(), eventType: 'participant_joined',
    callSessionId: callId, roomName,
    participant: { sid: 'PA_original', identity: 'agent-original', kind: 'AGENT', isAgent: true } };
  await runtime.createCallSession({ id: callId, asteriskLinkedId: randomUUID(), officePulseInstanceId: 'webhook-test',
    tenantId: '1', didE164: '+15555550123', roomName, config: {}, disposition: 'SCREEN', state: 'human-active' });
  try {
    await t.test('event-insert failure rolls back the receipt and every earlier projection', async () => {
      await sql.query('DROP TRIGGER IF EXISTS reject_livekit_test_event');
      await sql.query(`CREATE TRIGGER reject_livekit_test_event BEFORE INSERT ON call_event
        FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced webhook event failure'`);
      try {
        await assert.rejects(runtime.applyLiveKitWebhook(delivery), /forced webhook event failure/);
        const [receipts] = await sql.execute<mysql.RowDataPacket[]>('SELECT * FROM webhook_delivery WHERE delivery_id = ?', [delivery.deliveryId]);
        const [participants] = await sql.execute<mysql.RowDataPacket[]>('SELECT * FROM livekit_participant WHERE call_session_id = ?', [callId]);
        assert.equal(receipts.length, 0);
        assert.equal(participants.length, 0);
        assert.equal((await runtime.getCallSession(callId))?.agentParticipantSid, undefined);
        assert.equal((await runtime.getCallSession(callId))?.version, 1);
        assert.equal((await runtime.listCallEvents(callId)).length, 0);
      } finally { await sql.query('DROP TRIGGER IF EXISTS reject_livekit_test_event'); }
    });
    await t.test('retry and simultaneous duplicates apply once and allocate one event sequence', async () => {
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => runtime.applyLiveKitWebhook(delivery)));
      assert.equal(outcomes.filter(outcome => outcome === 'applied').length, 1);
      assert.equal(outcomes.filter(outcome => outcome === 'duplicate').length, 5);
      assert.equal((await runtime.getCallSession(callId))?.agentParticipantSid, 'PA_original');
      assert.equal((await runtime.getCallSession(callId))?.version, 2);
      assert.deepEqual((await runtime.listCallEvents(callId)).map(event => event.sequenceNumber), [1]);
    });
    await t.test('departure of an old agent cannot clear a replacement; current departure clears it', async () => {
      await runtime.applyLiveKitWebhook({ ...delivery, deliveryId: randomUUID(),
        participant: { sid: 'PA_new', identity: 'agent-new', kind: 'AGENT', isAgent: true } });
      await runtime.applyLiveKitWebhook({ ...delivery, deliveryId: randomUUID(), eventType: 'participant_left' });
      assert.equal((await runtime.getCallSession(callId))?.agentParticipantSid, 'PA_new');
      await runtime.applyLiveKitWebhook({ ...delivery, deliveryId: randomUUID(), eventType: 'participant_left',
        participant: { sid: 'PA_new', kind: 'AGENT', isAgent: true } });
      assert.equal((await runtime.getCallSession(callId))?.agentParticipantSid, undefined);
    });
    await t.test('room completion leaves the phone call active', async () => {
      await runtime.applyLiveKitWebhook({ ...delivery, deliveryId: randomUUID(), eventType: 'room_finished', participant: undefined });
      const call = await runtime.getCallSession(callId);
      assert.equal(call?.state, 'human-active');
      assert.equal(call?.endedAt, undefined);
    });
    await t.test('unknown call or mismatched persisted room writes nothing', async () => {
      for (const update of [ { ...delivery, callSessionId: randomUUID() }, { ...delivery, roomName: 'unrelated' } ]) {
        const id = randomUUID();
        assert.equal(await runtime.applyLiveKitWebhook({ ...update, deliveryId: id }), 'unknown-room');
        const [rows] = await sql.execute<mysql.RowDataPacket[]>('SELECT * FROM webhook_delivery WHERE delivery_id = ?', [id]);
        assert.equal(rows.length, 0);
      }
    });
    await t.test('late agent join cannot resurrect an ended phone call', async () => {
      await runtime.updateCallSession(callId, { state: 'ended', endedAt: new Date().toISOString() });
      await runtime.applyLiveKitWebhook({ ...delivery, deliveryId: randomUUID() });
      const call = await runtime.getCallSession(callId);
      assert.equal(call?.state, 'ended');
      assert.ok(call?.endedAt);
      assert.equal(call?.agentParticipantSid, undefined);
    });
  } finally {
    await sql.query('DROP TRIGGER IF EXISTS reject_livekit_test_event');
    await runtime.close();
    await sql.end();
  }
});
