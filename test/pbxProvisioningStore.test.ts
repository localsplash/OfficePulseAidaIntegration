import { test } from 'node:test';
import assert from 'node:assert/strict';
import type mysql from 'mysql2/promise';
import { MysqlPbxProvisioner } from '../src/pbx/provisioningStore.js';
import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../src/errors.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';

const config = { host: 'unused', port: 3306, database: 'unused', user: 'unused', password: 'unused' };
const scope = { contexts: ['tenant-one'], queueNames: [], didContext: 'inbound-one', didNumbers: ['+15555550101'] };
type Call = { sql: string; values: unknown[] };
function fakeWriter(respond: (call: Call) => unknown = () => undefined, commitError?: unknown) {
  const calls: Call[] = [];
  let committed = 0;
  let rolledBack = 0;
  let released = 0;
  const conn = {
    execute: async (options: { sql: string }, values: unknown[] = []) => {
      const call = { sql: options.sql, values };
      calls.push(call);
      const result = respond(call);
      return [result ?? (options.sql.startsWith('SELECT') ? [] : { affectedRows: 1 }), []];
    },
    beginTransaction: async () => {},
    commit: async () => { if (commitError) throw commitError; committed++; },
    rollback: async () => { rolledBack++; },
    release: () => { released++; },
  };
  const pool = { getConnection: async () => conn, execute: conn.execute, end: async () => {} } as unknown as mysql.Pool;
  return { writer: new MysqlPbxProvisioner(config, pool), calls, status: () => ({ committed, rolledBack, released }) };
}

test('writer returns a strong SIP secret only after commit; values never enter prepared SQL text', async () => {
  const fake = fakeWriter();
  const result = await fake.writer.createExtension({ extension: '101', endpointId: '101-t1', context: 'tenant-one', displayName: "O'Brien" });
  assert.match(result.sipSecret, /^[A-Za-z0-9_-]{43}$/);
  const insert = fake.calls.find(call => call.sql.startsWith('INSERT INTO ps_auths'))!;
  assert.equal(insert.values[3], result.sipSecret);
  assert.equal(fake.calls.some(call => call.sql.includes(result.sipSecret) || call.sql.includes("O'Brien")), false);
  assert.deepEqual(fake.status(), { committed: 1, rolledBack: 0, released: 1 });
});

test('writer refuses values that exceed installed Asterisk columns before opening a transaction', async () => {
  for (const input of [
    { extension: '101', endpointId: '101-t1', context: 'c'.repeat(41) },
    { extension: '101', endpointId: '101-t1', context: 'tenant-one', displayName: 'x'.repeat(25), callerIdNumber: '+19496501147' },
  ]) {
    const fake = fakeWriter();
    await assert.rejects(fake.writer.createExtension(input), ValidationError);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(fake.status(), { committed: 0, rolledBack: 0, released: 0 });
  }
});

test('duplicate and commit failures roll back and discard complete upstream SQL and SIP secrets', async () => {
  for (const errno of [1062, 1105]) {
    const secret = 'upstream-secret-that-must-not-escape';
    const failure = Object.assign(new Error(`INSERT failed password=${secret}`), { errno, sql: `INSERT ${secret}` });
    const fake = errno === 1062 ? fakeWriter(call => {
      if (call.sql.startsWith('INSERT INTO ps_endpoints')) throw failure;
    }) : fakeWriter(undefined, failure);
    await assert.rejects(fake.writer.createExtension({ extension: '101', endpointId: '101-t1', context: 'tenant-one' }), error => {
      assert.ok(errno === 1062 ? error instanceof ConflictError : error instanceof DependencyUnavailableError);
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal('cause' in (error as Error), false);
      return true;
    });
    assert.deepEqual(fake.status(), { committed: 0, rolledBack: 1, released: 1 });
  }
});

test('connection failures are redacted before the HTTP logger sees them', async () => {
  const pool = { getConnection: async () => { throw new Error('password=database-secret'); } } as unknown as mysql.Pool;
  const writer = new MysqlPbxProvisioner(config, pool);
  await assert.rejects(writer.createExtension({ extension: '101', endpointId: '101-t1', context: 'tenant-one' }), error => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.equal(error.message, 'PBX provisioning database operation failed');
    return true;
  });
});

test('a native queue name prefix and a forged marker cannot authorize deletion', async () => {
  for (const marker of [[], [{ priority: 1, app: 'NoOp', appdata: 'OfficePulse:queue:v1:t1.other' }], [
    { priority: 1, app: 'NoOp', appdata: 'OfficePulse:queue:v1:t1.front' },
    { priority: 2, app: 'Dial', appdata: 'PJSIP/manual' },
  ]]) {
    const fake = fakeWriter(call => {
      if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 't1.front' }];
      if (call.sql.startsWith('SELECT priority')) return marker;
    });
    await assert.rejects(fake.writer.deleteQueue('t1.front', scope), NotFoundError);
    assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE')), false);
    assert.deepEqual(fake.status(), { committed: 0, rolledBack: 1, released: 1 });
  }
});

test('manual DID rows are never replaced or deleted even when the queue is approved', async () => {
  for (const operation of ['set', 'delete']) {
    const fake = fakeWriter(call => {
      if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'concierge' }];
      if (call.sql.startsWith('SELECT priority')) return [{ priority: 1, app: 'Dial', appdata: 'PJSIP/operator' }];
    });
    const did = scope.didNumbers[0]!;
    const pending = operation === 'set'
      ? fake.writer.setDid(scope.didContext, did, 'concierge', didDialplanRows(did, { queue: 'concierge', ringsBeforeAi: 2 }), { ...scope, queueNames: ['concierge'] })
      : fake.writer.deleteDid(scope.didContext, did);
    await assert.rejects(pending, ConflictError);
    assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE') || call.sql.startsWith('INSERT')), false);
  }
});

test('a DID reference blocks queue and member deletion atomically', async () => {
  const fake = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'concierge' }];
    if (call.sql.startsWith('SELECT exten FROM extensions')) return [{ exten: '+15555550101' }];
  });
  await assert.rejects(fake.writer.deleteQueue('concierge', { ...scope, queueNames: ['concierge'] }), ConflictError);
  assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE')), false);
  assert.deepEqual(fake.status(), { committed: 0, rolledBack: 1, released: 1 });
});

test('DID reads refuse truncation and do not read auth columns', async () => {
  const fake = fakeWriter(() => Array.from({ length: 1001 }, () => ({ exten: '+15555550101', priority: 1, app: 'NoOp', appdata: 'manual' })));
  await assert.rejects(fake.writer.listDids(scope.didContext, scope.didNumbers), DependencyUnavailableError);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.sql, /LIMIT 1001/);
  assert.doesNotMatch(fake.calls[0]!.sql, /password|ps_auths/);
});
