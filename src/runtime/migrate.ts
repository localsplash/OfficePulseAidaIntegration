import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RuntimeMysqlConfig } from './mysqlRuntimeStore.js';

/** Append-only migrations, executed only against the configured integration database. */
export async function migrateRuntime(config: RuntimeMysqlConfig): Promise<void> {
  const connection = await mysql.createConnection(config);
  try {
    const [locks] = await connection.query<mysql.RowDataPacket[]>("SELECT GET_LOCK('aida_runtime_schema',60) AS acquired");
    if (Number(locks[0]?.acquired) !== 1) throw new Error('runtime migration lock unavailable');
    await connection.query('CREATE TABLE IF NOT EXISTS aida_tbl_SchemaMigration (name VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL, dtCreated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB');
    for (const name of ['runtime-schema.sql', '002_device_access.sql', '003_event_receipts.sql']) {
      const raw = await readFile(new URL(`../../deploy/sql/${name}`, import.meta.url), 'utf8');
      // Legacy baseline includes a fixed CREATE DATABASE / USE. The runner never executes those.
      const sql = raw.replace(/^--.*$/gm, '').replace(/CREATE DATABASE[\s\S]*?;/i, '').replace(/\bUSE\s+\w+\s*;/gi, '');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [applied] = await connection.execute<mysql.RowDataPacket[]>('SELECT checksum FROM aida_tbl_SchemaMigration WHERE name=?', [name]);
      if (applied.length) {
        if (applied[0]?.checksum !== checksum) throw new Error(`released runtime migration changed: ${name}`);
        continue;
      }
      for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO aida_tbl_SchemaMigration (name,checksum) VALUES (?,?)', [name,checksum]);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('aida_runtime_schema')").catch(() => {});
    await connection.end();
  }
}
