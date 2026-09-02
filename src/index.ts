import { loadConfig } from './config.js';
import { Logger } from './logging/logger.js';
import { Readiness } from './readiness.js';
import { HttpApi } from './http/httpServer.js';
import { buildRoutes } from './http/routes.js';
import { FastAgiServer } from './agi/fastAgiServer.js';
import { createBootstrapHandler } from './agi/bootstrapHandler.js';
import { AriClient } from './ari/ariClient.js';
import { TakeoverManager } from './takeover/takeoverManager.js';
import { MysqlRealtimeStore } from './provisioning/mysqlStore.js';
import { MysqlRuntimeStore } from './runtime/mysqlRuntimeStore.js';
import { RuntimeCallEventSink } from './runtime/callEventSink.js';
import { NocoDbReadClient } from './nocodb/api.js';
import { NocoConfigRepository } from './nocodb/configRepository.js';
import { LiveKitClient } from './livekit/client.js';
import { LiveKitWebhookHandler } from './livekit/webhookHandler.js';
import { PusherNotifier } from './notify/pusher.js';
import { CallOrchestrator } from './orchestrator/callOrchestrator.js';
import { FallbackResolver } from './orchestrator/fallbackResolver.js';
import { ExtensionProvisioningService } from './provisioning/extensions.js';
import { RingGroupProvisioningService } from './provisioning/ringGroups.js';
import { DidProvisioningService } from './provisioning/dids.js';
import { HandsetProvisioningService } from './provisioning/handsets.js';
import { HttpDeviceProvisioningService } from './provisioning/deviceProvisioningAdapter.js';

