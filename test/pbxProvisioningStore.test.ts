import { test } from 'node:test';
import assert from 'node:assert/strict';
import type mysql from 'mysql2/promise';
import { MysqlPbxProvisioner } from '../src/pbx/provisioningStore.js';
import { queueMarkerData, queueMarkerExten } from '../src/pbx/queueOwnership.js';
import { ConflictError, DependencyUnavailableError, NotFoundError, ValidationError } from '../src/errors.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';

const config = { host: 'unused', port: 3306, database: 'unused', user: 'unused', password: 'unused' };
const CTX = 'tenant-one'; const INBOUND = 'inbound-one'; const DID = '+15555550101';
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
const dialRows = (id: string) => [{ priority: 1, app: 'Dial', appdata: `PJSIP/${id},20` }, { priority: 2, app: 'Hangup', appdata: '' }];
const isMarkerLookup = (call: Call) => call.sql.startsWith('SELECT context FROM extensions');

test('writer returns a strong SIP secret only after commit; values never enter prepared SQL text', async () => {
  const fake = fakeWriter();
  const result = await fake.writer.createExtension({ extension: '101', endpointId: '101-tenant-one', context: CTX, displayName: "O'Brien" });
  assert.match(result.sipSecret, /^[A-Za-z0-9_-]{43}$/);
  const insert = fake.calls.find(call => call.sql.startsWith('INSERT INTO ps_auths'))!;
  assert.equal(insert.values[3], result.sipSecret);
  assert.equal(fake.calls.some(call => call.sql.includes(result.sipSecret) || call.sql.includes("O'Brien")), false);
  assert.deepEqual(fake.status(), { committed: 1, rolledBack: 0, released: 1 });
});

