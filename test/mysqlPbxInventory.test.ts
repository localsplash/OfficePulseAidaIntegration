import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { mysqlPbxInventory } from '../src/pbx/inventory.js';
import { adoptQueueStatement } from '../src/pbx/adoptQueueCli.js';

const url = process.env.TEST_PBX_MYSQL_URL;
test('MySQL PBX inventory uses only SELECT grants and isolates exact, case-sensitive contexts', { skip: !url }, async () => {
  const parsed = new URL(url!);
  const database = parsed.pathname.slice(1);
  assert.match(database, /^aida_pbx_inventory_[a-z0-9_]+_test$/);
  const config = { host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password), database };
  const setup = await mysql.createConnection({ ...config, database: undefined });
  let inventory: ReturnType<typeof mysqlPbxInventory> | undefined;
  let restricted: mysql.Connection | undefined;
  try {
    await setup.query(`CREATE DATABASE \`${database}\``);
    await setup.query(`USE \`${database}\``);
    // Disposable fixtures match the selected vendor columns; this is never an application migration.
    await setup.query('CREATE TABLE ps_endpoints (id VARCHAR(80), context VARCHAR(80), callerid VARCHAR(80), transport VARCHAR(80), aors VARCHAR(80))');
    await setup.query('CREATE TABLE ps_auths (id VARCHAR(80), password VARCHAR(80))');
    await setup.query('CREATE TABLE extensions (id BIGINT AUTO_INCREMENT PRIMARY KEY, context VARCHAR(40) NOT NULL, exten VARCHAR(40) NOT NULL, priority INT NOT NULL, app VARCHAR(40), appdata VARCHAR(256))');
    await setup.query('CREATE TABLE queues (name VARCHAR(128), strategy VARCHAR(80))');
    await setup.query('CREATE TABLE queue_members (queue_name VARCHAR(80), interface VARCHAR(80), membername VARCHAR(80), penalty INT, paused INT)');
    await setup.query("INSERT INTO ps_endpoints VALUES ('101-Tenant-A','Tenant-A','Alice',NULL,'101-Tenant-A'),('201','tenant-a','Other tenant',NULL,'201'),('301-t3','Tenant-B','Bob',NULL,'301-t3')");
    await setup.query("INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ('Tenant-A','101',1,'Dial','PJSIP/101-Tenant-A,20'),('Tenant-A','101',2,'Hangup',''),('from-carrier','+15555550101',1,'NoOp','manual')");
    // Legacy queue adoption goes through the reviewed CLI statement; a second marker elsewhere makes support-b ambiguous.
    await setup.query(adoptQueueStatement('Tenant-A', 'support-a'));
    await setup.query(adoptQueueStatement('Tenant-A', 'support-b'));
    await setup.query(adoptQueueStatement('Tenant-B', 'support-b'));
    await setup.query("INSERT INTO queues VALUES ('support-a','rrmemory'),('support-b','ringall')");
    await setup.query("INSERT INTO queue_members VALUES ('support-a','Local/101@Tenant-A','Alice',2,1),('support-b','PJSIP/301-t3','Bob',0,0)");
    await setup.query("CREATE USER 'pbx_inventory_test_ro'@'%' IDENTIFIED BY 'disposable-test-password'");
    for (const table of ['ps_endpoints', 'queues', 'queue_members', 'extensions']) {
      await setup.query(`GRANT SELECT ON \`${database}\`.${table} TO 'pbx_inventory_test_ro'@'%'`);
    }
    const readConfig = { ...config, user: 'pbx_inventory_test_ro', password: 'disposable-test-password' };
    inventory = mysqlPbxInventory(readConfig);
    restricted = await mysql.createConnection(readConfig);
    assert.deepEqual(await inventory.reader.contexts(), ['Tenant-A', 'Tenant-B', 'from-carrier', 'tenant-a']);
    assert.deepEqual(await inventory.reader.extensions('Tenant-A'), [{ id: '101-Tenant-A', extension: '101', context: 'Tenant-A', callerId: 'Alice', transport: null, aors: '101-Tenant-A', managed: true }]);
    assert.deepEqual(await inventory.reader.extensions('Tenant-B'), [{ id: '301-t3', extension: '301', context: 'Tenant-B', callerId: 'Bob', transport: null, aors: '301-t3', managed: false }]);
    assert.deepEqual(await inventory.reader.queues('Tenant-A'), [{ id: 'support-a', name: 'support-a', strategy: 'rrmemory', members: [
      { interface: 'Local/101@Tenant-A', memberName: 'Alice', penalty: 2, paused: true },
    ] }]);
    assert.deepEqual(await inventory.reader.queues('Tenant-B'), [], 'an ambiguous marker owns nothing');
    assert.deepEqual(await inventory.reader.queues('tenant-a'), [], 'case variants are different contexts');
    await assert.rejects(restricted.query('SELECT password FROM ps_auths'), /denied/);
    await assert.rejects(restricted.query("UPDATE ps_endpoints SET callerid='changed'"), /denied/);
  } finally {
    await inventory?.close();
    await restricted?.end();
    await setup.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await setup.query("DROP USER IF EXISTS 'pbx_inventory_test_ro'@'%'");
    await setup.end();
  }
});
