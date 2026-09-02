import type { Logger } from '../logging/logger.js';
import { ConflictError, NotFoundError, UpstreamError } from '../errors.js';
import type { RealtimeStore } from './store.js';
import { normalizeMac, requireRequestId, requireUuid, optionalProfile, throwIfProblems } from './validate.js';
import type { DeviceProvisioningService } from './deviceProvisioningAdapter.js';

export interface HandsetProvisionInput {
  requestId: string;
  extensionId: string;
  deviceId: string;
  provisioningMac: string;
  provisioningProfile?: string;
  /** One-time enrollment material minted by AidaAdmin; delivered to the
   *  provisioning server in this transaction and never stored here. */
  enrollmentToken: string;
  enrollmentExpiresAt?: string;
}

export interface HandsetProvisionResult {
  status: 'provisioned' | 'replayed';
  provisioningResult?: { ok: boolean; stage?: string; detail?: string };
}

export interface HandsetServiceDeps {
  store: RealtimeStore;
  logger: Logger;
  deviceProvisioning?: DeviceProvisioningService;
  aidaControlUrl: string;
  pusherKey?: string;
  pusherCluster?: string;
  sipServer?: string;
}

/**
 * MAC-based handset provisioning (POC issue 6). Bridges AidaAdmin's
 * extension/device creation to the existing HTTPS provisioning server:
 *
 *  1. persist the device↔extension mapping (MAC is lookup data only),
 *  2. push the Grandstream SIP settings using the current SIP secret,
 *  3. deliver the AidaHandset managed configuration incl. the one-time
 *     enrollment token.
 *
 * Plaintext secret material (SIP secret, enrollment token) exists only
 * inside this single provisioning transaction: it is read from / passed
 * through, never returned in a response, never logged, never stored by
 * this service. Failures are returned to AidaAdmin synchronously — there
 * is no background sync or retry queue.
 */
export class HandsetProvisioningService {
  constructor(private readonly deps: HandsetServiceDeps) {}

  async provision(raw: HandsetProvisionInput): Promise<HandsetProvisionResult> {
    const problems: string[] = [];
    const requestId = requireRequestId(raw.requestId, 'requestId', problems);
    const extensionId = requireUuid(raw.extensionId, 'extensionId', problems);
    const deviceId = requireUuid(raw.deviceId, 'deviceId', problems);
    const provisioningMac = normalizeMac(raw.provisioningMac, 'provisioningMac', problems);
    const provisioningProfile = optionalProfile(raw.provisioningProfile, 'provisioningProfile', problems);
    if (typeof raw.enrollmentToken !== 'string' || raw.enrollmentToken.length < 16) {
      problems.push('enrollmentToken must be a string of at least 16 characters');
    }
    throwIfProblems(problems);

    const priorRequest = await this.deps.store.getRequest(requestId);
    if (priorRequest) {
      if (priorRequest.kind === 'HANDSET' && priorRequest.external_id === deviceId) {
        // Replay: the original transaction already delivered the secrets;
        // never re-run the delivery for a duplicate request.
        return { status: 'replayed' };
      }
      throw new ConflictError(`requestId ${requestId} was already used for a different operation`);
    }

    const extension = await this.deps.store.getAidaObject('EXTENSION', extensionId);
    if (!extension || !extension.endpoint_id) {
      throw new NotFoundError(`extension ${extensionId} is not provisioned`);
    }
    const auth = await this.deps.store.getAuth(extension.endpoint_id);
    if (!auth) throw new NotFoundError(`extension ${extensionId} has no auth record`);
    if (!this.deps.deviceProvisioning) {
      throw new UpstreamError('no provisioning server configured', 'sip-device');
    }

    // Persist the mapping first so a later secret rotation can find the
    // device even if the delivery below fails and is retried by AidaAdmin
    // with a new requestId.
    await this.deps.store.withTransaction(async (tx) => {
      await tx.upsertAidaDevice({
        device_id: deviceId,
        extension_external_id: extensionId,
        provisioning_mac: provisioningMac,
        provisioning_profile: provisioningProfile ?? null,
      });
      await tx.recordRequest({ request_id: requestId, kind: 'HANDSET', external_id: deviceId, action: 'provision' });
    });

    const log = this.deps.logger.child({ extensionId, deviceId, mac: provisioningMac });
    try {
      await this.deps.deviceProvisioning.upsertSipDevice({
        provisioningMac,
        deviceId,
        sipUsername: auth.username,
        sipSecret: auth.password,
        sipServer: this.deps.sipServer,
        provisioningProfile,
      });
    } catch (err) {
      log.warn('sip device provisioning failed', { err });
      return { status: 'provisioned', provisioningResult: { ok: false, stage: 'sip-device', detail: (err as Error).message } };
    }

    try {
      await this.deps.deviceProvisioning.deliverHandsetConfig({
        provisioningMac,
        deviceId,
        aidaControlUrl: this.deps.aidaControlUrl,
        pusherKey: this.deps.pusherKey,
        pusherCluster: this.deps.pusherCluster,
        enrollmentToken: raw.enrollmentToken,
        enrollmentExpiresAt: raw.enrollmentExpiresAt,
      });
    } catch (err) {
      // Partial failure: SIP settings delivered, handset config not.
      log.warn('handset config delivery failed', { err });
      return {
        status: 'provisioned',
        provisioningResult: { ok: false, stage: 'handset-config', detail: (err as Error).message },
      };
    }

    log.info('handset provisioned');
    return { status: 'provisioned', provisioningResult: { ok: true } };
  }
}