test('writer refuses values that exceed installed Asterisk columns before opening a transaction', async () => {
  for (const input of [
    { extension: '101', endpointId: '101-tenant-one', context: 'c'.repeat(41) },
    { extension: '101', endpointId: '101-' + 'c'.repeat(37), context: CTX },
    { extension: '101', endpointId: '101-tenant-one', context: CTX, displayName: 'x'.repeat(25), callerIdNumber: '+19496501147' },
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
    await assert.rejects(fake.writer.createExtension({ extension: '101', endpointId: '101-tenant-one', context: CTX }), error => {
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
  await assert.rejects(writer.createExtension({ extension: '101', endpointId: '101-tenant-one', context: CTX }), error => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.equal(error.message, 'PBX provisioning database operation failed');
    return true;
  });
});

test('extension deletion resolves the endpoint from the managed Dial route, so legacy -tN bundles keep working and absent routes are 404', async () => {
  const fake = fakeWriter(call => {
    if (call.sql.startsWith('SELECT priority, app, appdata FROM extensions')) return call.values[0] === CTX && call.values[1] === '101' ? dialRows('101-t1') : [];
    if (call.sql.startsWith('SELECT id, context, auth, aors FROM ps_endpoints')) { assert.deepEqual(call.values, ['101-t1', CTX]); return [{ id: '101-t1', context: CTX, auth: '101-t1', aors: '101-t1' }]; }
  });
  await fake.writer.deleteExtension('101', CTX);
  assert.deepEqual(fake.calls.filter(call => call.sql.startsWith('DELETE')).map(call => call.values),
    [['PJSIP/101-t1', 'Local/101@tenant-one'], [CTX, '101'], ['101-t1'], ['101-t1'], ['101-t1']]);
  assert.deepEqual(fake.status(), { committed: 1, rolledBack: 0, released: 1 });
  // Another context's route, or no route, is the same 404: the extension number alone never identifies an endpoint.
  const absent = fakeWriter(call => { if (call.sql.startsWith('SELECT priority')) return []; });
  await assert.rejects(absent.writer.deleteExtension('101', 'tenant-two'), error => error instanceof NotFoundError && error.message === 'Extension was not found in this context');
  assert.equal(absent.calls.some(call => call.sql.startsWith('DELETE')), false);
  const manual = fakeWriter(call => { if (call.sql.startsWith('SELECT priority')) return [{ priority: 1, app: 'Dial', appdata: 'PJSIP/101-t1&PJSIP/other,20' }]; });
  await assert.rejects(manual.writer.deleteExtension('101', CTX), NotFoundError);
  // Extra rows behind a managed Dial row make the route unmanaged: refused, never partially deleted.
  const extended = fakeWriter(call => {
    if (call.sql.startsWith('SELECT priority')) return [...dialRows('101-t1'), { priority: 3, app: 'Voicemail', appdata: '101' }];
    if (call.sql.startsWith('SELECT id, context, auth, aors')) return [{ id: '101-t1', context: CTX, auth: '101-t1', aors: '101-t1' }];
  });
  await assert.rejects(extended.writer.deleteExtension('101', CTX), ConflictError);
  assert.equal(extended.calls.some(call => call.sql.startsWith('DELETE')), false);
});

test('queue membership resolves the endpoint from the context route and refuses queues the context does not own', async () => {
  const member = { queue: 'tenant-one.front', extension: '101', context: CTX, penalty: 8, paused: true };
  const fake = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'tenant-one.front' }];
    if (isMarkerLookup(call)) return [{ context: CTX }];
    if (call.sql.startsWith('SELECT priority')) return dialRows('101-tenant-one');
    if (call.sql.startsWith('SELECT id, context, auth, aors')) return [{ id: '101-tenant-one', context: CTX, auth: '101-tenant-one', aors: '101-tenant-one' }];
  });
  await fake.writer.setQueueMember(member);
  assert.deepEqual(fake.calls.filter(call => /^(DELETE|INSERT)/.test(call.sql)).map(call => call.values),
    [['tenant-one.front', 'PJSIP/101-tenant-one'], ['tenant-one.front', 'PJSIP/101-tenant-one', '101', 8, 1]]);
  await fake.writer.deleteQueueMember('tenant-one.front', '101', CTX);
  const foreign = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'tenant-one.front' }];
    if (isMarkerLookup(call)) return [{ context: 'tenant-two' }];
  });
  await assert.rejects(foreign.writer.setQueueMember(member), error => error instanceof NotFoundError && error.message === 'Queue was not found in this context');
  const gone = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'tenant-one.front' }];
    if (isMarkerLookup(call)) return [{ context: CTX }];
    if (call.sql.startsWith('SELECT priority')) return dialRows('101-tenant-one');
    if (call.sql.startsWith('SELECT id, context, auth, aors')) return [{ id: '101-tenant-one', context: CTX }];
    if (call.sql.startsWith('DELETE FROM queue_members')) return { affectedRows: 0 };
  });
  await assert.rejects(gone.writer.deleteQueueMember('tenant-one.front', '101', CTX), error => error instanceof NotFoundError && error.message === 'Queue membership was not found in this context');
});

