import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { migrateRuntime } from '../src/runtime/migrate.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/db-users.sh', import.meta.url));
const sample: NodeJS.ProcessEnv = {
  RUNTIME_MYSQL_HOST: 'db.example.test', RUNTIME_MYSQL_PORT: '3306',
  RUNTIME_MYSQL_DATABASE: 'aida_grants_test', RUNTIME_MYSQL_USER: 'runtime_user',
  RUNTIME_MYSQL_PASSWORD: "runtime'\\secret", MYSQL_ADMIN_USER: 'admin', MYSQL_ADMIN_PASSWORD: 'admin-secret',
  OFFICEPULSE_RUNTIME_DATABASE_URL: 'mysql://reader%5Fuser:quote%27%5C%24%28not-a-command%29%0A@reader-host/aida_grants_test',
};

test('DB provisioning sends escaped secrets through stdin, uses the existing inputs and narrows grants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aida-db-users-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = join(root, 'capture.json');
  await writeFile(join(root, 'mysql'), `#!/usr/bin/env node
let sql = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => sql += chunk);
process.stdin.on('end', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.CAPTURE_MYSQL, JSON.stringify({ sql, args: process.argv.slice(2), password: process.env.MYSQL_PWD }));
});\n`, { mode: 0o700 });
  const env = { ...process.env, ...sample, PATH: `${root}:${process.env.PATH}`, CAPTURE_MYSQL: capture,
    DB_HOST: 'operator-tunnel', DB_PORT: '13306' };
  const result = await exec('bash', [script], { env });
  const recorded = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(recorded.args.includes('--host=operator-tunnel'));
  assert.ok(recorded.args.includes('--port=13306'));
  assert.equal(recorded.password, sample.MYSQL_ADMIN_PASSWORD);
  assert.doesNotMatch(JSON.stringify(recorded.args), /secret|quote|not-a-command/);
  assert.match(recorded.sql, /SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'/);
  assert.ok(recorded.sql.includes("IDENTIFIED BY 'runtime''\\\\secret'"));
  assert.ok(recorded.sql.includes("IDENTIFIED BY 'quote''\\\\$(not-a-command)\n'"));
  assert.match(recorded.sql, /CREATE USER IF NOT EXISTS 'reader_user'@'%'/);
  assert.ok(recorded.sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON `aida\\_grants\\_test`.*'));
  assert.ok(recorded.sql.includes("GRANT SELECT ON `aida\\_grants\\_test`.* TO 'reader_user'@'%'"));
  assert.equal((recorded.sql.match(/REVOKE ALL PRIVILEGES, GRANT OPTION/g) ?? []).length, 2);
  assert.equal((recorded.sql.match(/ALTER USER/g) ?? []).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /secret|quote|not-a-command/);

  for (const change of [
    { RUNTIME_MYSQL_USER: 'bad-name' }, { RUNTIME_MYSQL_USER: 'reader_user' },
    { RUNTIME_MYSQL_USER: 'admin' }, { RUNTIME_MYSQL_DATABASE: 'asterisk' },
    { RUNTIME_MYSQL_DATABASE: 'aida_%_test' }, { RUNTIME_MYSQL_PASSWORD: '' },
    { MYSQL_ADMIN_PASSWORD: '' }, { DB_PORT: '0' }, { DB_PORT: '65536' },
    { OFFICEPULSE_RUNTIME_DATABASE_URL: 'mysql://reader:secret@db/other' },
    { OFFICEPULSE_RUNTIME_DATABASE_URL: 'mysql://reader:%GG@db/aida_grants_test' },
    { OFFICEPULSE_RUNTIME_DATABASE_URL: 'mysql://reader:%00@db/aida_grants_test' },
    { OFFICEPULSE_RUNTIME_DATABASE_URL: 'mysql://reader:@db/aida_grants_test' },
  ]) {
    await rm(capture);
    await assert.rejects(exec('bash', [script], { env: { ...env, ...change } }), error => {
      const failure = error as Error & { stderr: string };
      assert.doesNotMatch(failure.stderr, /runtime.*secret|admin-secret|mysql:\/\//);
      return true;
    });
    await assert.rejects(access(capture), 'validation must precede every MySQL command');
    // Next iteration removes the placeholder, not any client output.
    await writeFile(capture, '');
  }
  await writeFile(join(root, 'mysql'), '#!/bin/sh\necho "secret SQL error" >&2\nexit 1\n', { mode: 0o700 });
  await assert.rejects(exec('bash', [script], { env }), error => {
    const failure = error as Error & { stderr: string };
    assert.match(failure.stderr, /MySQL provisioning failed/);
    assert.doesNotMatch(failure.stderr, /secret SQL/);
    return true;
  });
});

const adminUrl = process.env.TEST_DB_USERS_MYSQL_URL;
test('disposable MySQL: provisioning, migrations, exact privileges, idempotence and password rotation', { skip: !adminUrl, timeout: 60_000 }, async t => {
  const url = new URL(adminUrl!);
  assert.match(url.pathname, /^\/aida_[a-z0-9_]+_test$/, 'use a disposable test URL');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const database = `aida_users_${suffix}_test`;
  const decoy = database.replaceAll('_', 'x');
  const runtimeUser = `aida_rt_${suffix}`, readerUser = `aida_ro_${suffix}`;
  const admin = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const connection = await mysql.createConnection(admin);
  t.after(async () => {
    for (const user of [runtimeUser, readerUser]) await connection.query(`DROP USER IF EXISTS '${user}'@'%'`);
    for (const db of [database, decoy]) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await connection.end();
  });
  let runtimePassword = "runtime'\\$password", readerPassword = "reader'\\$password\n";
  const provision = () => exec('bash', [script], { env: { ...process.env,
    DB_HOST: admin.host, DB_PORT: String(admin.port), MYSQL_ADMIN_USER: admin.user, MYSQL_ADMIN_PASSWORD: admin.password,
    RUNTIME_MYSQL_HOST: admin.host, RUNTIME_MYSQL_PORT: String(admin.port), RUNTIME_MYSQL_DATABASE: database,
    RUNTIME_MYSQL_USER: runtimeUser, RUNTIME_MYSQL_PASSWORD: runtimePassword,
    OFFICEPULSE_RUNTIME_DATABASE_URL: `mysql://${readerUser}:${encodeURIComponent(readerPassword)}@${admin.host}/${database}`,
  } });
  const runtimeConfig = () => ({ ...admin, database, user: runtimeUser, password: runtimePassword });
  const grants = async (user: string) => (await connection.query<mysql.RowDataPacket[]>(`SHOW GRANTS FOR '${user}'@'%'`))[0].map(row => String(Object.values(row)[0])).sort();
  await provision();
  const expectedRuntime = await grants(runtimeUser), expectedReader = await grants(readerUser);
  await provision();
  assert.deepEqual(await grants(runtimeUser), expectedRuntime);
  assert.deepEqual(await grants(readerUser), expectedReader);
  await migrateRuntime(runtimeConfig());
  await migrateRuntime(runtimeConfig());
  const reader = await mysql.createConnection({ ...admin, database, user: readerUser, password: readerPassword });
  await reader.query('SELECT * FROM aida_tbl_SchemaMigration');
  await assert.rejects(reader.query('DELETE FROM aida_tbl_SchemaMigration'), /denied/);
  await assert.rejects(reader.query('CREATE TABLE forbidden (id INT)'), /denied/);
  await reader.end();
  await connection.query(`CREATE DATABASE \`${decoy}\``);
  await connection.query(`CREATE TABLE \`${decoy}\`.private_data (id INT)`);
  const runtime = await mysql.createConnection(runtimeConfig());
  await assert.rejects(runtime.query(`SELECT * FROM \`${decoy}\`.private_data`), /denied/);
  await assert.rejects(runtime.query('SELECT * FROM mysql.user'), /denied/);
  await assert.rejects(runtime.query('CREATE VIEW forbidden AS SELECT 1'), /denied/);
  await runtime.end();
  // Simulate over-broad historical grants, including wildcard leakage and GRANT OPTION.
  await connection.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${runtimeUser}'@'%' WITH GRANT OPTION`);
  await connection.query(`GRANT SELECT ON \`${decoy}\`.* TO '${readerUser}'@'%'`);
  const oldRuntime = runtimePassword, oldReader = readerPassword;
  runtimePassword = "rotated'\\passwordé"; readerPassword = "rotated'\\readeré\n";
  await provision();
  assert.deepEqual(await grants(runtimeUser), expectedRuntime);
  assert.deepEqual(await grants(readerUser), expectedReader);
  for (const [user, password] of [[runtimeUser, oldRuntime], [readerUser, oldReader]]) {
    await assert.rejects(mysql.createConnection({ ...admin, database, user, password }), /Access denied/);
  }
  await migrateRuntime(runtimeConfig());
  const rotatedReader = await mysql.createConnection({ ...admin, database, user: readerUser, password: readerPassword });
  await rotatedReader.query('SELECT * FROM aida_tbl_SchemaMigration');
  await assert.rejects(rotatedReader.query(`SELECT * FROM \`${decoy}\`.private_data`), /denied/);
  await rotatedReader.end();
});
