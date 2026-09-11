import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { PbxInventoryReader } from '../src/pbx/inventory.js';
import { queueMarkerExten } from '../src/pbx/queueOwnership.js';
import { MysqlPbxProvisioner } from '../src/pbx/provisioningStore.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

const url = process.env.TEST_PBX_PROVISIONING_MYSQL_URL;
test('disposable MySQL PBX writer: exact grants, atomicity, ownership and concurrent references', { skip: !url }, async t => {
  const parsed = new URL(url!);
  const database = parsed.pathname.slice(1);
  // Check before connecting or doing any DDL; never reuse an existing schema.
  assert.match(database, /^aida_pbx_provisioning_[a-z0-9_]+_test$/);
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password), database };
  const setup = await mysql.createConnection({ ...config, database: undefined });
  const user = `pbx_writer_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  let created = false;
  let userCreated = false;
  let writer: MysqlPbxProvisioner | undefined;
  let restricted: mysql.Connection | undefined;
  const scope = { contexts: ['tenant-one'], queueNames: ['concierge'], didContext: 'inbound-one', didNumbers: ['+15555550101', '+15555550102'] };
  const other = { contexts: ['tenant-two'], queueNames: [], didContext: 'inbound-two', didNumbers: ['+15555550201'] };
  const count = async (table: string, clause: string, values: string[] = []) => {
    // table/clause are test-authored constants, never request data.
    const [rows] = await setup.execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${clause}`, values);
    return Number(rows[0]!.n);
  };
  try {
    await setup.query(`CREATE DATABASE \`${database}\``);
    created = true;
    await setup.query(`USE \`${database}\``);
    // Representative Asterisk Realtime shapes; fixtures are never application migrations.
    await setup.query('CREATE TABLE ps_aors (id VARCHAR(80) PRIMARY KEY, max_contacts INT, remove_existing VARCHAR(3)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE ps_auths (id VARCHAR(80) PRIMARY KEY, auth_type VARCHAR(20), username VARCHAR(80), password VARCHAR(80)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE ps_endpoints (id VARCHAR(80) PRIMARY KEY, transport VARCHAR(40), aors VARCHAR(200), auth VARCHAR(200), outbound_auth VARCHAR(200), context VARCHAR(80), disallow VARCHAR(200), allow VARCHAR(200), callerid VARCHAR(40)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await setup.query('CREATE TABLE extensions (id BIGINT AUTO_INCREMENT PRIMARY KEY, context VARCHAR(80) NOT NULL, exten VARCHAR(40) NOT NULL, priority INT NOT NULL, app VARCHAR(40), appdata VARCHAR(256), UNIQUE KEY route (context, exten, priority)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await setup.query('CREATE TABLE queues (name VARCHAR(128) PRIMARY KEY, strategy VARCHAR(20)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE queue_members (uniqueid INT AUTO_INCREMENT PRIMARY KEY, queue_name VARCHAR(80), interface VARCHAR(80), membername VARCHAR(80), state_interface VARCHAR(80), penalty INT, paused INT, UNIQUE KEY member (queue_name, interface)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE unrelated_private_data (secret VARCHAR(80)) ENGINE=InnoDB');
    const migration = (await readFile(new URL('../deploy/sql/pbx-provisioning-schema.sql', import.meta.url), 'utf8'))
      .replace(/^--.*$/gm, '')
      .replaceAll("'asterisk'", `'${database}'`)
      .replaceAll('asterisk.', `\`${database}\`.`);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await setup.query(statement);
    }
    const [widened] = await setup.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME,COLUMN_NAME,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND ((TABLE_NAME='extensions' AND COLUMN_NAME='exten') OR (TABLE_NAME='ps_endpoints' AND COLUMN_NAME='callerid')) ORDER BY TABLE_NAME",
      [database],
    );
    assert.deepEqual(widened.map(row => [row.TABLE_NAME, row.COLUMN_NAME, Number(row.CHARACTER_MAXIMUM_LENGTH), row.IS_NULLABLE]), [
      ['extensions', 'exten', 80, 'NO'],
      ['ps_endpoints', 'callerid', 80, 'YES'],
    ]);
    const script = (await readFile(new URL('../deploy/sql/pbx-provisioning-grants.sql', import.meta.url), 'utf8'))
      .replace(/^--.*$/gm, '').replaceAll("'aida_pbx_provisioner'", `'${user}'`)
      .replaceAll('__OFFICEPULSE_API_IP__', '%').replaceAll('__STRONG_PASSWORD__', password)
      .replaceAll('asterisk.', `\`${database}\`.`);
    for (const statement of script.split(';').map(s => s.trim()).filter(Boolean)) {
      await setup.query(statement);
      if (statement.startsWith('CREATE USER')) userCreated = true;
    }
    const writeConfig = { ...config, user, password };
    writer = new MysqlPbxProvisioner(writeConfig);
    restricted = await mysql.createConnection(writeConfig);
    const pbx = writer;

    await t.test('the shipped grants allow only the six tables and never existing SIP password reads', async () => {
      assert.equal(await pbx.ping(), true);
      await assert.rejects(restricted!.execute('SELECT password FROM ps_auths'), /denied/i);
      await assert.rejects(restricted!.execute('SELECT secret FROM unrelated_private_data'), /denied/i);
      await assert.rejects(restricted!.execute('UPDATE queues SET strategy = ?', ['random']), /denied/i);
      await assert.rejects(restricted!.execute('CREATE TABLE forbidden (id INT)'), /denied/i);
    });
    await t.test('two tenants reuse dialable numbers, receive unique secrets and preserve manual routes', async () => {
      const first = await pbx.createExtension({ extension: '101', endpointId: '101-t1', context: scope.contexts[0]!, displayName: 'Alice' });
      const second = await pbx.createExtension({ extension: '101', endpointId: '101-t2', context: other.contexts[0]! });
      assert.match(first.sipSecret, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(first.sipSecret, second.sipSecret);
      assert.notEqual(first.sipUsername, second.sipUsername);
      await assert.rejects(pbx.createExtension({ extension: '101', endpointId: '101-t1', context: scope.contexts[0]! }), ConflictError);
      await assert.rejects(pbx.deleteExtension('101', '101-t1', other.contexts), NotFoundError);
      await setup.execute('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES (?,?,?,?,?)', [scope.contexts[0]!, '102', 1, 'NoOp', 'Operator owned']);
      await assert.rejects(pbx.createExtension({ extension: '102', endpointId: '102-t1', context: scope.contexts[0]! }), ConflictError);
      assert.equal(await count('ps_aors', 'id = ?', ['102-t1']), 0);
      assert.equal(await count('extensions', 'exten = ? AND appdata = ?', ['102', 'Operator owned']), 1);
    });
    await t.test('late duplicate rolls back AOR/auth inserts and redacts database detail', async () => {
      await setup.execute('INSERT INTO ps_endpoints (id,context) VALUES (?,?)', ['103-t1', scope.contexts[0]!]);
      await assert.rejects(pbx.createExtension({ extension: '103', endpointId: '103-t1', context: scope.contexts[0]! }), error => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.message, 'The PBX object already exists');
        assert.equal('sql' in error, false);
        return true;
      });
      assert.equal(await count('ps_aors', 'id = ?', ['103-t1']), 0);
      assert.equal(await count('ps_auths', 'id = ?', ['103-t1']), 0);
      assert.equal(await count('extensions', 'exten = ?', ['103']), 0);
    });
    await t.test('native queue ownership requires exact approval or an exact marker; membership is idempotent', async () => {
      await pbx.createQueue({ name: 't1.front', strategy: 'ringall' }, scope);
      await pbx.createQueue({ name: 't2.front', strategy: 'rrmemory' }, other);
      const longName = 't9007199254740991.' + 'x'.repeat(60);
      await pbx.createQueue({ name: longName, strategy: 'ringall' }, scope);
      const reader = new PbxInventoryReader(async (sql, values) => {
        const [rows] = await restricted!.execute<mysql.RowDataPacket[]>(sql, values);
        return rows;
      }, true);
      assert.ok((await reader.queues(scope)).some(queue => queue.id === longName));
      assert.equal((await reader.queues(other)).some(queue => queue.id === longName), false);
      await pbx.deleteQueue(longName, scope);

      await setup.execute('INSERT INTO queues (name,strategy) VALUES (?,?), (?,?)', ['concierge', 'ringall', 't1.impostor', 'ringall']);
      await assert.rejects(pbx.deleteQueue('t1.impostor', scope), NotFoundError);
      await assert.rejects(pbx.deleteQueue('t1.front', other), NotFoundError);
      await assert.rejects(pbx.deleteQueue('missing', scope), NotFoundError);
      await assert.rejects(pbx.createQueue({ name: 't1.front', strategy: 'random' }, scope), ConflictError);
      const member = { queue: 't1.front', extension: '101', endpointId: '101-t1', context: scope.contexts[0]!, penalty: 0, paused: false };
      await pbx.setQueueMember(member, scope);
      await pbx.setQueueMember({ ...member, penalty: 8, paused: true }, scope);
      const [members] = await setup.execute<mysql.RowDataPacket[]>('SELECT penalty,paused FROM queue_members WHERE queue_name = ?', ['t1.front']);
      assert.deepEqual(members.map(row => ({ penalty: row.penalty, paused: row.paused })), [{ penalty: 8, paused: 1 }]);
      await assert.rejects(pbx.setQueueMember({ ...member, endpointId: '101-t2' }, scope), NotFoundError);
      await assert.rejects(pbx.deleteQueueMember('t1.front', '101', '101-t1', other), NotFoundError);
      await pbx.deleteQueueMember('t1.front', '101', '101-t1', scope);
      await assert.rejects(pbx.deleteQueueMember('t1.front', '101', '101-t1', scope), NotFoundError);
      await pbx.setQueueMember(member, scope);
      await pbx.deleteQueue('concierge', scope);
    });
    await t.test('DID replacement is managed-only and referenced queues cannot be removed', async () => {
      const did = scope.didNumbers[0]!;
      const rows = didDialplanRows(did, { queue: 't1.front', ringsBeforeAi: 3 });
      await pbx.setDid(scope.didContext, did, 't1.front', rows, scope);
      assert.deepEqual((await pbx.listDids(scope.didContext, scope.didNumbers))[0], { did, rows });
      await assert.rejects(pbx.deleteQueue('t1.front', scope), ConflictError);
      await assert.rejects(pbx.setDid(scope.didContext, did, 't2.front', didDialplanRows(did, { queue: 't2.front', ringsBeforeAi: 2 }), scope), NotFoundError);
      assert.deepEqual((await pbx.listDids(scope.didContext, [did]))[0]!.rows, rows);
      const manual = scope.didNumbers[1]!;
      await setup.execute('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES (?,?,?,?,?)', [scope.didContext, manual, 1, 'Dial', 'PJSIP/manual']);
      await assert.rejects(pbx.setDid(scope.didContext, manual, 't1.front', didDialplanRows(manual, { queue: 't1.front', ringsBeforeAi: 2 }), scope), ConflictError);
      await assert.rejects(pbx.deleteDid(scope.didContext, manual), ConflictError);
      await pbx.deleteDid(scope.didContext, did);
      await assert.rejects(pbx.deleteDid(scope.didContext, did), NotFoundError);
    });
    await t.test('queue deletion racing DID creation never commits a broken DID', async () => {
      const did = scope.didNumbers[0]!;
      for (let i = 0; i < 3; i++) {
        const queue = `t1.race${i}`;
        await pbx.createQueue({ name: queue, strategy: 'ringall' }, scope);
        const results = await Promise.allSettled([
          pbx.setDid(scope.didContext, did, queue, didDialplanRows(did, { queue, ringsBeforeAi: 2 }), scope),
          pbx.deleteQueue(queue, scope),
        ]);
        for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof ConflictError || result.reason instanceof NotFoundError);
        const routes = (await pbx.listDids(scope.didContext, [did]))[0]!.rows;
        const queueExists = await count('queues', 'name = ?', [queue]);
        if (routes.length) {
          assert.equal(queueExists, 1);
          await pbx.deleteDid(scope.didContext, did);
        }
        if (queueExists) await pbx.deleteQueue(queue, scope);
      }
    });
    await t.test('extension deletion rejects remaining references and only removes its own bundle', async () => {
      await setup.execute('INSERT INTO ps_endpoints (id,context,auth) VALUES (?,?,?)', ['manual-phone', other.contexts[0]!, 'unrelated,101-t1']);
      await assert.rejects(pbx.deleteExtension('101', '101-t1', scope.contexts), ConflictError);
      assert.equal(await count('queue_members', 'interface = ?', ['PJSIP/101-t1']), 1);
      await setup.execute('DELETE FROM ps_endpoints WHERE id = ?', ['manual-phone']);
      await pbx.deleteExtension('101', '101-t1', scope.contexts);
      for (const table of ['ps_endpoints', 'ps_auths', 'ps_aors']) {
        assert.equal(await count(table, 'id = ?', ['101-t1']), 0);
        assert.equal(await count(table, 'id = ?', ['101-t2']), 1);
      }
      assert.equal(await count('queue_members', 'interface = ?', ['PJSIP/101-t1']), 0);
      assert.equal(await count('extensions', 'context = ? AND exten = ?', [scope.contexts[0]!, '101']), 0);
      assert.equal(await count('extensions', 'context = ? AND exten = ?', [other.contexts[0]!, '101']), 2);
      await assert.rejects(pbx.deleteExtension('101', '101-t1', scope.contexts), NotFoundError);
      await pbx.deleteQueue('t1.front', scope);
      assert.equal(await count('extensions', 'exten = ?', [queueMarkerExten('t1.front')]), 0);
    });
  } finally {
    await writer?.close();
    await restricted?.end();
    if (created) await setup.query(`DROP DATABASE \`${database}\``);
    if (userCreated) await setup.query(`DROP USER '${user}'@'%'`);
    await setup.end();
  }
});
