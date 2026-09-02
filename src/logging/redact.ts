/**
 * Recursive redaction of secret-bearing fields before anything is logged.
 * Key-name based: any key that looks like credential material is masked.
 */

const SECRET_KEY_PATTERN = /secret|token|password|passwd|authorization|api[-_]?key|credential/i;

export const REDACTED = '[redacted]';

const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? (v === undefined || v === null ? v : REDACTED) : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
