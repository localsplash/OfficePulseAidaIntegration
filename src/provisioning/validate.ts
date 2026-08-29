import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';

/**
 * Input normalization/validation for the provisioning API. Everything the
 * caller sends is pattern-checked before it can reach SQL or dialplan
 * rows; combined with prepared statements this is the injection defense
 * required by POC issue 2.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT_RE = /^[a-zA-Z0-9_-]{1,60}$/;
const EXTENSION_RE = /^[0-9*#]{1,12}$/;
const E164_RE = /^\+?[1-9][0-9]{6,14}$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const CALLERID_NAME_RE = /^[^"<>\\\n\r]{1,60}$/;
const PROFILE_RE = /^[a-zA-Z0-9_.-]{1,60}$/;

export function requireUuid(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    problems.push(`${field} must be a UUID`);
    return '';
  }
  return value.toLowerCase();
}

export function requireContext(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || !CONTEXT_RE.test(value)) {
    problems.push(`${field} must match ${CONTEXT_RE}`);
    return '';
  }
  return value;
}

export function requireExtension(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || !EXTENSION_RE.test(value)) {
    problems.push(`${field} must be 1-12 digits`);
    return '';
  }
  return value;
}

export function requireE164(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || !E164_RE.test(value)) {
    problems.push(`${field} must be E.164`);
    return '';
  }
  return value.startsWith('+') ? value : `+${value}`;
}

export function optionalE164(value: unknown, field: string, problems: string[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireE164(value, field, problems);
}

export function requireRequestId(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) {
    problems.push(`${field} must match ${REQUEST_ID_RE}`);
    return '';
  }
  return value;
}

export function optionalCallerIdName(value: unknown, field: string, problems: string[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !CALLERID_NAME_RE.test(value)) {
    problems.push(`${field} contains disallowed characters`);
    return undefined;
  }
  return value;
}

export function optionalProfile(value: unknown, field: string, problems: string[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !PROFILE_RE.test(value)) {
    problems.push(`${field} must match ${PROFILE_RE}`);
    return undefined;
  }
  return value;
}

/**
 * Normalize a MAC address: strip separators, uppercase, and require
 * exactly 12 hexadecimal characters. The MAC is lookup data only — it is
 * never accepted as an authentication factor anywhere in this service.
 */
export function normalizeMac(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string') {
    problems.push(`${field} must be a MAC address`);
    return '';
  }
  const normalized = value.replace(/[:\-. ]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(normalized)) {
    problems.push(`${field} must normalize to 12 hexadecimal characters`);
    return '';
  }
  return normalized;
}

export function requireBoolean(value: unknown, field: string, problems: string[]): boolean {
  if (typeof value !== 'boolean') {
    problems.push(`${field} must be a boolean`);
    return false;
  }
  return value;
}

export function intInRange(value: unknown, field: string, fallback: number, min: number, max: number, problems: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${field} must be an integer in [${min}, ${max}]`);
    return fallback;
  }
  return value;
}

export function throwIfProblems(problems: string[]): void {
  if (problems.length > 0) throw new ValidationError('invalid provisioning request', problems);
}

/** Format an Asterisk callerid field: `"Name" <number>`. */
export function formatCallerId(name: string | undefined, number: string | undefined): string {
  const cleanName = name ?? '';
  const cleanNumber = number ?? '';
  if (cleanName === '' && cleanNumber === '') return '';
  return `"${cleanName}" <${cleanNumber}>`;
}

/**
 * Deterministic SIP username: extension number plus a short tenant hash
 * so usernames stay unique across tenants while remaining stable for the
 * same (tenant, extension) forever.
 */
export function sipUsernameFor(tenantId: string, extensionNumber: string): string {
  const tenantShort = createHash('sha256').update(tenantId).digest('hex').slice(0, 6);
  return `${extensionNumber}-${tenantShort}`;
}
