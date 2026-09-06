import type { NocoReadApi, NocoRecord } from './api.js';
import { NotFoundError, UpstreamError } from '../errors.js';

/**
 * Typed read-only projection of the AidaAdmin configuration base
 * (issue #9). Every mutable AidaAdmin table carries a `revision` column;
 * the values read here are pinned into `call_session` so a call's
 * behaviour stays explainable even after an administrator edits the
 * configuration mid-call.
 */

export interface TenantConfig {
  id: string;
  revision: number;
  name: string;
  slug: string;
  asteriskContext: string;
  callerIdName?: string;
  callerIdNumber?: string;
  enabled: boolean;
}

export type DestinationType = 'EXTENSION' | 'RING_GROUP';

export interface DidRouteConfig {
  id: string;
  revision: number;
  tenantId: string;
  didE164: string;
  assistantProfileId: string;
  destinationType: DestinationType;
  destinationId: string;
  screeningEnabled: boolean;
  enabled: boolean;
}

export interface AssistantProfileConfig {
  id: string;
  revision: number;
  tenantId: string;
  name: string;
  businessName: string;
  prompt: string;
  tone?: string;
  objective?: string;
  openingStatement?: string;
  transferStatement?: string;
  failedTransferStatement?: string;
  enabled: boolean;
}

export interface ExtensionConfig {
  id: string;
  revision: number;
  tenantId: string;
  extensionNumber: string;
  displayName: string;
  asteriskContext: string;
  deviceId?: string;
  provisioningMac?: string;
  enabled: boolean;
}

export interface RingGroupConfig {
  id: string;
  revision: number;
  tenantId: string;
  name: string;
  virtualExtension: string;
  asteriskContext: string;
  ringTimeoutSeconds: number;
  musicOnHoldClass?: string;
  enabled: boolean;
}

/** A resolved inbound route: everything one call needs, in one object. */
export interface ResolvedRoute {
  tenant: TenantConfig;
  didRoute: DidRouteConfig;
  profile: AssistantProfileConfig;
}