/**
 * Service entrypoint for LSAidaOffice01.
 *
 * Since issue #9 this process is the call orchestrator as well as the
 * Asterisk adapter: it reads AidaAdmin's NocoDB base, owns the
 * `aida_officepulse` runtime database, and drives LiveKit directly. There
 * is no AidaControl.
 *
 * Startup order: validate configuration, expose health first, connect ARI
 * (reconciling on every connect), then open FastAGI. Dependency loss
 * degrades the affected surface — screening falls back to the DID's own
 * local destination — without stopping the process.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({ level: config.logLevel });
  const readiness = new Readiness();

  // Critical: without these the service cannot do its job at all.
  readiness.register('ari', 'critical');
  readiness.register('asterisk-mysql', 'critical');
  readiness.register('runtime-mysql', 'critical');
  // Degraded: callers still reach a human through the local fallback.
  readiness.register('nocodb', 'degraded');
  readiness.register('livekit', 'degraded');
  if (config.pusher) readiness.register('pusher', 'degraded');
  if (config.provisioningServer) readiness.register('provisioning-adapter', 'degraded');

  const realtimeStore = new MysqlRealtimeStore(config.asteriskMysql);
  const runtimeStore = new MysqlRuntimeStore(config.runtimeMysql);

  // Every readiness transition is recorded in the runtime database so
  // AidaAdmin's read-only account can see dependency history.
  readiness.observe((name, ready, detail) => {
    void runtimeStore.setDependencyStatus(name, ready, detail).catch(() => {});
  });

  const nocoClient = new NocoDbReadClient({
    baseUrl: config.nocodb.baseUrl,
    apiToken: config.nocodb.apiToken,
    baseName: config.nocodb.baseName,
    timeoutMs: config.nocodb.timeoutMs,
  });
  const configRepository = new NocoConfigRepository(nocoClient);

  const livekit = new LiveKitClient({
    url: config.livekit.url,
    apiKey: config.livekit.apiKey,
    apiSecret: config.livekit.apiSecret,
    agentName: config.livekit.agentName,
    timeoutMs: config.livekit.timeoutMs,
    logger: logger.child({ component: 'livekit' }),
  });

  const notifier = config.pusher
    ? new PusherNotifier({ ...config.pusher, logger: logger.child({ component: 'pusher' }) })
    : undefined;

  const deviceProvisioning = config.provisioningServer
    ? new HttpDeviceProvisioningService({
        baseUrl: config.provisioningServer.baseUrl,
        authToken: config.provisioningServer.authToken,
        timeoutMs: config.provisioningServer.timeoutMs,
        logger: logger.child({ component: 'device-provisioning' }),
      })
    : undefined;

  const fallbackResolver = new FallbackResolver({
    runtime: runtimeStore,
    realtime: realtimeStore,
    logger: logger.child({ component: 'fallback' }),
    operatorDefault:
      config.call.operatorFallbackContext && config.call.operatorFallbackExtension
        ? { context: config.call.operatorFallbackContext, exten: config.call.operatorFallbackExtension }
        : undefined,
  });

  const orchestrator = new CallOrchestrator({
    config: configRepository,
    runtime: runtimeStore,
    livekit,
    notifier,
    fallbackResolver,
    logger: logger.child({ component: 'orchestrator' }),
    livekitSipHost: config.livekit.sipHost,
    defaultLocale: config.call.defaultLocale,
  });

  const ari = new AriClient({
    url: config.ari.url,
    username: config.ari.username,
    password: config.ari.password,
    app: config.ari.app,
    logger: logger.child({ component: 'ari' }),
    onConnectionState: (connected) => readiness.set('ari', connected),
  });

  const takeover = new TakeoverManager({
    ari,
    events: new RuntimeCallEventSink(runtimeStore, logger.child({ component: 'call-events' })),
    logger: logger.child({ component: 'takeover' }),
    drainTimeoutMs: config.takeover.drainTimeoutMs,
    defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
    defaultMohClass: config.takeover.defaultMohClass,
    livekitTrunkEndpoint: config.takeover.livekitTrunkEndpoint,
  });
  ari.on('connected', () => {
    void takeover.reconcile().catch((err) => logger.error('reconciliation failed', { err }));
  });

  const provisioningLogger = logger.child({ component: 'provisioning' });
  const extensions = new ExtensionProvisioningService({
    store: realtimeStore,
    logger: provisioningLogger,
    defaultTransport: config.dialplan.defaultTransport,
    defaultAllow: config.dialplan.defaultAllow,
    deviceProvisioning,
  });
  const ringGroups = new RingGroupProvisioningService({ store: realtimeStore, logger: provisioningLogger });
  const dids = new DidProvisioningService({
    store: realtimeStore,
    runtime: runtimeStore,
    logger: provisioningLogger,
    officePulseInstanceId: config.officePulseInstanceId,
    fastAgiHost: config.fastAgi.advertisedHost,
    fastAgiPort: config.fastAgi.port,
    disclosureContext: config.dialplan.disclosureContext,
    postBootstrapContext: config.dialplan.postBootstrapContext,
  });
  const handsets = new HandsetProvisioningService({
    store: realtimeStore,
    logger: provisioningLogger,
    deviceProvisioning,
    aidaControlUrl: config.handsetConfig.aidaControlUrl,
    pusherKey: config.handsetConfig.pusherKey,
    pusherCluster: config.handsetConfig.pusherCluster,
  });

  const httpApi = new HttpApi({
    logger: logger.child({ component: 'http' }),
    readiness,
    trustedServerCidrs: config.http.trustedServerCidrs,
    trustedProxyCidrs: config.http.trustedProxyCidrs,
    maxBodyBytes: config.http.maxBodyBytes,
    rateLimitPerMinute: config.http.rateLimitPerMinute,
    routes: buildRoutes({
      extensions,
      ringGroups,
      dids,
      handsets,
      takeover,
      runtime: runtimeStore,
      fallbackResolver,
      webhooks: new LiveKitWebhookHandler({
        apiKey: config.livekit.apiKey,
        apiSecret: config.livekit.apiSecret,
        runtime: runtimeStore,
        logger: logger.child({ component: 'livekit-webhook' }),
      }),
      defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
    }),
  });

  const fastAgi = new FastAgiServer({
    port: config.fastAgi.port,
    bind: config.fastAgi.bind,
    maxConnections: config.fastAgi.maxConnections,
    sessionTimeoutMs: config.fastAgi.sessionTimeoutMs,
    logger: logger.child({ component: 'fastagi' }),
    handlers: {
      bootstrap: createBootstrapHandler({
        orchestrator,
        officePulseInstanceId: config.officePulseInstanceId,
        logger: logger.child({ component: 'bootstrap' }),
      }),
    },
  });

  await httpApi.listen(config.http.port, config.http.bind);
  logger.info('http api listening', { port: config.http.port, bind: config.http.bind });
  ari.start();
  await fastAgi.listen();
  logger.info('fastagi listening', { port: config.fastAgi.port, bind: config.fastAgi.bind });

  const probe = (): void => {
    void realtimeStore.ping().then((ok) => readiness.set('asterisk-mysql', ok));
    void runtimeStore.ping().then((ok) => readiness.set('runtime-mysql', ok));
    void nocoClient.ping().then((ok) => readiness.set('nocodb', ok));
    void livekit.ping().then((ok) => readiness.set('livekit', ok));
    if (notifier) void notifier.ping().then((ok) => readiness.set('pusher', ok));
    if (deviceProvisioning) {
      void deviceProvisioning.ping().then((ok) => readiness.set('provisioning-adapter', ok));
    }
  };
  const dependencyProbe = setInterval(probe, 10_000);
  dependencyProbe.unref();
  probe();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    clearInterval(dependencyProbe);
    void (async () => {
      // Stop accepting new work first, then release dependencies. Live
      // caller-human bridges are never torn down by shutdown — Asterisk
      // owns established media.
      await fastAgi.close().catch(() => {});
      await httpApi.close().catch(() => {});
      ari.stop();
      await realtimeStore.close().catch(() => {});
      await runtimeStore.close().catch(() => {});
      logger.info('shutdown complete');
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', err: String(err) }));
  process.exit(1);
});
