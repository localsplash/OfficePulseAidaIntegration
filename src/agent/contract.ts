import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const sameHash = (a: string, b: string): boolean => /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const credential = (): string => randomBytes(32).toString('base64url');
export interface DispatchMetadata { callSessionId: string; bootstrapToken: string }
export interface BootstrapBinding {
  roomName: string; sipParticipantIdentity: string; sipParticipantSid: string; routeToken: string;
}
export interface ProfileSnapshot {
  schemaVersion: 1; callSessionId: string; tenantId: string; businessName: string;
  prompt: string; locale: 'en-US'; didE164: string;
  tone?: string; objective?: string; openingStatement?: string; transferStatement?: string; failedTransferStatement?: string;
}
export class CredentialRejected extends Error { constructor() { super('credential_rejected'); } }
export class InvalidShape extends Error { constructor() { super('invalid_request'); } }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidShape();
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new InvalidShape();
}
export function string(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.includes('\0') || [...value].length > max || (required && !value.trim())) throw new InvalidShape();
  return value;
}
/** Reject duplicate keys before JSON.parse erases them. Flat request grammar only. */
export function parseBinding(raw: Buffer): BootstrapBinding {
  if (raw.length > 2048) throw new InvalidShape();
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(raw.toString('utf8'))); } catch { throw new InvalidShape(); }
  const keys = [...raw.toString('utf8').matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(m => JSON.parse(`"${m[1]}"`) as string);
  if (new Set(keys).size !== keys.length || keys.length !== 4) throw new InvalidShape();
  exact(value, ['roomName', 'sipParticipantIdentity', 'sipParticipantSid', 'routeToken']);
  const result = { roomName: string(value.roomName, 120), sipParticipantIdentity: string(value.sipParticipantIdentity, 120),
    sipParticipantSid: string(value.sipParticipantSid, 80), routeToken: string(value.routeToken, 256) };
  if (!TOKEN.test(result.routeToken)) throw new InvalidShape();
  return result;
}
export function profileSnapshot(value: unknown): ProfileSnapshot {
  const v = object(value);
  const optional: Record<string, number> = { tone: 256, objective: 2048, openingStatement: 2048, transferStatement: 2048, failedTransferStatement: 2048 };
  exact(v, ['schemaVersion', 'callSessionId', 'tenantId', 'businessName', 'prompt', 'locale', 'didE164', ...Object.keys(optional)]);
  if (v.schemaVersion !== 1 || typeof v.callSessionId !== 'string' || typeof v.didE164 !== 'string' || !['string','number'].includes(typeof v.tenantId) || !UUID.test(String(v.callSessionId)) || v.locale !== 'en-US' ||
      !/^[1-9][0-9]*$/.test(String(v.tenantId)) || !Number.isSafeInteger(Number(v.tenantId)) ||
      !/^\+[1-9][0-9]{6,14}$/.test(String(v.didE164))) throw new InvalidShape();
  const out: ProfileSnapshot = { schemaVersion: 1, callSessionId: String(v.callSessionId), tenantId: String(v.tenantId),
    businessName: string(v.businessName, 256), prompt: string(v.prompt, 12000), locale: 'en-US', didE164: String(v.didE164) };
  for (const [key, max] of Object.entries(optional)) if (v[key] !== undefined) Object.assign(out, { [key]: string(v[key], max, false) });
  if (Buffer.byteLength(JSON.stringify(out)) > 65536) throw new InvalidShape();
  return out;
}