function str(record: NocoRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function optStr(record: NocoRecord, key: string): string | undefined {
  const value = str(record, key).trim();
  return value === '' ? undefined : value;
}

function num(record: NocoRecord, key: string, fallback = 0): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * NocoDB Checkbox columns come back as booleans, but a base restored from
 * CSV or edited through the API can hold 1/0 or "true"/"false" instead.
 */
function bool(record: NocoRecord, key: string): boolean {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  return false;
}

function toTenant(record: NocoRecord): TenantConfig {
  return {
    id: str(record, 'id'),
    revision: num(record, 'revision'),
    name: str(record, 'name'),
    slug: str(record, 'slug'),
    asteriskContext: str(record, 'asterisk_context'),
    callerIdName: optStr(record, 'caller_id_name'),
    callerIdNumber: optStr(record, 'caller_id_number'),
    enabled: bool(record, 'enabled'),
  };
}

function toDidRoute(record: NocoRecord): DidRouteConfig | undefined {
  const destinationType = str(record, 'destination_type').toUpperCase();
  if (destinationType !== 'EXTENSION' && destinationType !== 'RING_GROUP') return undefined;
  const destinationId =
    destinationType === 'EXTENSION'
      ? optStr(record, 'destination_extension_id')
      : optStr(record, 'destination_ring_group_id');
  if (!destinationId) return undefined;
  return {
    id: str(record, 'id'),
    revision: num(record, 'revision'),
    tenantId: str(record, 'tenant_id'),
    didE164: str(record, 'did_e164'),
    assistantProfileId: str(record, 'assistant_profile_id'),
    destinationType,
    destinationId,
    screeningEnabled: bool(record, 'screening_enabled'),
    enabled: bool(record, 'enabled'),
  };
}

function toProfile(record: NocoRecord): AssistantProfileConfig {
  return {
    id: str(record, 'id'),
    revision: num(record, 'revision'),
    tenantId: str(record, 'tenant_id'),
    name: str(record, 'name'),
    businessName: str(record, 'business_name'),
    prompt: str(record, 'prompt'),
    tone: optStr(record, 'tone'),
    objective: optStr(record, 'objective'),
    openingStatement: optStr(record, 'opening_statement'),
    transferStatement: optStr(record, 'transfer_statement'),
    failedTransferStatement: optStr(record, 'failed_transfer_statement'),
    enabled: bool(record, 'enabled'),
  };
}

/**
 * E.164 comparison tolerant of a stored value that lost its leading '+'.
 * Asterisk hands us whatever the trunk sent; the base may hold either form.
 */
function didVariants(didE164: string): string[] {
  const trimmed = didE164.trim();
  const bare = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  return [`+${bare}`, bare];
}

export class NocoConfigRepository {
  constructor(private readonly api: NocoReadApi) {}

  /**
   * Resolve an inbound DID to its tenant, route, and enabled assistant
   * profile. Returns undefined (not an error) when the DID is unknown or
   * any link in the chain is disabled — the caller then takes the local
   * fallback path rather than treating configuration as an outage.
   */
  async resolveInboundRoute(didE164: string): Promise<ResolvedRoute | undefined> {
    const matched = new Map<string, NocoRecord>();
    for (const variant of didVariants(didE164)) {
      const records = await this.api.listRecords('did_route', [{ field: 'did_e164', op: 'eq', value: variant }], 2);
      for (const row of records) matched.set(str(row, 'id'), row);
    }
    if (matched.size > 1) throw new UpstreamError('ambiguous DID configuration', 'nocodb');
    const first = [...matched.values()][0];
    if (!first) return undefined;

    const didRoute = toDidRoute(first);
    if (!didRoute || !didRoute.enabled) return undefined;

    const tenant = await this.getTenant(didRoute.tenantId);
    if (!tenant || !tenant.enabled) return undefined;

    const profile = await this.getAssistantProfile(didRoute.assistantProfileId);
    if (!profile || !profile.enabled) return undefined;
    // A profile belonging to another tenant is a configuration error, never
    // a usable route: screening must not leak one tenant's prompt to another.
    if (profile.tenantId !== tenant.id) return undefined;

    return { tenant, didRoute, profile };
  }

  async getTenant(tenantId: string): Promise<TenantConfig | undefined> {
    if (tenantId === '') return undefined;
    const records = await this.api.listRecords('tenant', [{ field: 'id', op: 'eq', value: tenantId }], 2);
    if (records.length > 1) throw new UpstreamError('duplicate tenant voice profile', 'nocodb');
    return records[0] ? toTenant(records[0]) : undefined;
  }

  async getAssistantProfile(profileId: string): Promise<AssistantProfileConfig | undefined> {
    if (profileId === '') return undefined;
    const records = await this.api.listRecords(
      'assistant_profile',
      [{ field: 'id', op: 'eq', value: profileId }],
      1,
    );
    return records[0] ? toProfile(records[0]) : undefined;
  }

  async getExtension(extensionId: string): Promise<ExtensionConfig | undefined> {
    if (extensionId === '') return undefined;
    const records = await this.api.listRecords('extension', [{ field: 'id', op: 'eq', value: extensionId }], 1);
    const record = records[0];
    if (!record) return undefined;
    return {
      id: str(record, 'id'),
      revision: num(record, 'revision'),
      tenantId: str(record, 'tenant_id'),
      extensionNumber: str(record, 'extension_number'),
      displayName: str(record, 'display_name'),
      asteriskContext: str(record, 'asterisk_context'),
      deviceId: optStr(record, 'device_id'),
      provisioningMac: optStr(record, 'provisioning_mac'),
      enabled: bool(record, 'enabled'),
    };
  }

  async getRingGroup(ringGroupId: string): Promise<RingGroupConfig | undefined> {
    if (ringGroupId === '') return undefined;
    const records = await this.api.listRecords('ring_group', [{ field: 'id', op: 'eq', value: ringGroupId }], 1);
    const record = records[0];
    if (!record) return undefined;
    return {
      id: str(record, 'id'),
      revision: num(record, 'revision'),
      tenantId: str(record, 'tenant_id'),
      name: str(record, 'name'),
      virtualExtension: str(record, 'virtual_extension'),
      asteriskContext: str(record, 'asterisk_context'),
      ringTimeoutSeconds: num(record, 'ring_timeout_seconds', 20),
      musicOnHoldClass: optStr(record, 'music_on_hold_class'),
      enabled: bool(record, 'enabled'),
    };
  }

  async ringGroupsForExtension(extensionId: string, tenantId: string): Promise<string[]> {
    const rows = await this.api.listRecords('ring_group_member', [{ field: 'extension_id', op: 'eq', value: extensionId }], 200);
    const ids: string[] = [];
    for (const row of rows) {
      const group = await this.getRingGroup(str(row, 'ring_group_id'));
      if (group?.enabled && group.tenantId === tenantId) ids.push(group.id);
    }
    return [...new Set(ids)];
  }

  /** Device lookup by normalized MAC. The MAC is lookup data, never a credential. */
  async findExtensionByMac(provisioningMac: string): Promise<ExtensionConfig | undefined> {
    const records = await this.api.listRecords(
      'extension',
      [{ field: 'provisioning_mac', op: 'eq', value: provisioningMac }],
      1,
    );
    const record = records[0];
    if (!record) return undefined;
    const extension = await this.getExtension(str(record, 'id'));
    if (!extension) throw new NotFoundError(`extension for MAC lookup vanished mid-read`);
    return extension;
  }
}