test('queue creation namespaces a slug by context, reuses an owned legacy name, and refuses ambiguous or oversized ids', async () => {
  const created = fakeWriter(call => { if (isMarkerLookup(call)) return []; });
  assert.deepEqual(await created.writer.createQueue({ name: 'front', strategy: 'ringall' }, CTX), { name: 'tenant-one.front' });
  assert.deepEqual(created.calls.filter(call => call.sql.startsWith('INSERT')).map(call => call.values),
    [['tenant-one.front', 'ringall'], [CTX, queueMarkerExten('tenant-one.front'), 1, 'NoOp', queueMarkerData('tenant-one.front')]]);
  const legacy = fakeWriter(call => { if (isMarkerLookup(call) && call.values[1] === queueMarkerData('concierge')) return [{ context: CTX }]; });
  assert.deepEqual(await legacy.writer.createQueue({ name: 'concierge', strategy: 'rrmemory' }, CTX), { name: 'concierge' });
  assert.deepEqual(legacy.calls.filter(call => call.sql.startsWith('INSERT')).map(call => call.values), [['concierge', 'rrmemory']]);
  // A legacy name owned by another context is namespaced rather than hijacked.
  const foreign = fakeWriter(call => { if (isMarkerLookup(call) && call.values[1] === queueMarkerData('concierge')) return [{ context: 'tenant-two' }]; });
  assert.deepEqual(await foreign.writer.createQueue({ name: 'concierge', strategy: 'ringall' }, CTX), { name: 'tenant-one.concierge' });
  await assert.rejects(fakeWriter(call => { if (isMarkerLookup(call)) return []; }).writer.createQueue({ name: 'x'.repeat(61), strategy: 'ringall' }, CTX), ValidationError);
  await assert.rejects(fakeWriter(call => { if (isMarkerLookup(call)) return []; }).writer.createQueue({ name: 'x'.repeat(40), strategy: 'ringall' }, 'c'.repeat(40)), ValidationError);
  // A marker for the generated id in any other context would make ownership ambiguous.
  const ambiguous = fakeWriter(call => { if (isMarkerLookup(call) && call.values[1] === queueMarkerData('tenant-one.front')) return [{ context: 'tenant-two' }]; });
  await assert.rejects(ambiguous.writer.createQueue({ name: 'front', strategy: 'ringall' }, CTX), ConflictError);
  assert.equal(ambiguous.calls.some(call => call.sql.startsWith('INSERT INTO extensions')), false);
  assert.deepEqual(ambiguous.status(), { committed: 0, rolledBack: 1, released: 1 });
});

test('a native name prefix, a forged marker, or a marker duplicated in another context cannot authorize queue deletion', async () => {
  for (const owners of [[], [{ context: 'tenant-two' }], [{ context: CTX }, { context: 'tenant-two' }]]) {
    const fake = fakeWriter(call => {
      if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'tenant-one.front' }];
      if (isMarkerLookup(call)) return owners;
    });
    await assert.rejects(fake.writer.deleteQueue('tenant-one.front', CTX), error => error instanceof NotFoundError && error.message === 'Queue was not found in this context');
    assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE')), false);
    assert.deepEqual(fake.status(), { committed: 0, rolledBack: 1, released: 1 });
  }
  // The lookup is exact: hashed exten plus versioned appdata, locked for the transaction, at most two rows read.
  const owned = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'tenant-one.front' }];
    if (isMarkerLookup(call)) { assert.deepEqual(call.values, [queueMarkerExten('tenant-one.front'), queueMarkerData('tenant-one.front')]); assert.match(call.sql, /LIMIT 2 FOR UPDATE$/); return [{ context: CTX }]; }
  });
  await owned.writer.deleteQueue('tenant-one.front', CTX);
  assert.deepEqual(owned.calls.filter(call => call.sql.startsWith('DELETE')).map(call => call.values),
    [['tenant-one.front'], ['tenant-one.front'], [CTX, queueMarkerExten('tenant-one.front'), 1, 'NoOp', queueMarkerData('tenant-one.front')]]);
});

