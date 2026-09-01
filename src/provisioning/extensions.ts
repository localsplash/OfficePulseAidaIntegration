import type { Logger } from '../logging/logger.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { DialplanRow, RealtimeStore } from './store.js';
import { generateSipSecret } from './secrets.js';
import {
  formatCallerId,
  optionalCallerIdName,
  optionalE164,
  optionalProfile,
  requireBoolean,
  requireContext,
  requireExtension,
  requireRequestId,
  requireUuid,
  sipUsernameFor,
  throwIfProblems,
} from './validate.js';
import type { DeviceProvisioningService } from './deviceProvisioningAdapter.js';

export interface ExtensionCreateInput {
  requestId: string;
  tenantId: string;
  extensionId: string;
  extensionNumber: string;
  context: string;
  displayName: string;
  callerIdName?: string;
  callerIdNumber?: string;
  provisioningProfile?: string;
}

/**
 * `status` discriminates a real create from an idempotent replay.
 *
 * A replay deliberately carries NO `sipSecret`. The secret is generated
 * once and shown once; re-serving it on every replay of a `requestId`
 * would turn an at-least-once retry into an unbounded secret oracle. When
 * AidaAdmin loses the original response the recovery is an explicit
 * rotation, which is auditable — not a silent re-read.
 */
export interface ExtensionCreateResult {
  status: 'created' | 'already-applied';
  sipUsername: string;
  sipSecret?: string;
}

export interface ExtensionUpdateInput {
  extensionNumber: string;
  context: string;
  displayName: string;
  callerIdName?: string;
  callerIdNumber?: string;
  provisioningProfile?: string;
  enabled: boolean;
}

export interface RotateSecretInput {
  requestId: string;
  reprovisionDevice: boolean;
}

export interface RotateSecretResult {
  status: 'rotated' | 'already-applied';
  /** Present only on a real rotation; never re-served on a replay. */
  sipSecret?: string;
  provisioningResult?: { ok: boolean; detail?: string };
}

export interface ExtensionServiceDeps {
  store: RealtimeStore;
  logger: Logger;
  defaultTransport: string;
  defaultAllow: string;
  /** Endpoints created disabled route here instead of a live context. */
  disabledContext?: string;
  deviceProvisioning?: DeviceProvisioningService;
  sipServer?: string;
}

/** The realtime dialplan rows that make an extension dialable. */
export function extensionDialplanRows(sipUsername: string): DialplanRow[] {
  return [
    { priority: 1, app: 'Dial', appdata: `PJSIP/${sipUsername},20` },
    { priority: 2, app: 'Hangup', appdata: '' },
  ];
}

/**
 * Extension provisioning against Asterisk Realtime (POC issue 2).
 * One transaction writes ps_aors + ps_auths + ps_endpoints + the dialplan
 * rows + the aida_object mapping; any failure rolls all of it back.
 *
 * Secret contract: the generated SIP secret is stored only in ps_auths
 * and returned exactly once per create/rotation. Replaying the same
 * requestId re-returns that create's outcome; any other read path never
 * exposes an existing secret.
 */
export class ExtensionProvisioningService {
  constructor(private readonly deps: ExtensionServiceDeps) {}

