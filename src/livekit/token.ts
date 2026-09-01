import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Minimal LiveKit JWT (HS256) signing and webhook verification.
 *
 * Hand-rolled rather than pulled from the SDK so the service keeps a single
 * small dependency surface on a private host: the API is a documented,
 * stable HS256 JWT plus a sha256 body hash in the webhook's `Authorization`
 * token. Nothing here is LiveKit-version specific.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface VideoGrant {
  roomCreate?: boolean;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomList?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  agent?: boolean;
}

export interface TokenClaims {
  identity?: string;
  name?: string;
  ttlSeconds?: number;
  video?: VideoGrant;
  metadata?: string;
  /** Set for webhook receivers; carries the sha256 of the raw body. */
  sha256?: string;
}

/** Signs a LiveKit access token. Never log the result: it is a credential. */
export function signAccessToken(apiKey: string, apiSecret: string, claims: TokenClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: Record<string, unknown> = {
    iss: apiKey,
    sub: claims.identity,
    nbf: now - 5,
    exp: now + (claims.ttlSeconds ?? 600),
    ...(claims.identity ? { jti: claims.identity } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.metadata ? { metadata: claims.metadata } : {}),
    ...(claims.video ? { video: claims.video } : {}),
    ...(claims.sha256 ? { sha256: claims.sha256 } : {}),
  };
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', apiSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
  claims?: Record<string, unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a LiveKit webhook: HS256 signature over the token, issuer match,
 * expiry, and — critically — that the token's `sha256` claim matches the
 * digest of the RAW request body. Without the body check a valid token
 * could be replayed over substituted content.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  authorization: string | undefined,
  apiKey: string,
  apiSecret: string,
  now: () => number = Date.now,
): WebhookVerification {
  if (!authorization) return { valid: false, reason: 'missing authorization header' };
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : authorization.trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed token' };
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url');
  if (!safeEqual(signature, expected)) return { valid: false, reason: 'bad signature' };

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { valid: false, reason: 'unparseable claims' };
  }

  if (claims.iss !== apiKey) return { valid: false, reason: 'issuer mismatch' };
  const nowSeconds = Math.floor(now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < nowSeconds) return { valid: false, reason: 'token expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 60) {
    return { valid: false, reason: 'token not yet valid' };
  }

  const bodyDigest = createHash('sha256').update(rawBody).digest('base64');
  if (typeof claims.sha256 !== 'string' || !safeEqual(claims.sha256, bodyDigest)) {
    return { valid: false, reason: 'body digest mismatch' };
  }

  return { valid: true, claims };
}
