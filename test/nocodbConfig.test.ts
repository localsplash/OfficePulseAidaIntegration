import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NocoDbReadClient, BaseResolutionError } from '../src/nocodb/api.js';
import { NocoConfigRepository } from '../src/nocodb/configRepository.js';
import { FakeNocoApi, seedHealthyBase } from './helpers/fakeCloud.js';

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the base is discovered by name, case-insensitively, and never created', async () => {
  const seen: string[] = [];
  const client = new NocoDbReadClient({
    baseUrl: 'https://noco.test',
    apiToken: 'tok',
    timeoutMs: 200,
    fetchImpl: fakeFetch((url) => {
      seen.push(url);
      if (url.endsWith('/api/v2/meta/bases')) {
        return json({ list: [{ id: 'b1', title: 'Other' }, { id: 'b2', title: 'platformconfig' }] });
      }
      if (url.includes('/meta/bases/b2/tables')) return json({ list: [{ id: 't1', table_name: 'aida_tbl_TenantProfile' }] });
      return json({ list: [{ id: 'profile-1', iTenantId: 1 }] });
    }),
  });

  const records = await client.listRecords('tenant', [{ field: 'id', op: 'eq', value: 'tenant-1' }]);
  assert.deepEqual(records, [{ id: '1', iTenantId: 1, tenant_id: '1', enabled: true }]);
  // Read-only: no POST is ever issued, so no base is created.
  assert.ok(seen.every((url) => !url.includes('POST')));
});

test('a missing base is an error, never an auto-created empty one', async () => {
  const client = new NocoDbReadClient({
    baseUrl: 'https://noco.test',
    apiToken: 'tok',
    timeoutMs: 200,
    fetchImpl: fakeFetch(() => json({ list: [{ id: 'b1', title: 'Something Else' }] })),
  });
  await assert.rejects(client.listRecords('tenant', []), BaseResolutionError);
  assert.equal(await client.ping(), false);
});

test('duplicate bases are refused rather than guessed between', async () => {
  const client = new NocoDbReadClient({
    baseUrl: 'https://noco.test',
    apiToken: 'tok',
    timeoutMs: 200,
    fetchImpl: fakeFetch(() =>
      json({ list: [{ id: 'b1', title: 'PlatformConfig' }, { id: 'b2', title: 'platformconfig' }] }),
    ),
  });
  await assert.rejects(client.listRecords('tenant', []), /Exactly one is required/);
});

test('the API token travels in xc-token and never in the URL', async () => {
  let authHeader: string | undefined;
  let sawTokenInUrl = false;
  const client = new NocoDbReadClient({
    baseUrl: 'https://noco.test',
    apiToken: 'super-secret-token',
    timeoutMs: 200,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('super-secret-token')) sawTokenInUrl = true;
      authHeader = (init?.headers as Record<string, string>)?.['xc-token'];
      if (String(input).endsWith('/api/v2/meta/bases')) return json({ list: [{ id: 'b1', title: 'PlatformConfig' }] });
      if (String(input).includes('/tables')) return json({ list: [{ id: 't1', table_name: 'aida_tbl_TenantProfile' }] });
      return json({ list: [] });
    }) as typeof fetch,
  });
  await client.listRecords('tenant', []);
  assert.equal(authHeader, 'super-secret-token');
  assert.equal(sawTokenInUrl, false);
});

test('a request timeout surfaces as an upstream error, not a hang', async () => {
  const client = new NocoDbReadClient({
    baseUrl: 'https://noco.test',
    apiToken: 'tok',
    timeoutMs: 50,
    fetchImpl: ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch,
  });
  const started = Date.now();
  await assert.rejects(client.listRecords('tenant', []), /timed out/);
  assert.ok(Date.now() - started < 2000);
});

test('resolveInboundRoute joins DID, tenant, and profile with their revisions', async () => {
  const api = new FakeNocoApi();
  seedHealthyBase(api);
  const route = await new NocoConfigRepository(api).resolveInboundRoute('+15559870001');
  assert.ok(route);
  assert.equal(route.didRoute.id, 'route-1');
  assert.equal(route.didRoute.revision, 11);
  assert.equal(route.didRoute.destinationType, 'EXTENSION');
  assert.equal(route.didRoute.destinationId, 'ext-1');
  assert.equal(route.tenant.revision, 7);
  assert.equal(route.profile.revision, 3);
});

test('a DID stored without its leading + still resolves', async () => {
  const api = new FakeNocoApi();
  seedHealthyBase(api, { didE164: '15559870001' });
  const repo = new NocoConfigRepository(api);
  assert.ok(await repo.resolveInboundRoute('+15559870001'));
  assert.ok(await repo.resolveInboundRoute('15559870001'));
});

test('a route naming a ring group resolves to the ring group id', async () => {
  const api = new FakeNocoApi();
  seedHealthyBase(api);
  api.seed('did_route', [
    {
      id: 'route-1',
      revision: 1,
      tenant_id: 'tenant-1',
      did_e164: '+15559870001',
      assistant_profile_id: 'profile-1',
      destination_type: 'RING_GROUP',
      destination_extension_id: '',
      destination_ring_group_id: 'rg-1',
      screening_enabled: true,
      enabled: true,
    },
  ]);
  const route = await new NocoConfigRepository(api).resolveInboundRoute('+15559870001');
  assert.equal(route?.didRoute.destinationType, 'RING_GROUP');
  assert.equal(route?.didRoute.destinationId, 'rg-1');
});

test('a route with no usable destination is treated as unrouted', async () => {
  const api = new FakeNocoApi();
  seedHealthyBase(api);
  api.seed('did_route', [
    {
      id: 'route-1',
      revision: 1,
      tenant_id: 'tenant-1',
      did_e164: '+15559870001',
      assistant_profile_id: 'profile-1',
      destination_type: 'EXTENSION',
      destination_extension_id: '',
      destination_ring_group_id: '',
      screening_enabled: true,
      enabled: true,
    },
  ]);
  assert.equal(await new NocoConfigRepository(api).resolveInboundRoute('+15559870001'), undefined);
});

test('checkbox columns are read whether stored as boolean, 1/0, or text', async () => {
  for (const enabledValue of [true, 1, 'true']) {
    const api = new FakeNocoApi();
    seedHealthyBase(api);
    const rows = api.tables.get('tenant') as Array<Record<string, unknown>>;
    (rows[0] as Record<string, unknown>).enabled = enabledValue;
    const route = await new NocoConfigRepository(api).resolveInboundRoute('+15559870001');
    assert.ok(route, `enabled=${String(enabledValue)} must read as true`);
  }
  for (const disabledValue of [false, 0, 'false', '']) {
    const api = new FakeNocoApi();
    seedHealthyBase(api);
    const rows = api.tables.get('tenant') as Array<Record<string, unknown>>;
    (rows[0] as Record<string, unknown>).enabled = disabledValue;
    assert.equal(
      await new NocoConfigRepository(api).resolveInboundRoute('+15559870001'),
      undefined,
      `enabled=${String(disabledValue)} must read as false`,
    );
  }
});

test('an extension is found by its normalized MAC', async () => {
  const api = new FakeNocoApi();
  seedHealthyBase(api);
  const extension = await new NocoConfigRepository(api).findExtensionByMac('C074AD112233');
  assert.equal(extension?.id, 'ext-1');
  assert.equal(extension?.deviceId, 'device-1');
  assert.equal(await new NocoConfigRepository(api).findExtensionByMac('DEADBEEF0000'), undefined);
});
