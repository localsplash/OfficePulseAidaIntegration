import { loadConfig } from './config.js';
import { Logger } from './logging/logger.js';
import { Readiness } from './readiness.js';
import { HttpApi } from './http/httpServer.js';
import { buildRoutes } from './http/routes.js';
import { FastAgiServer } from './agi/fastAgiServer.js';
import { createBootstrapHandler } from './agi/bootstrapHandler.js';
import { AidaControlClient } from './aidacontrol/client.js';
import { AriClient } from './ari/ariClient.js';
import { TakeoverManager } from './takeover/takeoverManager.js';
import { MysqlRealtimeStore } from './provisioning/mysqlStore.js';
import { ExtensionProvisioningService } from './provisioning/extensions.js';
import { RingGroupProvisioningService } from './provisioning/ringGroups.js';
import { DidProvisioningService } from './provisioning/dids.js';
import { HandsetProvisioningService } from './provisioning/handsets.js';
import { StoreFallbackResolver } from './provisioning/fallbackResolver.js';
import { HttpDeviceProvisioningService } from './provisioning/deviceProvisioningAdapter.js';

/**
 * Service entrypoint for LSAidaOffice01. Startup order:
 *  1. validate configuration (fail fast),
 *  2. bring up health/readiness HTTP first,
 *  3. connect ARI (with reconciliation on every (re)connect),
 *  4. open the FastAGI listener,
 *  5. watch MySQL / AidaControl reachability for readiness.
 *
 * Degradation: any dependency loss flips its readiness component and the
 * affected surface degrades (bootstrap falls back locally, provisioning
 * returns errors to AidaAdmin) — the process itself stays up and
 * reconciles when the dependency returns.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({ level: config.logLevel });
  const readiness = new Readiness();
  readiness.register('ari');
  readiness.register('mysql');
  readiness.register('aidacontrol');

  const store = new MysqlRealtimeStore(config.mysql);
  const aidaControl = new AidaControlClient({
    baseUrl: config.aidaControl.baseUrl,
    timeoutMs: config.aidaControl.timeoutMs,
    logger: logger.child({ component: 'aidacontrol' }),
  });
  const deviceProvisioning = config.provisioningServer
    ? new HttpDeviceProvisioningService({
        baseUrl: config.provisioningServer.baseUrl,
        authToken: config.provisioningServer.authToken,
        timeoutMs: config.provisioningServer.timeoutMs,
        logger: logger.child({ component: 'device-provisioning' }),
      })
    : undefined;

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
    events: aidaControl,
    logger: logger.child({ component: 'takeover' }),
    drainTimeoutMs: config.takeover.drainTimeoutMs,
    defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
    defaultMohClass: config.takeover.defaultMohClass,
    livekitTrunkEndpoint: config.takeover.livekitTrunkEndpoint,
  });
  ari.on('connected', () => {
    void takeover.reconcile().catch((err) => logger.error('reconciliation failed', { err }));
  });

  const extensions = new ExtensionProvisioningService({
    store,
    logger: logger.child({ component: 'provisioning' }),
    defaultTransport: config.dialplan.defaultTransport,
    defaultAllow: config.dialplan.defaultAllow,
    deviceProvisioning,
  });
  const ringGroups = new RingGroupProvisioningService({ store, logger: logger.child({ component: 'provisioning' }) });
  const dids = new DidProvisioningService({
    store,
    logger: logger.child({ component: 'provisioning' }),
    officePulseInstanceId: config.officePulseInstanceId,
    fastAgiHost: config.fastAgi.advertisedHost,
    fastAgiPort: config.fastAgi.port,
    disclosureContext: config.dialplan.disclosureContext,
    postBootstrapContext: config.dialplan.postBootstrapContext,
  });
  const handsets = new HandsetProvisioningService({
    store,
    logger: logger.child({ component: 'provisioning' }),
    deviceProvisioning,
    aidaControlUrl: config.handsetConfig.aidaControlUrl,
    pusherKey: config.handsetConfig.pusherKey,
    pusherCluster: config.handsetConfig.pusherCluster,
  });
  const destinationResolver = new StoreFallbackResolver(store);

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
      destinationResolver,
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
        aidaControl,
        fallbackResolver: destinationResolver,
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

  const dependencyProbe = setInterval(() => {
    void store.ping().then((ok) => readiness.set('mysql', ok));
    void aidaControl.ping().then((ok) => readiness.set('aidacontrol', ok));
  }, 10_000);
  dependencyProbe.unref();
  void store.ping().then((ok) => readiness.set('mysql', ok));
  void aidaControl.ping().then((ok) => readiness.set('aidacontrol', ok));

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
      await store.close().catch(() => {});
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
