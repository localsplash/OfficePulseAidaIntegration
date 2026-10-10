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
  DB_HOST: 'db.example.test', DB_PORT: '3306',
  DB_NAME: 'aida_grants_test', DB_USER: 'runtime_user',
  DB_PASSWORD: "runtime'\\$(not-a-command)\n", MYSQL_ADMIN_USER: 'admin', MYSQL_ADMIN_PASSWORD: 'admin-secret',
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
    MYSQL_ADMIN_HOST: 'operator-tunnel', MYSQL_ADMIN_PORT: '13306' };
  const result = await exec('bash', [script], { env });
  const recorded = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(recorded.args.includes('--host=operator-tunnel'));
  assert.ok(recorded.args.includes('--port=13306'));
  assert.equal(recorded.password, sample.MYSQL_ADMIN_PASSWORD);
  assert.doesNotMatch(JSON.stringify(recorded.args), /secret|runtime'|not-a-command/);
  assert.match(recorded.sql, /SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'/);
  assert.ok(recorded.sql.includes("IDENTIFIED BY 'runtime''\\\\$(not-a-command)\n'"));
  assert.ok(recorded.sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON `aida\\_grants\\_test`.*'));
  assert.equal((recorded.sql.match(/REVOKE ALL PRIVILEGES, GRANT OPTION/g) ?? []).length, 1);
  assert.equal((recorded.sql.match(/ALTER USER/g) ?? []).length, 1);
  assert.doesNotMatch(recorded.sql, /GRANT SELECT ON/, 'no read-only account: AidaAdmin reads through the private API');
  assert.doesNotMatch(result.stdout + result.stderr, /secret|runtime'|not-a-command/);

  for (const change of [
    { DB_USER: 'bad-name' }, { DB_USER: 'root' },
    { DB_USER: 'admin' }, { DB_NAME: 'asterisk' },
    { DB_NAME: 'aida_%_test' }, { DB_PASSWORD: '' },
    { MYSQL_ADMIN_PASSWORD: '' }, { MYSQL_ADMIN_PORT: '0' }, { MYSQL_ADMIN_PORT: '65536' },
    { DB_HOST: '' },
  ]) {
    await rm(capture);
    await assert.rejects(exec('bash', [script], { env: { ...env, ...change } }), error => {
      const failure = error as Error & { stderr: string };
      assert.doesNotMatch(failure.stderr, /not-a-command|admin-secret|mysql:\/\//);
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
  const runtimeUser = `aida_rt_${suffix}`;
  const admin = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const connection = await mysql.createConnection(admin);
  t.after(async () => {
    await connection.query(`DROP USER IF EXISTS '${runtimeUser}'@'%'`);
    for (const db of [database, decoy]) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await connection.end();
  });
  let runtimePassword = "runtime'\\$password\n";
  const provision = () => exec('bash', [script], { env: { ...process.env,
    MYSQL_ADMIN_HOST: admin.host, MYSQL_ADMIN_PORT: String(admin.port), MYSQL_ADMIN_USER: admin.user, MYSQL_ADMIN_PASSWORD: admin.password,
    DB_HOST: admin.host, DB_PORT: String(admin.port), DB_NAME: database,
    DB_USER: runtimeUser, DB_PASSWORD: runtimePassword,
  } });
  const runtimeConfig = () => ({ ...admin, database, user: runtimeUser, password: runtimePassword });
  const grants = async (user: string) => (await connection.query<mysql.RowDataPacket[]>(`SHOW GRANTS FOR '${user}'@'%'`))[0].map(row => String(Object.values(row)[0])).sort();
  await provision();
  const expectedRuntime = await grants(runtimeUser);
  await provision();
  assert.deepEqual(await grants(runtimeUser), expectedRuntime);
  await migrateRuntime(runtimeConfig());
  await migrateRuntime(runtimeConfig());
  await connection.query(`CREATE DATABASE \`${decoy}\``);
  await connection.query(`CREATE TABLE \`${decoy}\`.private_data (id INT)`);
  const runtime = await mysql.createConnection(runtimeConfig());
  await assert.rejects(runtime.query(`SELECT * FROM \`${decoy}\`.private_data`), /denied/);
  await assert.rejects(runtime.query('SELECT * FROM mysql.user'), /denied/);
  await assert.rejects(runtime.query('CREATE VIEW forbidden AS SELECT 1'), /denied/);
  await runtime.end();
  // Simulate over-broad historical grants, including wildcard leakage and GRANT OPTION.
  await connection.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${runtimeUser}'@'%' WITH GRANT OPTION`);
  const oldRuntime = runtimePassword;
  runtimePassword = "rotated'\\passwordé\n";
  await provision();
  assert.deepEqual(await grants(runtimeUser), expectedRuntime);
  await assert.rejects(mysql.createConnection({ ...admin, database, user: runtimeUser, password: oldRuntime }), /Access denied/);
  await migrateRuntime(runtimeConfig());
});
