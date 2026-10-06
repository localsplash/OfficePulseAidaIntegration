import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { PbxInventoryReader } from '../src/pbx/inventory.js';
import { queueMarkerExten } from '../src/pbx/queueOwnership.js';
import { adoptQueueStatement } from '../src/pbx/adoptQueueCli.js';
import { MysqlPbxProvisioner } from '../src/pbx/provisioningStore.js';
import { didDialplanRows } from '../src/pbx/managedDid.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

const url = process.env.TEST_PBX_PROVISIONING_MYSQL_URL;
test('disposable MySQL PBX writer: exact grants, atomicity, context ownership and concurrent references', { skip: !url }, async t => {
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
  const one = 'tenant-one'; const two = 'tenant-two'; const inboundOne = 'inbound-one';
  const dids = ['+15555550101', '+15555550102'];
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
    await setup.query('CREATE TABLE ps_endpoints (id VARCHAR(80) PRIMARY KEY, transport VARCHAR(40), aors VARCHAR(200), auth VARCHAR(200), outbound_auth VARCHAR(200), context VARCHAR(40), disallow VARCHAR(200), allow VARCHAR(200), callerid VARCHAR(40)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await setup.query('CREATE TABLE extensions (id BIGINT AUTO_INCREMENT PRIMARY KEY, context VARCHAR(40) NOT NULL, exten VARCHAR(40) NOT NULL, priority INT NOT NULL, app VARCHAR(40), appdata VARCHAR(256), UNIQUE KEY route (context, exten, priority)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await setup.query('CREATE TABLE queues (name VARCHAR(128) PRIMARY KEY, strategy VARCHAR(20)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE queue_members (uniqueid INT AUTO_INCREMENT PRIMARY KEY, queue_name VARCHAR(80), interface VARCHAR(80), membername VARCHAR(80), state_interface VARCHAR(80), penalty INT, paused INT, UNIQUE KEY member (queue_name, interface)) ENGINE=InnoDB');
    await setup.query('CREATE TABLE unrelated_private_data (secret VARCHAR(80)) ENGINE=InnoDB');
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
    await t.test('two contexts reuse dialable numbers, receive unique secrets and preserve manual routes', async () => {
      const first = await pbx.createExtension({ extension: '101', endpointId: `101-${one}`, context: one, displayName: 'Alice' });
      const second = await pbx.createExtension({ extension: '101', endpointId: `101-${two}`, context: two });
      assert.match(first.sipSecret, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(first.sipSecret, second.sipSecret);
      assert.notEqual(first.sipUsername, second.sipUsername);
      await assert.rejects(pbx.createExtension({ extension: '101', endpointId: `101-${one}`, context: one }), ConflictError);
      // A legacy bundle keeps working because the endpoint is found through its own Dial row, never its id shape.
      await setup.execute('INSERT INTO ps_aors (id,max_contacts,remove_existing) VALUES (?,?,?)', ['102-t1', 1, 'yes']);
      await setup.execute('INSERT INTO ps_auths (id,auth_type,username,password) VALUES (?,?,?,?)', ['102-t1', 'userpass', '102-t1', 'legacy']);
      await setup.execute('INSERT INTO ps_endpoints (id,context,auth,aors) VALUES (?,?,?,?)', ['102-t1', one, '102-t1', '102-t1']);
      await setup.execute('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES (?,?,?,?,?),(?,?,?,?,?)', [one, '102', 1, 'Dial', 'PJSIP/102-t1,20', one, '102', 2, 'Hangup', '']);
      await assert.rejects(pbx.deleteExtension('102', two), NotFoundError);
      await pbx.deleteExtension('102', one);
      assert.equal(await count('ps_endpoints', 'id = ?', ['102-t1']), 0);
      await setup.execute('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES (?,?,?,?,?)', [one, '103', 1, 'NoOp', 'Operator owned']);
      await assert.rejects(pbx.createExtension({ extension: '103', endpointId: `103-${one}`, context: one }), ConflictError);
      assert.equal(await count('ps_aors', 'id = ?', [`103-${one}`]), 0);
      assert.equal(await count('extensions', 'exten = ? AND appdata = ?', ['103', 'Operator owned']), 1);
    });
    await t.test('late duplicate rolls back AOR/auth inserts and redacts database detail', async () => {
      await setup.execute('INSERT INTO ps_endpoints (id,context) VALUES (?,?)', [`104-${one}`, one]);
      await assert.rejects(pbx.createExtension({ extension: '104', endpointId: `104-${one}`, context: one }), error => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.message, 'The PBX object already exists');
        assert.equal('sql' in error, false);
        return true;
      });
      assert.equal(await count('ps_aors', 'id = ?', [`104-${one}`]), 0);
      assert.equal(await count('ps_auths', 'id = ?', [`104-${one}`]), 0);
      assert.equal(await count('extensions', 'exten = ?', ['104']), 0);
    });
    await t.test('queue ownership is an exact marker in one context; adoption, namespacing and idempotent membership', async () => {
      assert.deepEqual(await pbx.createQueue({ name: 'front', strategy: 'ringall' }, one), { name: `${one}.front` });
      assert.deepEqual(await pbx.createQueue({ name: 'front', strategy: 'rrmemory' }, two), { name: `${two}.front` });
      const slug = 'x'.repeat(60);
      assert.deepEqual(await pbx.createQueue({ name: slug, strategy: 'ringall' }, one), { name: `${one}.${slug}` });
      const reader = new PbxInventoryReader(async (sql, values) => {
        const [rows] = await restricted!.execute<mysql.RowDataPacket[]>(sql, values);
        return rows;
      });
      assert.ok((await reader.queues(one)).some(queue => queue.id === `${one}.${slug}`));
      assert.equal((await reader.queues(two)).some(queue => queue.id === `${one}.${slug}`), false);
      assert.deepEqual(await reader.contexts(), [one, two]);
      await pbx.deleteQueue(`${one}.${slug}`, one);

      // A legacy queue becomes owned only through the reviewed adoption marker; a duplicate marker makes it ambiguous.
      await setup.execute('INSERT INTO queues (name,strategy) VALUES (?,?), (?,?)', ['concierge', 'ringall', 'orphan', 'ringall']);
      await assert.rejects(pbx.deleteQueue('concierge', one), NotFoundError);
      await setup.query(adoptQueueStatement(one, 'concierge'));
      assert.deepEqual(await pbx.ownedQueues(one), [`${one}.front`, 'concierge'].sort((a, b) => queueMarkerExten(a) < queueMarkerExten(b) ? -1 : 1));
      await setup.query(adoptQueueStatement(two, 'concierge'));
      await assert.rejects(pbx.deleteQueue('concierge', one), NotFoundError);
      assert.deepEqual(await reader.queues(two), (await reader.queues(two)).filter(queue => queue.id !== 'concierge'));
      await setup.execute('DELETE FROM extensions WHERE context = ? AND exten = ?', [two, queueMarkerExten('concierge')]);
      await assert.rejects(pbx.deleteQueue('orphan', one), NotFoundError);
      await assert.rejects(pbx.deleteQueue(`${one}.front`, two), NotFoundError);
      await assert.rejects(pbx.deleteQueue('missing', one), NotFoundError);
      await assert.rejects(pbx.createQueue({ name: 'front', strategy: 'random' }, one), ConflictError);
      // Re-creating an adopted legacy queue reuses its exact name and marker.
      await setup.execute('DELETE FROM queues WHERE name = ?', ['concierge']);
      assert.deepEqual(await pbx.createQueue({ name: 'concierge', strategy: 'ringall' }, one), { name: 'concierge' });
      assert.equal(await count('extensions', 'exten = ?', [queueMarkerExten('concierge')]), 1);
      const member = { queue: `${one}.front`, extension: '101', context: one, penalty: 0, paused: false };
      await pbx.setQueueMember(member);
      await pbx.setQueueMember({ ...member, penalty: 8, paused: true });
      const [members] = await setup.execute<mysql.RowDataPacket[]>('SELECT interface,penalty,paused FROM queue_members WHERE queue_name = ?', [`${one}.front`]);
      assert.deepEqual(members.map(row => ({ interface: row.interface, penalty: row.penalty, paused: row.paused })), [{ interface: `PJSIP/101-${one}`, penalty: 8, paused: 1 }]);
      await assert.rejects(pbx.setQueueMember({ ...member, context: two }), NotFoundError);
      await assert.rejects(pbx.deleteQueueMember(`${one}.front`, '101', two), NotFoundError);
      await pbx.deleteQueueMember(`${one}.front`, '101', one);
      await assert.rejects(pbx.deleteQueueMember(`${one}.front`, '101', one), NotFoundError);
      await pbx.setQueueMember(member);
      await pbx.deleteQueue('concierge', one);
    });
    await t.test('DID replacement is managed-only and scoped; referenced queues cannot be removed', async () => {
      const did = dids[0]!;
      const rows = didDialplanRows(did, { queue: `${one}.front`, ringsBeforeAi: 3 });
      await pbx.setDid(inboundOne, did, `${one}.front`, rows, one);
      assert.deepEqual((await pbx.listDids(inboundOne, dids))[0], { did, rows });
      await assert.rejects(pbx.deleteQueue(`${one}.front`, one), ConflictError);
      await assert.rejects(pbx.setDid(inboundOne, did, `${two}.front`, didDialplanRows(did, { queue: `${two}.front`, ringsBeforeAi: 2 }), one), NotFoundError);
      // Another context may not overwrite or delete a route whose queue it does not own.
      await assert.rejects(pbx.setDid(inboundOne, did, `${two}.front`, didDialplanRows(did, { queue: `${two}.front`, ringsBeforeAi: 2 }), two), ConflictError);
      await assert.rejects(pbx.deleteDid(inboundOne, did, two), ConflictError);
      assert.deepEqual((await pbx.listDids(inboundOne, [did]))[0]!.rows, rows);
      const manual = dids[1]!;
      await setup.execute('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES (?,?,?,?,?)', [inboundOne, manual, 1, 'Dial', 'PJSIP/manual']);
      await assert.rejects(pbx.setDid(inboundOne, manual, `${one}.front`, didDialplanRows(manual, { queue: `${one}.front`, ringsBeforeAi: 2 }), one), ConflictError);
      await assert.rejects(pbx.deleteDid(inboundOne, manual, one), ConflictError);
      await pbx.deleteDid(inboundOne, did, one);
      await assert.rejects(pbx.deleteDid(inboundOne, did, one), NotFoundError);
    });
    await t.test('queue deletion racing DID creation never commits a broken DID', async () => {
      const did = dids[0]!;
      for (let i = 0; i < 3; i++) {
        const { name: queue } = await pbx.createQueue({ name: `race${i}`, strategy: 'ringall' }, one);
        const results = await Promise.allSettled([
          pbx.setDid(inboundOne, did, queue, didDialplanRows(did, { queue, ringsBeforeAi: 2 }), one),
          pbx.deleteQueue(queue, one),
        ]);
        for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof ConflictError || result.reason instanceof NotFoundError);
        const routes = (await pbx.listDids(inboundOne, [did]))[0]!.rows;
        const queueExists = await count('queues', 'name = ?', [queue]);
        if (routes.length) {
          assert.equal(queueExists, 1);
          await pbx.deleteDid(inboundOne, did, one);
        }
        if (queueExists) await pbx.deleteQueue(queue, one);
      }
    });
    await t.test('extension deletion rejects remaining references and only removes its own bundle', async () => {
      await setup.execute('INSERT INTO ps_endpoints (id,context,auth) VALUES (?,?,?)', ['manual-phone', two, `unrelated,101-${one}`]);
      await assert.rejects(pbx.deleteExtension('101', one), ConflictError);
      assert.equal(await count('queue_members', 'interface = ?', [`PJSIP/101-${one}`]), 1);
      await setup.execute('DELETE FROM ps_endpoints WHERE id = ?', ['manual-phone']);
      await pbx.deleteExtension('101', one);
      for (const table of ['ps_endpoints', 'ps_auths', 'ps_aors']) {
        assert.equal(await count(table, 'id = ?', [`101-${one}`]), 0);
        assert.equal(await count(table, 'id = ?', [`101-${two}`]), 1);
      }
      assert.equal(await count('queue_members', 'interface = ?', [`PJSIP/101-${one}`]), 0);
      assert.equal(await count('extensions', 'context = ? AND exten = ?', [one, '101']), 0);
      assert.equal(await count('extensions', 'context = ? AND exten = ?', [two, '101']), 2);
      await assert.rejects(pbx.deleteExtension('101', one), NotFoundError);
      await pbx.deleteQueue(`${one}.front`, one);
      assert.equal(await count('extensions', 'exten = ?', [queueMarkerExten(`${one}.front`)]), 0);
    });
  } finally {
    await writer?.close();
    await restricted?.end();
    if (created) await setup.query(`DROP DATABASE \`${database}\``);
    if (userCreated) await setup.query(`DROP USER '${user}'@'%'`);
    await setup.end();
  }
});
