import { digest, sameHash } from './agent/contract.js';
import { agentConfig } from './agent/config.js';
import { MysqlAdmissionStore } from './agent/store.js';
import { mysqlNativeAuthority, identityTenantEnabled } from './agent/native.js';
import { AgentConfigCache, nocoProfileSource } from './agent/profileCache.js';
import { BootstrapAuthority } from './agent/authority.js';
import { AgentMonitor } from './agent/monitor.js';
import { NativeCallOrchestrator } from './agent/orchestrator.js';
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
import { mysqlPbxInventory, pbxInventoryRoutes, type InventoryReader } from './pbx/inventory.js';
import { MysqlPbxProvisioner, pbxProvisioningRoutes } from './pbx/provisioning.js';
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
  const agent = agentConfig(environment);
  await migrateRuntime(config.runtimeMysql);
  const logger = new Logger({ level: config.logLevel });
  const runtime = new MysqlRuntimeStore(config.runtimeMysql);
  const inventory = config.pbxInventoryMysql ? mysqlPbxInventory(config.pbxInventoryMysql) : undefined;
  const provisioner = config.pbxProvisioningMysql ? new MysqlPbxProvisioner(config.pbxProvisioningMysql) : undefined;
  const noco = new NocoDbReadClient(config.nocodb);
  const readiness = new Readiness();
  readiness.register('runtime-mysql', 'critical');
  readiness.register('nocodb', 'critical');
  readiness.register('pbx-inventory', 'degraded', false, inventory ? 'Awaiting inventory check' : 'PBX inventory is not configured');
  readiness.register('pbx-provisioning', 'degraded', false, provisioner ? 'Awaiting provisioning database check' : 'PBX provisioning is disabled');
  readiness.register('pbx-apply', 'degraded', false, provisioner ? 'Asterisk delegation and effective apply state unknown; mutations report committed only' : 'PBX provisioning is disabled');
  readiness.observe((name, ready, detail) => { void runtime.setDependencyStatus(name, ready, detail).catch(() => {}); });
  readiness.register('ari', config.voiceEnabled ? 'critical' : 'degraded');
  readiness.register('livekit', 'degraded');
  readiness.register('native-pbx-admission', 'degraded', false, 'Native queue screening and takeover are not configured');
  const livekit = new LiveKitClient({ ...config.livekit, logger: logger.child({ component: 'livekit' }) });
  const notifier = config.pusher ? new PusherNotifier({ ...config.pusher, logger }) : undefined;
  if (notifier) readiness.register('pusher', 'degraded');
  const ari = new AriClient({ ...config.ari, logger: logger.child({ component: 'ari' }),
    onConnectionState: (connected) => readiness.set('ari', connected) });
  const admissions = agent ? new MysqlAdmissionStore(config.runtimeMysql) : undefined;
  // Business configuration is loaded here, once, and refreshed on its own timer.
  // Admission, credential consumption and monitoring only read the cache (#19).
  // Assignments come from PlatformConfig aida_tbl_ProfileAssignment for this instance (#23), never an environment map.
  const profiles = agent ? new AgentConfigCache({ source: nocoProfileSource(noco, config.officePulseInstanceId), refreshMs: agent.configRefreshMs,
    logger: logger.child({ component: 'agent-config' }),
    ...(agent.identityTenantCheck ? { tenantEnabled: identityTenantEnabled(agent.identityOrigin,
      { clientSecret: agent.identitySecret, logger: logger.child({ component: 'identity' }) }) } : {}) }) : undefined;
  if (agent) readiness.register('agent-config-cache', 'degraded', false, 'Agent business configuration has not been loaded');
  const native = agent && profiles ? mysqlNativeAuthority(config.pbxInventoryMysql!, { pbxInstanceId: config.officePulseInstanceId, profiles }) : undefined;
  const authority = agent && admissions && native ? new BootstrapAuthority({ store: admissions, runtime,
    native: native.authority, livekit, routeAttribute: agent.routeAttribute, instanceId: config.officePulseInstanceId }) : undefined;
  let monitor: AgentMonitor | undefined;
  const takeover = new TakeoverManager({ ari, events: new RuntimeCallEventSink(runtime, logger, livekit), logger,
    drainTimeoutMs: config.takeover.drainTimeoutMs, defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
    defaultMohClass: config.takeover.defaultMohClass, livekitTrunkEndpoint: config.takeover.livekitTrunkEndpoint,
    ...(admissions ? { nativeAdmission: {
      validate: async (id: string, linkedId: string | undefined, routeToken: string | undefined) => {
        const a = await admissions.get(id);
        // A process restart invalidates unfinished monitoring; the caller returns locally.
        return !!a && !!monitor?.isMonitoring(id) && a.status === 'dispatched' && a.expiresAt > Date.now() && a.linkedId === linkedId && !!routeToken && sameHash(a.routeHash, digest(routeToken));
      },
      failed: async (id: string) => { await admissions.transition(id, 'fallback', 'agent-fallback'); },
      ended: async (id: string) => { await admissions.transition(id, 'ended', 'call-completed'); await monitor?.stop(id); },
      fallbackTarget: async (id: string) => {
        const call = await runtime.getCallSession(id);
        // The target was verified against native queue ownership before admission and is pinned per call.
        return call?.officePulseInstanceId === config.officePulseInstanceId && call.destinationType === 'QUEUE' && /^[a-zA-Z0-9_.-]{1,60}$/.test(call.destinationId ?? '')
          ? { context: 'aida-agent-queue-fallback', exten: call.destinationId! } : undefined;
      },
    } } : {}) });
  if (authority && agent) monitor = new AgentMonitor({ authority, ...config.livekit, fallback: id => takeover.fallback(id),
    logger: logger.child({ component: 'agent-monitor' }) });
  const orchestrator = authority && agent && admissions && native && monitor ? new NativeCallOrchestrator({
    runtime, store: admissions, native: native.authority, livekit, monitor, instanceId: config.officePulseInstanceId,
    observeCaller: (id, channelId) => takeover.observeCaller(id, channelId),
    startupTimeoutMs: agent.startupTimeoutMs, setupTimeoutMs: Math.max(100, config.fastAgi.sessionTimeoutMs - 500), available: () => readiness.snapshot().components.ari?.ready === true,
    logger: logger.child({ component: 'admission' }),
  }) : nativePbxFallback;
  ari.on('connected', () => { void takeover.reconcile().catch((err) => logger.error('reconciliation failed', { err })); });
  const noInventory: InventoryReader = { contexts: async () => [], extensions: async () => [], queues: async () => [] };
  const routes = assembleApiRoutes(
    [
      ...(authority ? [authority.route(config.voiceEnabled)] : [{ method: 'POST', pattern: '/v1/agent/calls/:callSessionId/bootstrap', trusted: false, rawBody: true,
        handler: () => ({ status: 503, body: { error: 'authority_unavailable' } }) }]),
      ...pbxInventoryRoutes(inventory?.reader ?? noInventory, !!inventory, config.officePulseInstanceId, !!provisioner),
      ...pbxProvisioningRoutes(provisioner, !!provisioner, config.officePulseInstanceId),
    ],
    voiceAvailability(buildRoutes({ runtime, takeover,
      defaultRingTimeoutSeconds: config.takeover.ringTimeoutSeconds,
      webhooks: new LiveKitWebhookHandler({ ...config.livekit, runtime, logger }),
    }), config.voiceEnabled),
  );
  const fastAgi = new FastAgiServer({ ...config.fastAgi, logger,
    handlers: { bootstrap: createBootstrapHandler({ orchestrator,
      officePulseInstanceId: config.officePulseInstanceId, logger }) } });
  const options = { logger, readiness, pbxInstanceId: config.officePulseInstanceId, trustedServerCidrs: config.http.trustedServerCidrs, trustedProxyCidrs: config.http.trustedProxyCidrs,
    maxBodyBytes: config.http.maxBodyBytes, rateLimitPerMinute: config.http.rateLimitPerMinute, routes };
  const privateApi = new HttpApi(options);
  // Public routes authenticate with a webhook signature or one-time Agent credentials.
  const publicApi = new HttpApi({ ...publicApiOptions(options), documentation: true });
  if (profiles) {
    // Startup load: a failure is not fatal — calls fall back to the PBX queue
    // until a later refresh succeeds, and readiness reports the gap.
    const loaded = await profiles.refresh().catch(() => false);
    logger.info('agent business configuration load attempted', { ...profiles.status(), loaded });
    profiles.start();
  }
  await privateApi.listen(config.http.port, config.http.bind);
  await publicApi.listen(config.http.publicPort, config.http.bind);
  const operations = opsConfig ? new OperationsServer(opsConfig, {
    identity: new HttpOperationsIdentity(opsConfig.identityUrl, opsConfig.identitySecret),
    readiness, live: new AriDiagnostics(opsConfig.ari), inventory: inventory?.reader,
    pbxInstanceId: config.officePulseInstanceId, runtime, adminRoutes: routes,
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
      // Listing contexts touches both native tables the context-scoped reads depend on.
      try { await inventory.reader.contexts(); readiness.set('pbx-inventory', true); }
      catch { readiness.set('pbx-inventory', false, 'PBX inventory unavailable; verify connection, schema and grants'); }
    }
    if (provisioner) {
      const connected = await provisioner.ping();
      readiness.set('pbx-provisioning', connected, connected ? 'Provisioning database available; effective Asterisk state is not verified' : 'Provisioning database unavailable');
    }
    if (profiles) {
      const status = profiles.status();
      // Keep the detail stable across refreshes so readiness observers record transitions, not heartbeats.
      readiness.set('agent-config-cache', status.complete, status.complete
        ? `Cached assistant configuration for ${status.loadedKeys.length} enabled profile assignment(s); calls do not read PlatformConfig or Identity`
        : `Cached ${status.loadedKeys.length}/${status.configuredAssignments} enabled profile assignment(s); calls for unassigned or uncached scopes fall back to the PBX queue`);
    }
    const components = readiness.snapshot().components;
    // NocoDB/Identity availability no longer gates admission: the cache does, once it holds at least one assignment.
    readiness.set('native-pbx-admission', !!agent && (profiles?.status().loadedKeys.length ?? 0) > 0 && ['runtime-mysql','ari','livekit','pbx-inventory','agent-config-cache'].every(key => components[key]?.ready === true),
      agent ? 'Admission implementation configured; real-call acceptance is separate' : 'Native agent admission is disabled');
  };
  await probe();
  const timer = setInterval(() => { void probe(); }, 30000);
  timer.unref();
  logger.info('PBX inventory and diagnostic API listening', { privatePort: config.http.port, healthPort: config.http.publicPort, pbxInstanceId: config.officePulseInstanceId });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    profiles?.stop();
    ari.stop();
    void Promise.allSettled([fastAgi.close(), privateApi.close(), publicApi.close(), operations?.close(), monitor?.close(), admissions?.close(), native?.close(), runtime.close(), inventory?.close(), provisioner?.close()]).then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => { console.error(JSON.stringify({ level: 'error', message: 'startup failed', error: String(error) })); process.exit(1); });
