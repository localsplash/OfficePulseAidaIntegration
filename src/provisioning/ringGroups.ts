import type { Logger } from '../logging/logger.js';
import { ConflictError, ValidationError } from '../errors.js';
import type { DialplanRow, RealtimeStore } from './store.js';
import {
  intInRange,
  optionalCallerIdName,
  optionalE164,
  optionalProfile,
  requireBoolean,
  requireContext,
  requireExtension,
  requireUuid,
  requireTenantId,
  throwIfProblems,
} from './validate.js';

export interface RingGroupInput {
  tenantId: string;
  virtualExtension: string;
  context: string;
  /** Member extension numbers within the same context, in ring order. */
  memberExtensions: string[];
  ringTimeoutSeconds?: number;
  musicOnHoldClass?: string;
  callerIdName?: string;
  callerIdNumber?: string;
  enabled: boolean;
}

export interface RingGroupServiceDeps {
  store: RealtimeStore;
  logger: Logger;
}

/**
 * Deterministic RING_ALL realtime dialplan rows for a ring group. Same
 * input always produces byte-identical rows (POC issue 2), so repeated
 * saves are naturally idempotent.
 */
export function ringGroupDialplanRows(
  ringGroupId: string,
  memberEndpointIds: string[],
  ringTimeoutSeconds: number,
  musicOnHoldClass: string | undefined,
  callerIdName: string | undefined,
  callerIdNumber: string | undefined,
): DialplanRow[] {
  const rows: DialplanRow[] = [{ priority: 1, app: 'NoOp', appdata: `aida-ring-group ${ringGroupId}` }];
  let priority = 2;
  // Both halves of the presented Caller ID are applied. Setting only the
  // name leaves the caller's own number on the members' screens, which
  // makes a ring group indistinguishable from a direct call.
  if (callerIdName !== undefined) {
    rows.push({ priority: priority++, app: 'Set', appdata: `CALLERID(name)=${callerIdName}` });
  }
  if (callerIdNumber !== undefined) {
    rows.push({ priority: priority++, app: 'Set', appdata: `CALLERID(num)=${callerIdNumber}` });
  }
  const dialString = memberEndpointIds.map((id) => `PJSIP/${id}`).join('&');
  const options = musicOnHoldClass !== undefined ? `,m(${musicOnHoldClass})` : '';
  rows.push({ priority: priority++, app: 'Dial', appdata: `${dialString},${ringTimeoutSeconds}${options}` });
  rows.push({ priority: priority, app: 'Hangup', appdata: '' });
  return rows;
}

export class RingGroupProvisioningService {
  constructor(private readonly deps: RingGroupServiceDeps) {}

  async provision(ringGroupIdRaw: string, raw: RingGroupInput): Promise<{ status: string }> {
    const problems: string[] = [];
    const ringGroupId = requireUuid(ringGroupIdRaw, 'ringGroupId', problems);
    const tenantId = requireTenantId(raw.tenantId, 'tenantId', problems);
    const virtualExtension = requireExtension(raw.virtualExtension, 'virtualExtension', problems);
    const context = requireContext(raw.context, 'context', problems);
    const ringTimeoutSeconds = intInRange(raw.ringTimeoutSeconds, 'ringTimeoutSeconds', 20, 5, 120, problems);
    const musicOnHoldClass = optionalProfile(raw.musicOnHoldClass, 'musicOnHoldClass', problems);
    const callerIdName = optionalCallerIdName(raw.callerIdName, 'callerIdName', problems);
    const callerIdNumber = optionalE164(raw.callerIdNumber, 'callerIdNumber', problems);
    const enabled = requireBoolean(raw.enabled, 'enabled', problems);
    if (!Array.isArray(raw.memberExtensions) || raw.memberExtensions.length === 0) {
      problems.push('memberExtensions must be a non-empty array');
    }
    const members = (Array.isArray(raw.memberExtensions) ? raw.memberExtensions : []).map((m, i) =>
      requireExtension(m, `memberExtensions[${i}]`, problems),
    );
    throwIfProblems(problems);

    // Every member must already be a provisioned extension in this
    // context; a ring group can never invent endpoints.
    const memberEndpointIds: string[] = [];
    const missing: string[] = [];
    for (const member of members) {
      const obj = await this.deps.store.findExtensionObjectByExten(context, member);
      if (!obj?.endpoint_id || obj.enabled !== 1) missing.push(member);
      else memberEndpointIds.push(obj.endpoint_id);
    }
    if (missing.length > 0) {
      throw new ValidationError('ring group members are not provisioned extensions', missing.map((m) => `member ${m}`));
    }

    const existing = await this.deps.store.getAidaObject('RING_GROUP', ringGroupId);

    // A virtual extension must not silently take over a location an
    // extension (or another ring group) already owns. Checked BEFORE any
    // dialplan row is replaced.
    if (enabled && (!existing || existing.context !== context || existing.exten !== virtualExtension)) {
      const occupant = await this.deps.store.findObjectAtLocation(context, virtualExtension);
      if (occupant && !(occupant.kind === 'RING_GROUP' && occupant.external_id === ringGroupId)) {
        throw new ConflictError(
          `dialplan location ${context}/${virtualExtension} is already used by ${occupant.kind} ${occupant.external_id}`,
        );
      }
    }

    await this.deps.store.withTransaction(async (tx) => {
      if (existing && (existing.context !== context || existing.exten !== virtualExtension)) {
        await tx.deleteDialplan(existing.context, existing.exten);
      }
      if (enabled) {
        await tx.replaceDialplan(
          context,
          virtualExtension,
          ringGroupDialplanRows(
            ringGroupId,
            memberEndpointIds,
            ringTimeoutSeconds,
            musicOnHoldClass,
            callerIdName,
            callerIdNumber,
          ),
        );
      } else {
        await tx.deleteDialplan(context, virtualExtension);
      }
      await tx.upsertAidaObject({
        kind: 'RING_GROUP',
        external_id: ringGroupId,
        tenant_id: tenantId,
        context,
        exten: virtualExtension,
        endpoint_id: null,
        enabled: enabled ? 1 : 0,
      });
    });

    this.deps.logger.info('ring group provisioned', { ringGroupId, context, virtualExtension, members: members.length });
    return { status: 'provisioned' };
  }
}
