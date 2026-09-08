import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { migrateRuntime } from '../src/runtime/migrate.js';

// These are the ledger values in the released deployment, not recomputed from
// the current files. Exercise the production normalizer against that contract:
// adding even a comment line can otherwise leave a checksum-changing newline.
const RELEASED_CHECKSUMS: Record<string, string> = {
  'runtime-schema.sql': '1b3c47a73e489a02ac5f2cc7a2930209dba7379361c3bb954ee896268b7981cb',
  '002_device_access.sql': '9eddab84b0475e201bb4a657879ae960e6b9ef81d447bfd8d29e2ed7ae5ba5e1',
  '003_event_receipts.sql': 'b677b2979a86ff99b12ac84b0f72eecdb775402dc3c2371c47ad7323ce0d5b9f',
};

test('released migration ledger remains compatible before applying projection cleanup', async (t) => {
  const checked: string[] = [];
  const applied: string[] = [];
  const connection = {
    async query(sql: string) {
      return sql.includes('GET_LOCK') ? [[{ acquired: 1 }]] : [[]];
    },
    async execute(sql: string, values: string[]) {
      const name = values[0]!;
      if (sql.startsWith('SELECT checksum')) {
        checked.push(name);
        return [RELEASED_CHECKSUMS[name] ? [{ checksum: RELEASED_CHECKSUMS[name] }] : []];
      }
      applied.push(name);
      return [[]];
    },
    async end() {},
  } as unknown as mysql.Connection;
  t.mock.method(mysql, 'createConnection', async () => connection);
  await migrateRuntime({ host: 'not-used', port: 3306, user: 'not-used', password: 'not-used', database: 'aidacalls_db' });
  assert.deepEqual(checked, [...Object.keys(RELEASED_CHECKSUMS), '004_remove_retired_pbx.sql']);
  assert.deepEqual(applied, ['004_remove_retired_pbx.sql']);
});
