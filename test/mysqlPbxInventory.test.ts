import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { mysqlPbxInventory } from '../src/pbx/inventory.js';

const url = process.env.TEST_PBX_MYSQL_URL;
test('MySQL PBX inventory uses only SELECT grants and isolates exact tenant scopes', { skip: !url }, async () => {
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
    await setup.query('CREATE TABLE queues (name VARCHAR(128), strategy VARCHAR(80))');
    await setup.query('CREATE TABLE queue_members (queue_name VARCHAR(80), interface VARCHAR(80), membername VARCHAR(80), penalty INT, paused INT)');
    await setup.query("INSERT INTO ps_endpoints VALUES ('101','Tenant-A','Alice',NULL,'101'),('201','tenant-a','Other tenant',NULL,'201'),('301','Tenant-B','Bob',NULL,'301')");
    await setup.query("INSERT INTO queues VALUES ('support-a','rrmemory'),('support-b','ringall')");
    await setup.query("INSERT INTO queue_members VALUES ('support-a','Local/101@Tenant-A','Alice',2,1),('support-b','PJSIP/301','Bob',0,0)");
    await setup.query("CREATE USER 'pbx_inventory_test_ro'@'%' IDENTIFIED BY 'disposable-test-password'");
    for (const table of ['ps_endpoints', 'queues', 'queue_members']) {
      await setup.query(`GRANT SELECT ON \`${database}\`.${table} TO 'pbx_inventory_test_ro'@'%'`);
    }
    const readConfig = { ...config, user: 'pbx_inventory_test_ro', password: 'disposable-test-password' };
    inventory = mysqlPbxInventory(readConfig);
    restricted = await mysql.createConnection(readConfig);
    const scope = { contexts: ['Tenant-A'], queueNames: ['support-a'] };
    assert.deepEqual(await inventory.reader.extensions(scope), [{ id: '101', context: 'Tenant-A', callerId: 'Alice', transport: null, aors: '101' }]);
    assert.deepEqual(await inventory.reader.queues(scope), [{ id: 'support-a', name: 'support-a', strategy: 'rrmemory', members: [
      { interface: 'Local/101@Tenant-A', memberName: 'Alice', penalty: 2, paused: true },
    ] }]);
    await assert.rejects(restricted.query('SELECT password FROM ps_auths'), /denied/);
    await assert.rejects(restricted.query("UPDATE ps_endpoints SET callerid='changed'"), /denied/);
    assert.deepEqual(await inventory.reader.queues({ contexts: [], queueNames: ['missing'] }), []);
  } finally {
    await inventory?.close();
    await restricted?.end();
    await setup.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await setup.query("DROP USER IF EXISTS 'pbx_inventory_test_ro'@'%'");
    await setup.end();
  }
});
