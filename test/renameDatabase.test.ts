import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { migrateRuntime } from '../src/runtime/migrate.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/rename-database.sh', import.meta.url));

test('database rename validates every input before touching MySQL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aida-rename-db-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'called');
  await writeFile(join(root, 'mysql'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`,
    MYSQL_ADMIN_HOST: 'db.example.test', MYSQL_ADMIN_PASSWORD: 'admin-secret' };
  for (const change of [
    { FROM_DB: 'asterisk' }, { TO_DB: 'aida_%_test' }, { TO_DB: 'other_db' },
    { FROM_USER: 'bad-name' }, { TO_USER: 'root' }, { TO_USER: 'root', MYSQL_ADMIN_USER: 'admin' },
    { FROM_USER: 'admin', MYSQL_ADMIN_USER: 'admin' }, { MYSQL_ADMIN_PASSWORD: '' },
    { MYSQL_ADMIN_HOST: '' }, { MYSQL_ADMIN_PORT: '0' },
    { FROM_DB: 'aida_pbx_db', TO_DB: 'aida_pbx_db', FROM_USER: 'aida_pbx_app', TO_USER: 'aida_pbx_app' },
  ]) {
    await assert.rejects(exec('bash', [script], { env: { ...env, ...change } }), error => {
      assert.doesNotMatch((error as Error & { stderr: string }).stderr, /admin-secret/);
      return true;
    }, JSON.stringify(change));
    await assert.rejects(access(marker), `validation must precede every MySQL command: ${JSON.stringify(change)}`);
  }
});

const adminUrl = process.env.TEST_DB_USERS_MYSQL_URL;
test('disposable MySQL: rename moves tables and the account, keeps the password, reruns cleanly and rolls back', { skip: !adminUrl, timeout: 60_000 }, async t => {
  const url = new URL(adminUrl!);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const from = `aida_old_${suffix}_test`;
  const to = `aida_new_${suffix}_test`;
  const fromUser = `aida_o_${suffix}`;
  const toUser = `aida_n_${suffix}`;
  const password = "runtime'\\$password";
  const admin = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const connection = await mysql.createConnection(admin);
  t.after(async () => {
    for (const user of [fromUser, toUser]) await connection.query(`DROP USER IF EXISTS '${user}'@'%'`);
    for (const db of [from, to]) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await connection.end();
  });
  const rename = (env: NodeJS.ProcessEnv = {}) => exec('bash', [script], { env: { ...process.env,
    MYSQL_ADMIN_HOST: admin.host, MYSQL_ADMIN_PORT: String(admin.port), MYSQL_ADMIN_USER: admin.user, MYSQL_ADMIN_PASSWORD: admin.password,
    FROM_DB: from, TO_DB: to, FROM_USER: fromUser, TO_USER: toUser, ...env } });
  const grants = async (user: string) => (await connection.query<mysql.RowDataPacket[]>(`SHOW GRANTS FOR '${user}'@'%'`))[0].map(row => String(Object.values(row)[0])).sort();
  const tables = async (db: string) => (await connection.query<mysql.RowDataPacket[]>('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY 1', [db]))[0].map(row => String(row.t));

  await connection.query(`CREATE DATABASE \`${from}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`CREATE USER '${fromUser}'@'%' IDENTIFIED BY ?`, [password]);
  await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON \`${from.replaceAll('_', '\\_')}\`.* TO '${fromUser}'@'%'`);
  await migrateRuntime({ ...admin, user: fromUser, password, database: from });
  const before = await tables(from);
  assert.ok(before.length > 3, 'migrations created the runtime tables');
  const rows = async (db: string) => (await connection.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${db}\`.aida_tbl_SchemaMigration`))[0][0]?.n;
  const migrationRows = await rows(from);

  // Refuses while the old account is connected.
  const busy = await mysql.createConnection({ ...admin, user: fromUser, password, database: from });
  await assert.rejects(rename(), /stop the AidaPbx service first/);
  await busy.end();
  await new Promise(resolve => setTimeout(resolve, 200));

  const result = await rename();
  assert.match(result.stdout, new RegExp(`moved ${before.length} table`));
  assert.deepEqual(await tables(to), before);
  assert.deepEqual(await tables(from), []);
  assert.equal(await rows(to), migrationRows);
  const [schemas] = await connection.query<mysql.RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [from]);
  assert.equal(schemas.length, 0, 'the empty old database is dropped');
  const [oldUsers] = await connection.query<mysql.RowDataPacket[]>('SELECT User FROM mysql.user WHERE User=?', [fromUser]);
  assert.equal(oldUsers.length, 0);
  assert.deepEqual(await grants(toUser), [
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON \`${to.replaceAll('_', '\\_')}\`.* TO \`${toUser}\`@\`%\``,
    `GRANT USAGE ON *.* TO \`${toUser}\`@\`%\``,
  ].sort());
  // Same password, new names; the runtime can migrate (a no-op) and read its data.
  await migrateRuntime({ ...admin, user: toUser, password, database: to });
  const runtime = await mysql.createConnection({ ...admin, user: toUser, password, database: to });
  await runtime.query('SELECT COUNT(*) FROM aida_tbl_SchemaMigration');
  await runtime.end();

  // Rerun is a no-op.
  const again = await rename();
  assert.match(again.stdout, /already renamed/);
  assert.deepEqual(await tables(to), before);

  // Refuses when both databases hold tables.
  await connection.query(`CREATE DATABASE \`${from}\``);
  await connection.query(`CREATE TABLE \`${from}\`.stray (id INT)`);
  await assert.rejects(rename(), /Both .* hold tables/);
  await connection.query(`DROP DATABASE \`${from}\``);

  // Rollback: swap the names.
  await rename({ FROM_DB: to, TO_DB: from, FROM_USER: toUser, TO_USER: fromUser });
  assert.deepEqual(await tables(from), before);
  assert.deepEqual(await tables(to), []);
  await migrateRuntime({ ...admin, user: fromUser, password, database: from });

  // Refuses objects RENAME TABLE cannot move.
  await connection.query(`CREATE VIEW \`${from}\`.v AS SELECT 1 AS one`);
  await assert.rejects(rename(), /views, triggers, routines or events/);
  assert.deepEqual((await tables(from)).filter(name => name !== 'v'), before);
});
