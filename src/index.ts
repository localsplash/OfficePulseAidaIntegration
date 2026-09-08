import { loadConfig } from './config.js';
import { platformEnvironment } from './platform/settings.js';
import { migrateRuntime } from './runtime/migrate.js';
import { Logger } from './logging/logger.js';
import { Readiness } from './readiness.js';
import { HttpApi, publicApiOptions } from './http/httpServer.js';
import { buildRoutes } from './http/routes.js';
import { assembleApiRoutes } from './http/apiRoutes.js';
import { voiceAvailability } from './http/voiceAvailability.js';
import { FastAgiServer } from './agi/fastAgiServer.js';
import { createBootstrapHandler, nativePbxFallback } from './agi/bootstrapHandler.js';
import { AriClient } from './ari/ariClient.js';
import { TakeoverManager } from './takeover/takeoverManager.js';
import { LiveKitClient } from './livekit/client.js';
import { LiveKitWebhookHandler } from './livekit/webhookHandler.js';
import { PusherNotifier } from './notify/pusher.js';
import { RuntimeCallEventSink } from './runtime/callEventSink.js';
import { mysqlPbxInventory, pbxInventoryRoutes } from './pbx/inventory.js';
import { MysqlRuntimeStore } from './runtime/mysqlRuntimeStore.js';
import { NocoDbReadClient } from './nocodb/api.js';
import { operationsConfig } from './operations/config.js';
import { OperationsServer } from './operations/server.js';
import { HttpOperationsIdentity } from './operations/identity.js';
import { AriDiagnostics } from './operations/live.js';

/** PBX configuration belongs to Asterisk; voice primitives never read a copied NocoDB routing graph. */
async function main(): Promise<void> {
  const environment = await platformEnvironment();
  const config = loadConfig(environment);
  const opsConfig = operationsConfig(environment);
  await migrateRuntime(config.runtimeMysql);
  const logger = new Logger({ level: config.logLevel });
  const runtime = new MysqlRuntimeStore(config.runtimeMysql);
  const inventory = config.pbxInventoryMysql ? mysqlPbxInventory(config.pbxInventoryMysql) : undefined;
  const noco = new NocoDbReadClient(config.nocodb);
  const readiness = new Readiness();
  readiness.register('runtime-mysql', 'critical');
  readiness.register('nocodb', 'critical');
  readiness.register('pbx-inventory', 'degraded', false, inventory ? 'Awaiting inventory check' : 'PBX inventory is not configured');
  readiness.observe((name, ready, detail) => { void runtime.setDependencyStatus(name, ready, detail).catch(() => {}); });
  readiness.register('ari', config.voiceEnabled ? 'critical' : 'degraded');
  readiness.register('livekit', 'degraded');
  readiness.register('native-pbx-admission', 'degraded', false, 'Native queue screening and takeover are not configured');
  const livekit = new LiveKitClient({ ...config.livekit, logger: logger.child({ component: 'livekit' }) });
  const notifier = config.pusher ? new PusherNotifier({ ...config.pusher, logger }) : undefined;
  if (notifier) readiness.register('pusher', 'degraded');
  const ari = new AriClient({ ...config.ari, logger: logger.child({ component: 'ari' }),
    onConnectionState: (connected) => readiness.set('ari', connected) });
  const takeover = new TakeoverManager({ ari, events: new RuntimeCallEventSink(runtime, logger, livekit), logger,
    drainTimeoutMs: config.takeover.drainTimeoutMs, defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
    defaultMohClass: config.takeover.defaultMohClass, livekitTrunkEndpoint: config.takeover.livekitTrunkEndpoint });
  ari.on('connected', () => { void takeover.reconcile().catch((err) => logger.error('reconciliation failed', { err })); });
  const routes = assembleApiRoutes(
    pbxInventoryRoutes(inventory?.reader ?? { extensions: async () => [], queues: async () => [] }, config.pbxInventoryScopes, !!inventory),
    voiceAvailability(buildRoutes({ runtime, takeover,
      defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
      webhooks: new LiveKitWebhookHandler({ ...config.livekit, runtime, logger }),
    }), config.voiceEnabled),
  );
  const fastAgi = new FastAgiServer({ ...config.fastAgi, logger,
    handlers: { bootstrap: createBootstrapHandler({ orchestrator: nativePbxFallback,
      officePulseInstanceId: config.officePulseInstanceId, logger }) } });
  const options = { logger, readiness, trustedServerCidrs: config.http.trustedServerCidrs, trustedProxyCidrs: config.http.trustedProxyCidrs,
    maxBodyBytes: config.http.maxBodyBytes, rateLimitPerMinute: config.http.rateLimitPerMinute, routes };
  const privateApi = new HttpApi(options);
  // Only health and signature-authenticated callbacks are public; no device admission is wired.
  const publicApi = new HttpApi({ ...publicApiOptions(options), documentation: true });
  await privateApi.listen(config.http.port, config.http.bind);
  await publicApi.listen(config.http.publicPort, config.http.bind);
  const operations = opsConfig ? new OperationsServer(opsConfig, {
    identity: new HttpOperationsIdentity(opsConfig.identityUrl, opsConfig.identitySecret),
    readiness, live: new AriDiagnostics(opsConfig.ari), inventory: inventory?.reader,
    scopes: config.pbxInventoryScopes, runtime,
  }) : undefined;
  if (operations && opsConfig) await operations.listen(opsConfig.port, config.http.bind);
  if (config.voiceEnabled) { ari.start(); await fastAgi.listen(); }
  else for (const dependency of ['ari', 'livekit']) readiness.set(dependency, false, 'Voice connectors disabled');
  const probe = async () => {
    if (config.voiceEnabled) {
      void livekit.ping().then((ok) => readiness.set('livekit', ok));
      if (notifier) void notifier.ping().then((ok) => readiness.set('pusher', ok));
    }
    const [runtimeReady, nocoReady] = await Promise.all([runtime.ping(), noco.ping()]);
    readiness.set('runtime-mysql', runtimeReady);
    readiness.set('nocodb', nocoReady);
    if (inventory) {
      try {
        if (!config.pbxInventoryScopes.size) throw new Error('No mapped tenants');
        for (const scope of config.pbxInventoryScopes.values()) {
          await inventory.reader.extensions(scope);
          await inventory.reader.queues(scope);
        }
        readiness.set('pbx-inventory', true);
      } catch { readiness.set('pbx-inventory', false, 'PBX inventory unavailable; verify connection, schema, grants and tenant scope'); }
    }
  };
  await probe();
  const timer = setInterval(() => { void probe(); }, 30000);
  timer.unref();
  logger.info('PBX inventory and diagnostic API listening', { privatePort: config.http.port, healthPort: config.http.publicPort });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    ari.stop();
    void Promise.allSettled([fastAgi.close(), privateApi.close(), publicApi.close(), operations?.close(), runtime.close(), inventory?.close()]).then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => { console.error(JSON.stringify({ level: 'error', message: 'startup failed', error: String(error) })); process.exit(1); });
