import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExtensionProvisioningService } from '../src/provisioning/extensions.js';
import { RingGroupProvisioningService } from '../src/provisioning/ringGroups.js';
import { DidProvisioningService } from '../src/provisioning/dids.js';
import { HandsetProvisioningService } from '../src/provisioning/handsets.js';
import type { DeviceProvisioningService } from '../src/provisioning/deviceProvisioningAdapter.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { FakeRuntimeStore } from './helpers/fakeRuntime.js';
import { captureLogger } from './helpers/capture.js';

/**
 * Cross-repository contract test (issue #9).
 *
 * The fixture holds the exact request bodies `localsplash/AidaAdmin` sends
 * from server/src/officepulse/client.ts. If either side drifts — a renamed
 * field, a newly required one, a nullable that stops being accepted — this
 * fails here rather than on a live provisioning call.
 */

const PAYLOADS = JSON.parse(
  readFileSync(new URL('./fixtures/aidaadmin-payloads.json', import.meta.url), 'utf8'),
) as Record<string, { method: string; path: string; body: Record<string, unknown> }>;

const EXT_ID = '22222222-2222-4222-8222-222222222222';
const RING_GROUP_ID = '44444444-4444-4444-8444-444444444444';
const DID_ROUTE_ID = '66666666-6666-4666-8666-666666666666';
const DID_ROUTE_ID_2 = '77777777-7777-4777-8777-777777777777';

