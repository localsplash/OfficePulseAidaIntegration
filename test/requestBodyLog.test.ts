import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpApi } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { RequestBodyLog } from '../src/logging/requestBodyLog.js';
import { captureLogger } from './helpers/capture.js';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'request-body-log-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const lines = async (dir: string) => {
  const [name] = await readdir(dir);
  return (await readFile(join(dir, name!), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
};

test('flagged routes record the request body, status and error but never the response or bearer token', async () => {
  await withDir(async (dir) => {
    const bodyLog = new RequestBodyLog(dir);
    const writes: Promise<void>[] = [];
    const api = new HttpApi({
      logger: captureLogger().logger, readiness: new Readiness(), trustedServerCidrs: [], trustedProxyCidrs: [],
      maxBodyBytes: 1024, rateLimitPerMinute: 1000, requestBodyLog: { write: (entry) => { const w = bodyLog.write(entry); writes.push(w); return w; } },
      routes: [
        { method: 'POST', pattern: '/v1/handset/attach', trusted: false, logRequestBody: true, handler: async (req) => {
          if ((req.body as { claimedMac?: unknown }).claimedMac === null) throw Object.assign(new Error('invalid_attach'), { status: 400 });
          return { status: 403, body: { error: 'handset_not_recognized', publicIp: req.clientIp } };
        } },
        { method: 'POST', pattern: '/v1/handset/ok', trusted: false, logRequestBody: true, handler: async () => ({ status: 200, body: { token: 'device-token' } }) },
        { method: 'POST', pattern: '/v1/other', trusted: false, handler: async () => ({ status: 200 }) },
      ],
    });
    await api.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${api.address()?.port}`;
    const post = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', authorization: 'Bearer should-not-appear', 'user-agent': 'okhttp/4.12.0' } });
    try {
      assert.equal((await post('/v1/handset/attach', '{"appInstanceId":"a","claimedMac":null,"secretKey":"s"}')).status, 400);
      assert.equal((await post('/v1/handset/attach', '{"appInstanceId":"a"}')).status, 403);
      assert.equal((await post('/v1/handset/attach', '{not json')).status, 422);
      assert.equal((await post('/v1/handset/ok', '{}')).status, 200);
      assert.equal((await post('/v1/other', '{"unlogged":true}')).status, 200);
    } finally { await api.close(); }
    await Promise.all(writes);

    const recorded = await lines(dir);
    assert.equal(recorded.length, 4);
    assert.deepEqual(recorded.map((r) => [r.status, r.error]), [[400, 'invalid_attach'], [403, 'handset_not_recognized'], [422, 'request body must be valid JSON'], [200, undefined]]);
    // null stays distinguishable from an absent field; secret-looking keys are masked.
    assert.deepEqual(recorded[0]!.body, { appInstanceId: 'a', claimedMac: null, secretKey: '[redacted]' });
    assert.equal(recorded[0]!.userAgent, 'okhttp/4.12.0');
    assert.equal(recorded[0]!.path, '/v1/handset/attach');
    assert.equal(recorded[2]!.rawBody, '{not json');
    const text = await readFile(join(dir, (await readdir(dir))[0]!), 'utf8');
    assert.doesNotMatch(text, /should-not-appear|device-token|unlogged/);
  });
});

test('day files older than the retention window are deleted when a new day starts', async () => {
  await withDir(async (dir) => {
    for (const day of ['2026-09-01', '2026-09-06', '2026-09-07', '2026-09-20']) await writeFile(join(dir, `handset-requests-${day}.jsonl`), '{}\n');
    await writeFile(join(dir, 'unrelated.txt'), 'kept');
    const log = new RequestBodyLog(dir, 14, () => {}, () => Date.parse('2026-09-21T12:00:00Z'));
    await log.write({ correlationId: 'c', method: 'GET', path: '/v1/handset/me', clientIp: '203.0.113.9', raw: Buffer.alloc(0), status: 401 });
    assert.deepEqual((await readdir(dir)).sort(), ['handset-requests-2026-09-07.jsonl', 'handset-requests-2026-09-20.jsonl', 'handset-requests-2026-09-21.jsonl', 'unrelated.txt']);
  });
});

test('a write failure is reported once and never throws', async () => {
  await withDir(async (dir) => {
    const blocked = join(dir, 'file');
    await writeFile(blocked, '');
    const errors: unknown[] = [];
    const log = new RequestBodyLog(join(blocked, 'sub'), 14, (err) => errors.push(err));
    const entry = { correlationId: 'c', method: 'GET', path: '/v1/handset/me', clientIp: '203.0.113.9', raw: Buffer.alloc(0), status: 200 };
    await log.write(entry);
    await log.write(entry);
    assert.equal(errors.length, 1);
  });
});
