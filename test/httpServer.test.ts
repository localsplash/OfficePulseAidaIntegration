import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpApi, publicApiOptions } from '../src/http/httpServer.js';
import { Readiness } from '../src/readiness.js';
import { ValidationError } from '../src/errors.js';
import { captureLogger } from './helpers/capture.js';

async function withApi(
  fn: (base: string, readiness: Readiness) => Promise<void>,
  opts?: { rateLimitPerMinute?: number; maxBodyBytes?: number; trustedServerCidrs?: string[] },
): Promise<void> {
  const { logger } = captureLogger();
  const readiness = new Readiness();
  readiness.register('dep', 'critical', true);
  const api = new HttpApi({
    logger,
    readiness,
    trustedServerCidrs: opts?.trustedServerCidrs ?? ['127.0.0.1/32'],
    trustedProxyCidrs: [],
    maxBodyBytes: opts?.maxBodyBytes ?? 1024,
    rateLimitPerMinute: opts?.rateLimitPerMinute ?? 1000,
    routes: [
      { method: 'POST', pattern: '/v1/echo/:id', handler: async (req) => ({ status: 200, body: { id: req.params.id, body: req.body } }) },
      {
        method: 'POST',
        pattern: '/v1/fail',
        handler: async () => {
          throw new ValidationError('nope', ['bad field']);
        },
      },
      {
        method: 'POST',
        pattern: '/v1/boom',
        handler: async () => {
          throw new Error('secret internal detail');
        },
      },
    ],
  });
  await api.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${api.address()?.port}`, readiness);
  } finally {
    await api.close();
  }
}

test('healthz is open; readyz reflects dependency state', async () => {
  await withApi(async (base, readiness) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    readiness.set('dep', false, 'mysql lost');
    const degraded = await fetch(`${base}/readyz`);
    assert.equal(degraded.status, 503);
    const body = (await degraded.json()) as { components: Record<string, { detail?: string }> };
    assert.equal(body.components.dep?.detail, 'mysql lost');
  });
});

test('routes dispatch with params and JSON body', async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/v1/echo/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 'abc', body: { x: 1 } });
  });
});

test('requests outside the trusted CIDRs are denied even with a spoofed XFF', async () => {
  await withApi(
    async (base) => {
      const res = await fetch(`${base}/v1/echo/abc`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '10.0.0.5' },
      });
      assert.equal(res.status, 403);
    },
    { trustedServerCidrs: ['10.0.0.0/24'] },
  );
});

test('rate limiting returns 429 after the budget is spent', async () => {
  await withApi(
    async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await fetch(`${base}/v1/echo/a`, { method: 'POST' })).status);
      }
      assert.deepEqual(statuses.slice(0, 2), [200, 200]);
      assert.ok(statuses.slice(2).every((s) => s === 429));
    },
    { rateLimitPerMinute: 2 },
  );
});

test('oversized bodies are rejected with 413', async () => {
  await withApi(
    async (base) => {
      const res = await fetch(`${base}/v1/echo/a`, { method: 'POST', body: 'x'.repeat(4096) });
      assert.equal(res.status, 413);
    },
    { maxBodyBytes: 128 },
  );
});

test('malformed JSON is a 422, validation errors carry details, 500s hide internals', async () => {
  await withApi(async (base) => {
    const bad = await fetch(`${base}/v1/echo/a`, { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 422);

    const invalid = await fetch(`${base}/v1/fail`, { method: 'POST' });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), { error: 'nope', details: ['bad field'] });

    const boom = await fetch(`${base}/v1/boom`, { method: 'POST' });
    assert.equal(boom.status, 500);
    const body = (await boom.json()) as { error: string };
    assert.equal(body.error, 'internal error');
    assert.ok(!JSON.stringify(body).includes('secret internal detail'));
  });
});

test('unknown v1 routes 404 inside the trust boundary', async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/v1/nothing`, { method: 'POST' })).status, 404);
  });
});

test('public listener cannot dispatch private provisioning even from a trusted proxy/server', async () => {
  let privateCalls = 0;
  const api = new HttpApi(publicApiOptions({ logger: captureLogger().logger, readiness: new Readiness(),
    trustedServerCidrs: ['127.0.0.1/32', '10.0.0.0/8'], trustedProxyCidrs: ['127.0.0.1/32'],
    maxBodyBytes: 1024, rateLimitPerMinute: 100,
    routes: [
      { method: 'POST', pattern: '/v1/provisioning/extensions', handler: async () => { privateCalls++; return { status: 201 }; } },
      { method: 'POST', pattern: '/v1/devices/enroll', trusted: false, handler: async () => ({ status: 401 }) },
    ],
  }));
  await api.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${api.address()?.port}`;
    assert.equal((await fetch(`${base}/v1/provisioning/extensions`, { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.5' } })).status, 403);
    assert.equal((await fetch(`${base}/v1/devices/enroll`, { method: 'POST' })).status, 401);
    assert.equal(privateCalls, 0);
  } finally { await api.close(); }
});