test('manual, foreign and absent DID rows are never replaced or deleted even when the queue is owned', async () => {
  const rows = didDialplanRows(DID, { queue: 'concierge', ringsBeforeAi: 2 });
  const cases: [string, unknown[], typeof ConflictError | typeof NotFoundError][] = [
    ['manual', [{ priority: 1, app: 'Dial', appdata: 'PJSIP/operator' }], ConflictError],
    ['foreign', didDialplanRows(DID, { queue: 'tenant-two.sales', ringsBeforeAi: 2 }), ConflictError],
    ['absent', [], NotFoundError],
  ];
  for (const [name, existing, expected] of cases) for (const operation of ['set', 'delete'] as const) {
    if (name === 'absent' && operation === 'set') continue; // absent rows are exactly what setDid creates
    const fake = fakeWriter(call => {
      if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: call.values[0] }];
      if (isMarkerLookup(call)) return [{ context: call.values[1] === queueMarkerData('concierge') ? CTX : 'tenant-two' }];
      if (call.sql.startsWith('SELECT priority')) return existing;
    });
    const pending = operation === 'set' ? fake.writer.setDid(INBOUND, DID, 'concierge', rows, CTX) : fake.writer.deleteDid(INBOUND, DID, CTX);
    await assert.rejects(pending, expected, `${name} ${operation}`);
    assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE') || call.sql.startsWith('INSERT')), false, `${name} ${operation}`);
  }
  // A route owned by this context is replaced atomically inside the ingress context, then deletable.
  const owned = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'concierge' }];
    if (isMarkerLookup(call)) return [{ context: CTX }];
    if (call.sql.startsWith('SELECT priority')) { assert.equal(call.values[0], INBOUND); return rows; }
  });
  await owned.writer.setDid(INBOUND, DID, 'concierge', rows, CTX);
  assert.deepEqual(owned.calls.filter(call => call.sql.startsWith('DELETE')).map(call => call.values), [[INBOUND, DID]]);
  assert.equal(owned.calls.filter(call => call.sql.startsWith('INSERT INTO extensions')).length, 3);
  await owned.writer.deleteDid(INBOUND, DID, CTX);
  assert.deepEqual(owned.status(), { committed: 2, rolledBack: 0, released: 2 });
});

test('a DID reference blocks queue and member deletion atomically', async () => {
  const fake = fakeWriter(call => {
    if (call.sql.startsWith('SELECT name FROM queues')) return [{ name: 'concierge' }];
    if (isMarkerLookup(call)) return [{ context: CTX }];
    if (call.sql.startsWith('SELECT exten FROM extensions')) return [{ exten: DID }];
  });
  await assert.rejects(fake.writer.deleteQueue('concierge', CTX), ConflictError);
  assert.equal(fake.calls.some(call => call.sql.startsWith('DELETE')), false);
  assert.deepEqual(fake.status(), { committed: 0, rolledBack: 1, released: 1 });
});

test('owned queues are the exact markers of one context minus any duplicated elsewhere; driver errors are redacted', async () => {
  const fake = fakeWriter(call => {
    if (call.sql.includes("LEFT(exten, 13) = '__aida_queue_'")) { assert.deepEqual(call.values, [CTX]); return [{ exten: queueMarkerExten('a'), appdata: queueMarkerData('a') }, { exten: queueMarkerExten('b'), appdata: queueMarkerData('b') }]; }
    if (call.sql.startsWith('SELECT context, exten, appdata')) return [{ context: CTX, exten: queueMarkerExten('a'), appdata: queueMarkerData('a') },
      { context: CTX, exten: queueMarkerExten('b'), appdata: queueMarkerData('b') }, { context: 'tenant-two', exten: queueMarkerExten('b'), appdata: queueMarkerData('b') }];
  });
  assert.deepEqual(await fake.writer.ownedQueues(CTX), ['a']);
  const broken = new MysqlPbxProvisioner(config, { execute: async () => { throw Object.assign(new Error('password=secret'), { errno: 1045 }); } } as unknown as mysql.Pool);
  await assert.rejects(broken.ownedQueues(CTX), error => error instanceof DependencyUnavailableError && !String(error).includes('secret'));
});

test('DID reads refuse truncation and do not read auth columns', async () => {
  const fake = fakeWriter(() => Array.from({ length: 1001 }, () => ({ exten: DID, priority: 1, app: 'NoOp', appdata: 'manual' })));
  await assert.rejects(fake.writer.listDids(INBOUND, [DID]), DependencyUnavailableError);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.sql, /LIMIT 1001/);
  assert.doesNotMatch(fake.calls[0]!.sql, /password|ps_auths/);
});
