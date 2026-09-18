import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { migrateRuntime } from '../src/runtime/migrate.js';
import { MysqlRuntimeStore } from '../src/runtime/mysqlRuntimeStore.js';
import { MysqlAdmissionStore, type Admission } from '../src/agent/store.js';
import { digest, CredentialRejected } from '../src/agent/contract.js';

const url = process.env.TEST_AGENT_MYSQL_URL;
test('real MariaDB bootstrap consumption, lifecycle and event transaction', { skip: !url }, async t => {
  const parsed = new URL(url!); const database = parsed.pathname.slice(1);
  assert.equal(database, 'aida_agent_bootstrap_test');
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database };
  const sql = await mysql.createConnection({ ...config, database: undefined });
  await sql.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``); await sql.query(`USE \`${database}\``);
  await migrateRuntime(config); await migrateRuntime(config);
  const runtime = new MysqlRuntimeStore(config); const store = new MysqlAdmissionStore(config);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/bootstrap-v2.json', import.meta.url), 'utf8'));
  const instance: string = fixture.dispatch.pbxInstanceId; const context: string = fixture.dispatch.context;
  const binding = { bootstrapHash: digest(fixture.dispatch.bootstrapToken), routeHash: digest(fixture.request.routeToken), sipIdentity: 'sip-caller', sipSid: 'PA_sip', agentIdentity: 'agent-1', agentSid: 'PA_agent' };
  async function seed() {
    const id = randomUUID(); const roomName = `aida-${id}`;
    await runtime.createCallSession({ id, roomName, tenantId: '42', asteriskLinkedId: id, officePulseInstanceId: instance, pbxContext: context, ingressContext: 'from-carrier',
      didE164: fixture.response.profileSnapshot.didE164, config: { profileId: 'profile42' }, disposition: 'SCREEN', state: 'screening', destinationType: 'QUEUE', destinationId: 'queue42' });
    const a: Admission = { callId: id, roomName, tenantId: '42', instanceId: instance, pbxInstanceId: instance, context, ingressContext: 'from-carrier', linkedId: id,
      profile: { ...fixture.response.profileSnapshot, callSessionId: id }, bootstrapHash: binding.bootstrapHash, routeHash: binding.routeHash,
      expiresAt: Date.now() + 120000, status: 'pending' };
    await store.create(a); await store.dispatched(id, 'dispatch42'); return (await store.get(id))!;
  }
  try {
    await t.test('the additive scope migration persists and reads back the pinned contexts', async () => {
      const a = await seed();
      const call = await runtime.getCallSession(a.callId);
      assert.equal(call?.pbxContext, context); assert.equal(call?.ingressContext, 'from-carrier');
    });
    await t.test('24 concurrent requests yield one success, one binding and one event', async () => {
      const a = await seed();
      const results = await Promise.allSettled(Array.from({ length: 24 }, () => store.consume(a, binding)));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await store.get(a.callId))?.status, 'admitted');
      assert.equal((await runtime.getCallSession(a.callId))?.agentParticipantSid, 'PA_agent');
      assert.deepEqual((await runtime.listCallEvents(a.callId)).map(e => e.eventType), ['agent-admitted']);
      assert.equal((await runtime.getCallSession(a.callId))?.state, 'admitted');
      // A fresh process/store sees the consumed state too.
      const other = new MysqlAdmissionStore(config);
      try { await assert.rejects(other.consume(a, binding), CredentialRejected); } finally { await other.close(); }
    });
    await t.test('failure inserting evidence rolls back credentials, SID and call state together', async () => {
      const a = await seed();
      await sql.query(`CREATE TRIGGER reject_agent_test_event BEFORE INSERT ON call_event FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced event failure'`);
      try { await assert.rejects(store.consume(a, binding), /forced event failure/); } finally { await sql.query('DROP TRIGGER reject_agent_test_event'); }
      assert.equal((await store.get(a.callId))?.status, 'dispatched'); assert.equal((await runtime.getCallSession(a.callId))?.agentParticipantSid, undefined);
      assert.equal((await runtime.listCallEvents(a.callId)).length, 0);
      assert.deepEqual(await store.consume(a, binding), a.profile);
    });
    await t.test('wrong hash, expired, altered tenant/room/instance/context/linkedid and ended calls fail atomically', async () => {
      for (const field of ['bootstrapHash','routeHash','expiresAt','tenant_id','room_name','officepulse_instance_id','pbx_context','asterisk_linked_id','ended_at','disposition']) {
        const a = await seed();
        const b = { ...binding };
        if (field === 'bootstrapHash' || field === 'routeHash') b[field] = digest('wrong');
        else if (field === 'expiresAt') await sql.execute("UPDATE agent_admission SET data=JSON_SET(data,'$.expiresAt',0) WHERE call_id=?", [a.callId]);
        else await sql.execute(`UPDATE call_session SET ${field}=? WHERE id=?`, [field === 'ended_at' ? new Date() : field === 'disposition' ? 'FALLBACK' : field === 'pbx_context' ? 'other-office' : randomUUID(), a.callId]);
        await assert.rejects(store.consume(a, b), CredentialRejected, field);
        assert.equal((await store.get(a.callId))?.status, 'dispatched', field);
      }
    });
    await t.test('fallback racing consumption prevents subsequent readiness and replay', async () => {
      const a = await seed();
      await Promise.allSettled([store.consume(a, binding), store.transition(a.callId, 'fallback', 'agent-fallback')]);
      assert.equal((await store.get(a.callId))?.status, 'fallback');
      assert.equal((await runtime.getCallSession(a.callId))?.agentParticipantSid, undefined);
      assert.equal(await store.transition(a.callId, 'ready', 'agent-ready'), false);
      await assert.rejects(store.consume(a, binding), CredentialRejected);
      await store.transition(a.callId, 'ended', 'call-completed'); assert.ok((await runtime.getCallSession(a.callId))?.endedAt);
    });
    await t.test('unrelated signed agent joins cannot overwrite bootstrap-bound observer SID', async () => {
      const a = await seed(); await store.consume(a, binding);
      await runtime.applyLiveKitWebhook({ callSessionId: a.callId, roomName: a.roomName, deliveryId: randomUUID(), eventType: 'participant_joined',
        participant: { sid: 'PA_impostor', identity: 'agent-fake', kind: 'AGENT', isAgent: true } });
      assert.equal((await runtime.getCallSession(a.callId))?.agentParticipantSid, 'PA_agent');
    });
    await t.test('late transport events cannot downgrade admission or readiness', async () => {
      const a = await seed(); await store.consume(a, binding);
      const event = { eventType: 'aida-connected', occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() };
      await runtime.applyCallEvent(a.callId, event, 'screening');
      assert.equal((await runtime.getCallSession(a.callId))?.state, 'admitted');
      await store.transition(a.callId, 'ready', 'agent-ready');
      await runtime.applyCallEvent(a.callId, { ...event, idempotencyKey: randomUUID() }, 'screening');
      assert.equal((await runtime.getCallSession(a.callId))?.state, 'agent-ready');
    });
    await t.test('persisted profile is pinned and contains neither plaintext credential', async () => {
      const a = await seed();
      const [rows] = await sql.execute<mysql.RowDataPacket[]>('SELECT data FROM agent_admission WHERE call_id=?', [a.callId]);
      const data = JSON.stringify(rows); assert.ok(!data.includes(fixture.dispatch.bootstrapToken)); assert.ok(!data.includes(fixture.request.routeToken));
      assert.deepEqual(await store.consume(a, binding), a.profile);
    });
  } finally { await store.close(); await runtime.close(); await sql.end(); }
});