  async create(raw: ExtensionCreateInput): Promise<ExtensionCreateResult> {
    const problems: string[] = [];
    const requestId = requireRequestId(raw.requestId, 'requestId', problems);
    const tenantId = requireUuid(raw.tenantId, 'tenantId', problems);
    const extensionId = requireUuid(raw.extensionId, 'extensionId', problems);
    const extensionNumber = requireExtension(raw.extensionNumber, 'extensionNumber', problems);
    const context = requireContext(raw.context, 'context', problems);
    const displayName = optionalCallerIdName(raw.displayName, 'displayName', problems) ?? '';
    if (displayName === '') problems.push('displayName is required');
    const callerIdName = optionalCallerIdName(raw.callerIdName, 'callerIdName', problems);
    const callerIdNumber = optionalE164(raw.callerIdNumber, 'callerIdNumber', problems);
    optionalProfile(raw.provisioningProfile, 'provisioningProfile', problems);
    throwIfProblems(problems);

    const existing = await this.deps.store.getAidaObject('EXTENSION', extensionId);
    const priorRequest = await this.deps.store.getRequest(requestId);
    if (existing && priorRequest && priorRequest.external_id === extensionId && priorRequest.action === 'create') {
      // Idempotent replay: confirm what was applied, without the secret.
      // Recovering a lost response requires an explicit rotation.
      return { status: 'already-applied', sipUsername: existing.endpoint_id as string };
    }
    if (existing) {
      throw new ConflictError(`extension ${extensionId} is already provisioned; existing secrets are never returned`);
    }
    if (priorRequest) {
      throw new ConflictError(`requestId ${requestId} was already used for a different operation`);
    }
    // Any object already at this location collides, not just an extension:
    // a ring group's virtual extension occupies the same dialplan slot.
    const occupant = await this.deps.store.findObjectAtLocation(context, extensionNumber);
    if (occupant) {
      throw new ConflictError(
        `dialplan location ${context}/${extensionNumber} is already used by ${occupant.kind} ${occupant.external_id}`,
      );
    }

    const sipUsername = sipUsernameFor(tenantId, extensionNumber);
    const sipSecret = generateSipSecret();
    const callerid = formatCallerId(callerIdName ?? displayName, callerIdNumber);

    await this.deps.store.withTransaction(async (tx) => {
      await tx.upsertAor({ id: sipUsername, max_contacts: 1, remove_existing: 'yes' });
      await tx.upsertAuth({ id: sipUsername, auth_type: 'userpass', username: sipUsername, password: sipSecret });
      await tx.upsertEndpoint({
        id: sipUsername,
        transport: this.deps.defaultTransport,
        aors: sipUsername,
        auth: sipUsername,
        context,
        disallow: 'all',
        allow: this.deps.defaultAllow,
        callerid,
      });
      await tx.replaceDialplan(context, extensionNumber, extensionDialplanRows(sipUsername));
      await tx.upsertAidaObject({
        kind: 'EXTENSION',
        external_id: extensionId,
        tenant_id: tenantId,
        context,
        exten: extensionNumber,
        endpoint_id: sipUsername,
        enabled: 1,
      });
      await tx.recordRequest({ request_id: requestId, kind: 'EXTENSION', external_id: extensionId, action: 'create' });
    });

    this.deps.logger.info('extension provisioned', { extensionId, context, extensionNumber });
    return { status: 'created', sipUsername, sipSecret };
  }

  async update(extensionIdRaw: string, raw: ExtensionUpdateInput): Promise<{ status: string }> {
    const problems: string[] = [];
    const extensionId = requireUuid(extensionIdRaw, 'extensionId', problems);
    const extensionNumber = requireExtension(raw.extensionNumber, 'extensionNumber', problems);
    const context = requireContext(raw.context, 'context', problems);
    const displayName = optionalCallerIdName(raw.displayName, 'displayName', problems) ?? '';
    const callerIdName = optionalCallerIdName(raw.callerIdName, 'callerIdName', problems);
    const callerIdNumber = optionalE164(raw.callerIdNumber, 'callerIdNumber', problems);
    const enabled = requireBoolean(raw.enabled, 'enabled', problems);
    throwIfProblems(problems);

    const existing = await this.deps.store.getAidaObject('EXTENSION', extensionId);
    if (!existing || !existing.endpoint_id) throw new NotFoundError(`extension ${extensionId} is not provisioned`);
    const endpointId = existing.endpoint_id;
    const disabledContext = this.deps.disabledContext ?? 'aida-disabled';
    const callerid = formatCallerId(callerIdName ?? displayName, callerIdNumber);

    // Moving an extension must not silently overwrite whatever already
    // occupies the target location — including a ring group's virtual
    // extension. Checked BEFORE any dialplan row is replaced.
    const moving = existing.context !== context || existing.exten !== extensionNumber;
    if (enabled && moving) {
      const occupant = await this.deps.store.findObjectAtLocation(context, extensionNumber);
      if (occupant && !(occupant.kind === 'EXTENSION' && occupant.external_id === extensionId)) {
        throw new ConflictError(
          `dialplan location ${context}/${extensionNumber} is already used by ${occupant.kind} ${occupant.external_id}`,
        );
      }
    }

    await this.deps.store.withTransaction(async (tx) => {
      await tx.setEndpointFields(endpointId, { context: enabled ? context : disabledContext, callerid });
      // Dialplan rows exist only while the extension is enabled.
      if (existing.context !== context || existing.exten !== extensionNumber || !enabled) {
        await tx.deleteDialplan(existing.context, existing.exten);
      }
      if (enabled) {
        await tx.replaceDialplan(context, extensionNumber, extensionDialplanRows(endpointId));
      }
      await tx.upsertAidaObject({
        ...existing,
        context,
        exten: extensionNumber,
        enabled: enabled ? 1 : 0,
      });
    });

    this.deps.logger.info('extension updated', { extensionId, enabled });
    return { status: 'updated' };
  }

