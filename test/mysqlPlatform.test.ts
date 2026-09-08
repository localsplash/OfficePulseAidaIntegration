import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { migrateRuntime } from '../src/runtime/migrate.js';
import { MysqlRuntimeStore } from '../src/runtime/mysqlRuntimeStore.js';
import { MysqlDeviceStore } from '../src/devices/mysqlDeviceStore.js';
import { credentialHash } from '../src/devices/access.js';

// Opt-in and deliberately refuses arbitrary schemas. Never point at a deployed database.
const url = process.env.TEST_MYSQL_URL;
test('MySQL platform migration, enrollment and call-command concurrency', { skip: !url }, async (t) => {
  const parsed = new URL(url!);
  const database = parsed.pathname.slice(1);
  assert.match(database, /^aida_[a-z0-9_]+_test$/);
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database };
  const connection = await mysql.createConnection({ ...config, database: undefined });
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  await connection.query(`USE \`${database}\``);
  await migrateRuntime(config);
  const runtime = new MysqlRuntimeStore(config);
  const devices = new MysqlDeviceStore(config, runtime);
  try {
    const extensionId = randomUUID();
    const call = (await runtime.createCallSession({ id: randomUUID(), asteriskLinkedId: randomUUID(),
      officePulseInstanceId: 'integration-test', tenantId: '1', didE164: '+15555550123', config: {},
      destinationType: 'EXTENSION', destinationId: extensionId, disposition: 'SCREEN', state: 'screening' })).session;
    await t.test('cleanup removes only projection bookkeeping and preserves device/call runtime', async () => {
      const retired = ['provisioning_operation', 'did_fallback'];
      for (const table of retired) await connection.query(`CREATE TABLE ${table} (legacy_id INT)`);
      await connection.query("DELETE FROM aida_tbl_SchemaMigration WHERE name='004_remove_retired_pbx.sql'");
      await connection.query("INSERT INTO dependency_status (name,ready) VALUES ('provisioning-adapter',1)");
      await migrateRuntime(config);
      assert.equal((await runtime.getCallSession(call.id))?.asteriskLinkedId, call.asteriskLinkedId);
      for (const table of retired) await assert.rejects(connection.query(`SELECT * FROM ${table}`), /doesn't exist/);
      const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT name FROM dependency_status WHERE name='provisioning-adapter'");
      assert.equal(rows.length, 0);
      for (const table of ['aida_tbl_DeviceEnrollment', 'aida_tbl_DeviceSession', 'aida_tbl_EventReceipt']) await connection.query(`SELECT * FROM ${table} LIMIT 1`);
    });
    await t.test('migration rerun preserves existing call data', async () => {
      await migrateRuntime(config);
      assert.equal((await runtime.getCallSession(call.id))?.asteriskLinkedId, call.asteriskLinkedId);
    });
    let deviceId = '';
    const sessionHashes = [credentialHash(randomUUID()), credentialHash(randomUUID())];
    await t.test('concurrent enrollment consumes one capability and stores only hashes', async () => {
      const hash = credentialHash(randomUUID());
      await devices.issueEnrollment(hash, 1, extensionId);
      const results = await Promise.all(sessionHashes.map((h) => devices.consumeEnrollment(hash, 'test-hardware', h)));
      assert.equal(results.filter(Boolean).length, 1);
      deviceId = results.find(Boolean)!.id;
      assert.equal((await devices.getDevice(deviceId))?.iTenantId, 1);
    });
    await t.test('revocation removes all token resolution for a device', async () => {
      await devices.revokeDevice(deviceId);
      assert.equal(await devices.getDevice(deviceId), undefined);
      for (const hash of sessionHashes) assert.equal(await devices.resolveSession(hash), undefined);
    });
    const command = { callSessionId: call.id, idempotencyKey: 'takeover-1', commandType: 'TAKEOVER', status: 'pending' };
    await t.test('same command concurrently claims once and advances version once', async () => {
      const results = await Promise.all([runtime.claimControlCommand(command, 1), runtime.claimControlCommand(command, 1)]);
      assert.equal(results.filter((r) => r.claimed).length, 1);
      assert.equal((await runtime.getCallSession(call.id))?.version, 2);
      assert.equal((await runtime.listCallEvents(call.id)).length, 1);
    });
    await t.test('replay returns recorded result despite stale version; changed payload conflicts', async () => {
      await runtime.completeControlCommand(call.id, command.idempotencyKey, 'accepted', { ok: true });
      const replay = await runtime.claimControlCommand(command, 1);
      assert.equal(replay.existing?.status, 'accepted');
      assert.deepEqual(replay.existing?.result, { ok: true });
      await assert.rejects(runtime.claimControlCommand({ ...command, payload: { destination: 'injected' } }, 2), /different command/);
    });
    await t.test('two distinct commands with the same version permit only one', async () => {
      const results = await Promise.allSettled(['two', 'three'].map((key) => runtime.claimControlCommand({ ...command, idempotencyKey: key }, 2)));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal((await runtime.getCallSession(call.id))?.version, 3);
    });
    await t.test('concurrent lifecycle appends produce contiguous unique sequences', async () => {
      await Promise.all(Array.from({ length: 8 }, () => runtime.appendCallEvent(call.id, { eventType: 'test.lifecycle' })));
      const events = await runtime.listCallEvents(call.id);
      assert.deepEqual(events.map((e) => e.sequenceNumber), Array.from({ length: events.length }, (_, i) => i + 1));
    });
    await t.test('lifecycle receipt, projection and sequence commit once; late bridge cannot resurrect', async () => {
      const event = { eventType: 'hangup', occurredAt: new Date().toISOString(), idempotencyKey: 'ended-event' };
      await Promise.all([runtime.applyCallEvent(call.id, event, 'ended'), runtime.applyCallEvent(call.id, event, 'ended')]);
      const before = await runtime.getCallSession(call.id);
      await runtime.applyCallEvent(call.id, { ...event, idempotencyKey: 'late-bridge', eventType: 'bridged' }, 'human-active');
      assert.equal((await runtime.getCallSession(call.id))?.state, 'ended');
      assert.equal((await runtime.getCallSession(call.id))?.version, before?.version);
      assert.equal((await runtime.listCallEvents(call.id)).filter((e) => e.eventType === 'hangup').length, 1);
    });
    await t.test('ended call rejects new work and keeps acknowledged command replay', async () => {
      await runtime.updateCallSession(call.id, { endedAt: new Date().toISOString(), state: 'ended' });
      await assert.rejects(runtime.claimControlCommand({ ...command, idempotencyKey: 'late' }), /ended/);
      assert.equal((await runtime.claimControlCommand(command, 1)).claimed, false);
      assert.deepEqual(await devices.listCalls('1', [extensionId]), []);
    });
  } finally {
    await devices.close(); await runtime.close(); await connection.end();
  }
});