class RecordingAdapter implements DeviceProvisioningService {
  sipCalls: unknown[] = [];
  configCalls: unknown[] = [];
  async upsertSipDevice(req: unknown): Promise<void> {
    this.sipCalls.push(req);
  }
  async deliverHandsetConfig(req: unknown): Promise<void> {
    this.configCalls.push(req);
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

function services() {
  const store = new FakeRealtimeStore();
  const runtime = new FakeRuntimeStore();
  const { logger } = captureLogger();
  const adapter = new RecordingAdapter();
  return {
    store,
    runtime,
    adapter,
    extensions: new ExtensionProvisioningService({
      store,
      logger,
      defaultTransport: 'transport-udp',
      defaultAllow: 'ulaw,alaw',
      deviceProvisioning: adapter,
    }),
    ringGroups: new RingGroupProvisioningService({ store, logger }),
    dids: new DidProvisioningService({
      store,
      runtime,
      logger,
      officePulseInstanceId: 'op-primary',
      fastAgiHost: 'aida-integration.internal',
      fastAgiPort: 4573,
      disclosureContext: 'aida-disclosure',
      postBootstrapContext: 'aida-post-bootstrap',
    }),
    handsets: new HandsetProvisioningService({
      store,
      logger,
      deviceProvisioning: adapter,
      aidaControlUrl: 'https://aida-integration.internal:8085',
    }),
  };
}

function body(name: string): Record<string, unknown> {
  const entry = PAYLOADS[name];
  assert.ok(entry, `fixture ${name} is missing`);
  return entry.body;
}

test('AidaAdmin extension payloads are accepted, including all-null optionals', async () => {
  const { extensions } = services();

  const full = await extensions.create(body('provisionExtension') as never);
  assert.equal(full.status, 'created');
  assert.ok(full.sipSecret);

  // AidaAdmin types the optional fields as `string | null` and sends null.
  const minimal = await extensions.create(body('provisionExtensionMinimal') as never);
  assert.equal(minimal.status, 'created');
});

test('AidaAdmin never sends identityUserId, and OfficePulse never requires it', async () => {
  for (const name of ['provisionExtension', 'provisionExtensionMinimal', 'updateExtension']) {
    assert.equal('identityUserId' in body(name), false, `${name} must not carry identityUserId`);
  }
  // Proven by the create above succeeding without it.
  const { extensions } = services();
  await extensions.create(body('provisionExtension') as never);
});

test('AidaAdmin update and rotate-secret payloads are accepted', async () => {
  const { extensions } = services();
  await extensions.create(body('provisionExtension') as never);

  const updated = await extensions.update(EXT_ID, body('updateExtension') as never);
  assert.equal(updated.status, 'updated');

  const rotated = await extensions.rotateSecret(EXT_ID, body('rotateSecret') as never);
  assert.equal(rotated.status, 'rotated');
  assert.ok(rotated.sipSecret);
});

test('AidaAdmin ring-group payload applies BOTH caller ID name and number', async () => {
  const { extensions, ringGroups, store } = services();
  await extensions.create(body('provisionExtension') as never);
  await extensions.create(body('provisionExtensionMinimal') as never);

  await ringGroups.provision(RING_GROUP_ID, body('provisionRingGroup') as never);

  const rows = await store.getDialplan('office-main', '600');
  const appdata = rows.map((r) => r.appdata);
  assert.ok(
    appdata.includes('CALLERID(name)=Acme Reception'),
    'the ring group caller ID name must be applied',
  );
  assert.ok(
    appdata.includes('CALLERID(num)=+15559870001'),
    'the ring group caller ID number must be applied too, not just the name',
  );
  // Name precedes number precedes Dial, so both are set before dialling.
  const nameIdx = appdata.findIndex((a) => a.startsWith('CALLERID(name)'));
  const numIdx = appdata.findIndex((a) => a.startsWith('CALLERID(num)'));
  const dialIdx = rows.findIndex((r) => r.app === 'Dial');
  assert.ok(nameIdx < numIdx && numIdx < dialIdx);
});

test("AidaAdmin's current DID payload still works, without a local fallback", async () => {
  const { dids, runtime } = services();
  const result = await dids.provision(DID_ROUTE_ID, body('provisionDid') as never);
  assert.equal(result.status, 'provisioned');
  // No association was supplied, so none is claimed.
  assert.equal(result.fallbackPersisted, false);
  assert.equal(runtime.fallbacks.size, 0);
});

test('the extended DID payload persists the tenant-scoped fallback projection', async () => {
  const { dids, runtime } = services();
  const result = await dids.provision(DID_ROUTE_ID_2, body('provisionDidWithFallback') as never);
  assert.equal(result.fallbackPersisted, true);
  assert.deepEqual(runtime.fallbacks.get(DID_ROUTE_ID_2), {
    didRouteId: DID_ROUTE_ID_2,
    tenantId: '11111111-1111-4111-8111-111111111111',
    didE164: '+15559870002',
    destinationType: 'EXTENSION',
    destinationId: EXT_ID,
    enabled: true,
  });
});

test('a partially supplied DID fallback is refused rather than half-applied', async () => {
  const { dids } = services();
  const partial = { ...body('provisionDidWithFallback') };
  delete partial.destinationId;
  await assert.rejects(dids.provision(DID_ROUTE_ID_2, partial as never), /invalid provisioning request/);
});

test('AidaAdmin handset payload is accepted and its MAC normalized', async () => {
  const { extensions, handsets, adapter } = services();
  await extensions.create(body('provisionExtension') as never);

  const result = await handsets.provision(body('provisionHandset') as never);
  assert.equal(result.status, 'provisioned');
  assert.equal(result.provisioningResult?.ok, true);
  assert.equal((adapter.sipCalls[0] as { provisioningMac: string }).provisioningMac, 'C074AD112233');

  // The one-time enrollment token reaches the provisioning server and
  // nothing else — never the response.
  assert.equal(
    (adapter.configCalls[0] as { enrollmentToken: string }).enrollmentToken,
    'one-time-enrollment-token-1234',
  );
  assert.equal(JSON.stringify(result).includes('one-time-enrollment-token-1234'), false);
});

test('every fixture targets a route this service actually exposes', async () => {
  const { buildRoutes } = await import('../src/http/routes.js');
  const routes = buildRoutes({} as never).map((r) => `${r.method} ${r.pattern}`);
  const patternFor = (path: string): string =>
    path
      .replace('{extensionId}', ':extensionId')
      .replace('{ringGroupId}', ':ringGroupId')
      .replace('{didRouteId}', ':didRouteId');

  for (const [name, entry] of Object.entries(PAYLOADS)) {
    if (name.startsWith('_')) continue;
    const expected = `${entry.method} ${patternFor(entry.path)}`;
    assert.ok(routes.includes(expected), `${name} targets ${expected}, which no route serves`);
  }
});
