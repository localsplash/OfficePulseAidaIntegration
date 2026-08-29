/**
 * Repository interface over the OfficePulse Asterisk Realtime MySQL
 * database (ps_endpoints / ps_auths / ps_aors / extensions) plus the two
 * small aida_* bookkeeping tables this service owns (see deploy/sql/).
 *
 * All writes happen inside withTransaction so a partial failure rolls
 * back every row. The MySQL implementation uses prepared statements
 * exclusively; the fake used by tests mirrors row-level semantics.
 */

export interface DialplanRow {
  priority: number;
  app: string;
  appdata: string;
}

export interface EndpointRow {
  id: string;
  transport: string;
  aors: string;
  auth: string;
  context: string;
  disallow: string;
  allow: string;
  callerid: string;
}

export interface AorRow {
  id: string;
  max_contacts: number;
  remove_existing: 'yes' | 'no';
}

export interface AuthRow {
  id: string;
  auth_type: 'userpass';
  username: string;
  password: string;
}

export type AidaObjectKind = 'EXTENSION' | 'RING_GROUP' | 'DID';

export interface AidaObjectRow {
  kind: AidaObjectKind;
  external_id: string;
  tenant_id: string | null;
  context: string;
  exten: string;
  endpoint_id: string | null;
  enabled: 0 | 1;
}

export interface AidaDeviceRow {
  device_id: string;
  extension_external_id: string;
  provisioning_mac: string;
  provisioning_profile: string | null;
}

export interface RequestRecord {
  request_id: string;
  kind: AidaObjectKind | 'HANDSET';
  external_id: string;
  action: string;
}

export interface RealtimeTx {
  upsertAor(row: AorRow): Promise<void>;
  upsertAuth(row: AuthRow): Promise<void>;
  upsertEndpoint(row: EndpointRow): Promise<void>;
  deleteEndpointBundle(endpointId: string): Promise<void>;
  setEndpointFields(endpointId: string, fields: Partial<Pick<EndpointRow, 'context' | 'callerid'>>): Promise<void>;
  setAuthPassword(authId: string, password: string): Promise<void>;
  replaceDialplan(context: string, exten: string, rows: DialplanRow[]): Promise<void>;
  deleteDialplan(context: string, exten: string): Promise<void>;
  upsertAidaObject(row: AidaObjectRow): Promise<void>;
  upsertAidaDevice(row: AidaDeviceRow): Promise<void>;
  recordRequest(record: RequestRecord): Promise<void>;
}

export interface RealtimeStore {
  withTransaction<T>(fn: (tx: RealtimeTx) => Promise<T>): Promise<T>;
  getAuth(authId: string): Promise<AuthRow | undefined>;
  getEndpoint(endpointId: string): Promise<EndpointRow | undefined>;
  getDialplan(context: string, exten: string): Promise<DialplanRow[]>;
  getAidaObject(kind: AidaObjectKind, externalId: string): Promise<AidaObjectRow | undefined>;
  findExtensionObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined>;
  findDidObjectByExten(context: string, exten: string): Promise<AidaObjectRow | undefined>;
  getAidaDeviceByExtension(extensionExternalId: string): Promise<AidaDeviceRow | undefined>;
  getRequest(requestId: string): Promise<RequestRecord | undefined>;
  ping(): Promise<boolean>;
}
