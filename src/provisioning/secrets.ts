import { randomBytes } from 'node:crypto';

/**
 * SIP secret generation. 24 random bytes → 32 base64url characters,
 * ≈192 bits of entropy from the platform CSPRNG. The generated value is
 * stored only in ps_auths and returned exactly once (create/rotation).
 */
export function generateSipSecret(): string {
  return randomBytes(24).toString('base64url');
}