  async rotateSecret(extensionIdRaw: string, raw: RotateSecretInput): Promise<RotateSecretResult> {
    const problems: string[] = [];
    const extensionId = requireUuid(extensionIdRaw, 'extensionId', problems);
    const requestId = requireRequestId(raw.requestId, 'requestId', problems);
    const reprovisionDevice = requireBoolean(raw.reprovisionDevice, 'reprovisionDevice', problems);
    throwIfProblems(problems);

    const existing = await this.deps.store.getAidaObject('EXTENSION', extensionId);
    if (!existing || !existing.endpoint_id) throw new NotFoundError(`extension ${extensionId} is not provisioned`);
    const endpointId = existing.endpoint_id;

    const priorRequest = await this.deps.store.getRequest(requestId);
    if (priorRequest) {
      if (priorRequest.external_id === extensionId && priorRequest.action === 'rotate-secret') {
        // Replay: the rotation already happened. The secret it produced is
        // not re-served — a lost response is recovered by rotating again
        // with a fresh requestId, which leaves an audit trail.
        return { status: 'already-applied' };
      }
      throw new ConflictError(`requestId ${requestId} was already used for a different operation`);
    }

    const sipSecret = generateSipSecret();
    await this.deps.store.withTransaction(async (tx) => {
      await tx.setAuthPassword(endpointId, sipSecret);
      await tx.recordRequest({ request_id: requestId, kind: 'EXTENSION', external_id: extensionId, action: 'rotate-secret' });
    });
    this.deps.logger.info('extension secret rotated', { extensionId, reprovisionDevice });

    let provisioningResult: RotateSecretResult['provisioningResult'];
    if (reprovisionDevice) {
      provisioningResult = await this.reprovisionDevice(extensionId, endpointId, sipSecret);
    }
    return { status: 'rotated', sipSecret, provisioningResult };
  }

  private async reprovisionDevice(
    extensionId: string,
    sipUsername: string,
    sipSecret: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    if (!this.deps.deviceProvisioning) return { ok: false, detail: 'no provisioning server configured' };
    const device = await this.deps.store.getAidaDeviceByExtension(extensionId);
    if (!device) return { ok: false, detail: 'no managed device for extension' };
    try {
      await this.deps.deviceProvisioning.upsertSipDevice({
        provisioningMac: device.provisioning_mac,
        deviceId: device.device_id,
        sipUsername,
        sipSecret,
        sipServer: this.deps.sipServer,
        provisioningProfile: device.provisioning_profile ?? undefined,
      });
      return { ok: true };
    } catch (err) {
      // The rotation itself has committed; the device reprovision failure
      // is reported to AidaAdmin, never retried in the background.
      this.deps.logger.warn('device reprovision failed after rotation', { extensionId, err });
      return { ok: false, detail: (err as Error).message };
    }
  }
}
