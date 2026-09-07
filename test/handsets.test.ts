import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionProvisioningService } from '../src/provisioning/extensions.js';
import { HandsetProvisioningService } from '../src/provisioning/handsets.js';
import {
  HttpDeviceProvisioningService,
  type DeviceProvisioningService,
  type HandsetConfigDelivery,
  type SipDeviceProvisioningRequest,
} from '../src/provisioning/deviceProvisioningAdapter.js';
import { NotFoundError, UpstreamError, ValidationError } from '../src/errors.js';
import { FakeRealtimeStore } from './helpers/fakeStore.js';
import { captureLogger } from './helpers/capture.js';

const TENANT = '2';
const EXT_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '88888888-8888-4888-8888-888888888888';

class FakeDeviceProvisioning implements DeviceProvisioningService {
  sipCalls: SipDeviceProvisioningRequest[] = [];
  configCalls: HandsetConfigDelivery[] = [];
  failSip = false;
  failConfig = false;

  async upsertSipDevice(req: SipDeviceProvisioningRequest): Promise<void> {
    if (this.failSip) throw new UpstreamError('sip provisioning down', 'sip-device');
    this.sipCalls.push(req);
  }

  async deliverHandsetConfig(req: HandsetConfigDelivery): Promise<void> {
    if (this.failConfig) throw new UpstreamError('config delivery down', 'handset-config');
    this.configCalls.push(req);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

async function setup(): Promise<{
  handsets: HandsetProvisioningService;
  extensions: ExtensionProvisioningService;
  adapter: FakeDeviceProvisioning;
  store: FakeRealtimeStore;
  lines: string[];
  sipSecret: string;
  sipUsername: string;
}> {
  const store = new FakeRealtimeStore();
  const { logger, lines } = captureLogger();
  const adapter = new FakeDeviceProvisioning();
  const extensions = new ExtensionProvisioningService({
    store,
    logger,
    defaultTransport: 'transport-udp',
    defaultAllow: 'ulaw,alaw',
    deviceProvisioning: adapter,
  });
  const created = await extensions.create({
    requestId: 'req-ext',
    tenantId: TENANT,
    extensionId: EXT_ID,
    extensionNumber: '100',
    context: 'office-main',
    displayName: 'Front Desk',
  });
  const handsets = new HandsetProvisioningService({
    store,
    logger,
    deviceProvisioning: adapter,
    aidaControlUrl: 'https://control.aida.test',
    pusherKey: 'pk_public',
    pusherCluster: 'mt1',
  });
  return {
    handsets,
    extensions,
    adapter,
    store,
    lines,
    sipSecret: created.sipSecret as string,
    sipUsername: created.sipUsername,
  };
}

const INPUT = {
  requestId: 'req-hs-1',
  extensionId: EXT_ID,
  deviceId: DEVICE_ID,
  provisioningMac: 'c0:74:ad:11:22:33',
  enrollmentToken: 'one-time-enrollment-token-123',
};

test('provision pushes SIP settings and handset config; response contains no secrets', async () => {
  const { handsets, adapter, store, sipSecret, sipUsername } = await setup();
  const result = await handsets.provision(INPUT);
  assert.equal(result.status, 'provisioned');
  assert.equal(result.provisioningResult?.ok, true);

  // MAC is normalized (separators stripped, uppercased) and used for lookup only.
  assert.equal(adapter.sipCalls[0]?.provisioningMac, 'C074AD112233');
  assert.equal(adapter.sipCalls[0]?.sipUsername, sipUsername);
  assert.equal(adapter.sipCalls[0]?.sipSecret, sipSecret);
  assert.deepEqual(adapter.configCalls[0], {
    provisioningMac: 'C074AD112233',
    deviceId: DEVICE_ID,
    aidaControlUrl: 'https://control.aida.test',
    pusherKey: 'pk_public',
    pusherCluster: 'mt1',
    enrollmentToken: 'one-time-enrollment-token-123',
    enrollmentExpiresAt: undefined,
  });
  // No secret material in the API response object.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(sipSecret));
  assert.ok(!serialized.includes('one-time-enrollment-token-123'));
  // Device mapping persisted for later rotation.
  assert.equal((await store.getAidaDeviceByExtension(EXT_ID))?.provisioning_mac, 'C074AD112233');
});

test('secrets never appear in logs during handset provisioning', async () => {
  const { handsets, lines, sipSecret } = await setup();
  await handsets.provision(INPUT);
  const joined = lines.join('\n');
  assert.ok(!joined.includes(sipSecret));
  assert.ok(!joined.includes('one-time-enrollment-token-123'));
});

test('invalid MAC is rejected before anything happens', async () => {
  const { handsets, adapter } = await setup();
  await assert.rejects(handsets.provision({ ...INPUT, provisioningMac: 'not-a-mac' }), ValidationError);
  await assert.rejects(handsets.provision({ ...INPUT, provisioningMac: 'C074AD11223' }), ValidationError);
  assert.equal(adapter.sipCalls.length, 0);
});

test('unknown extension is NotFound; no delivery happens', async () => {
  const { handsets, adapter } = await setup();
  await assert.rejects(
    handsets.provision({ ...INPUT, extensionId: '99999999-9999-4999-8999-999999999999' }),
    NotFoundError,
  );
  assert.equal(adapter.sipCalls.length, 0);
});

test('sip stage failure is reported to the caller with the failing stage', async () => {
  const { handsets, adapter } = await setup();
  adapter.failSip = true;
  const result = await handsets.provision(INPUT);
  assert.equal(result.provisioningResult?.ok, false);
  assert.equal(result.provisioningResult?.stage, 'sip-device');
  assert.equal(adapter.configCalls.length, 0);
});

test('partial failure (config stage) is reported; sip settings were delivered', async () => {
  const { handsets, adapter } = await setup();
  adapter.failConfig = true;
  const result = await handsets.provision(INPUT);
  assert.equal(result.provisioningResult?.ok, false);
  assert.equal(result.provisioningResult?.stage, 'handset-config');
  assert.equal(adapter.sipCalls.length, 1);
});

test('replay of the same requestId does not re-deliver secrets', async () => {
  const { handsets, adapter } = await setup();
  await handsets.provision(INPUT);
  const replay = await handsets.provision(INPUT);
  assert.equal(replay.status, 'replayed');
  assert.equal(adapter.sipCalls.length, 1);
  assert.equal(adapter.configCalls.length, 1);
});

test('secret rotation reprovisions the enrolled device with the new secret', async () => {
  const { handsets, extensions, adapter } = await setup();
  await handsets.provision(INPUT);
  const rotated = await extensions.rotateSecret(EXT_ID, { requestId: 'rot-1', reprovisionDevice: true });
  assert.equal(rotated.provisioningResult?.ok, true);
  assert.equal(adapter.sipCalls.length, 2);
  assert.equal(adapter.sipCalls[1]?.sipSecret, rotated.sipSecret);
  assert.equal(rotated.status, 'rotated');
  assert.equal(adapter.sipCalls[1]?.provisioningMac, 'C074AD112233');
});

test('http adapter retries once on 5xx and gives up on 4xx', async () => {
  const { logger } = captureLogger();
  const calls: number[] = [];
  let responses: number[] = [500, 204];
  const fetchImpl = (async () => {
    const status = responses[calls.length] ?? 204;
    calls.push(status);
    return new Response(null, { status });
  }) as typeof fetch;
  const adapter = new HttpDeviceProvisioningService({
    baseUrl: 'https://prov.test',
    timeoutMs: 200,
    retryDelayMs: 1,
    logger,
    fetchImpl,
  });
  await adapter.upsertSipDevice({ provisioningMac: 'C074AD112233', deviceId: DEVICE_ID, sipUsername: 'u', sipSecret: 's' });
  assert.deepEqual(calls, [500, 204]);

  calls.length = 0;
  responses = [400];
  await assert.rejects(
    adapter.upsertSipDevice({ provisioningMac: 'C074AD112233', deviceId: DEVICE_ID, sipUsername: 'u', sipSecret: 's' }),
    UpstreamError,
  );
  assert.deepEqual(calls, [400], '4xx must not retry');
});

test('http adapter timeout is bounded and surfaces as UpstreamError', async () => {
  const { logger } = captureLogger();
  const fetchImpl = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;
  const adapter = new HttpDeviceProvisioningService({
    baseUrl: 'https://prov.test',
    timeoutMs: 50,
    retryDelayMs: 1,
    logger,
    fetchImpl,
  });
  const started = Date.now();
  await assert.rejects(
    adapter.deliverHandsetConfig({
      provisioningMac: 'C074AD112233',
      deviceId: DEVICE_ID,
      aidaControlUrl: 'https://c',
      enrollmentToken: 'tok-tok-tok-tok-tok',
    }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 2000);
});
