/**
 * IPv4 CIDR trust helpers. The POC trust model is TLS-free private-LAN
 * IPv4 allowlisting: requests are authorized by the approved network path,
 * never by any header a caller can set. A forwarded client address is
 * honored only when the direct TCP peer is a trusted proxy.
 */

export interface Cidr {
  base: number;
  maskBits: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/** Strip an IPv4-mapped IPv6 prefix; returns null for anything not IPv4. */
export function normalizeIpv4(addr: string | undefined | null): string | null {
  if (!addr) return null;
  let ip = addr.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ipv4ToInt(ip) === null ? null : ip;
}

export function parseCidr(cidr: string): Cidr {
  const [ipPart, maskPart] = cidr.split('/');
  const base = ipv4ToInt(ipPart ?? '');
  if (base === null) throw new Error(`invalid CIDR '${cidr}': bad address`);
  const maskBits = maskPart === undefined ? 32 : Number(maskPart);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) {
    throw new Error(`invalid CIDR '${cidr}': bad mask`);
  }
  return { base, maskBits };
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  if (cidr.maskBits === 0) return true;
  const mask = (~0 << (32 - cidr.maskBits)) >>> 0;
  return ((n & mask) >>> 0) === ((cidr.base & mask) >>> 0);
}

export function ipInCidrs(ip: string | null, cidrs: readonly string[]): boolean {
  if (ip === null) return false;
  return cidrs.some((c) => {
    try {
      return ipInCidr(ip, parseCidr(c));
    } catch {
      return false;
    }
  });
}

/**
 * Resolve the effective client IPv4 for authorization decisions.
 * Uses the TCP socket peer unless that peer is a trusted proxy, in which
 * case the right-most X-Forwarded-For entry (the one appended by our own
 * proxy) is used. Arbitrary caller-supplied XFF is never trusted.
 * Returns null (deny) for non-IPv4 peers.
 */
export function resolveClientIp(
  socketPeer: string | undefined,
  xForwardedFor: string | undefined,
  trustedProxyCidrs: readonly string[],
): string | null {
  const peer = normalizeIpv4(socketPeer);
  if (peer === null) return null;
  if (!xForwardedFor || !ipInCidrs(peer, trustedProxyCidrs)) return peer;
  const hops = xForwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const last = hops.length > 0 ? hops[hops.length - 1] : undefined;
  const forwarded = normalizeIpv4(last);
  return forwarded ?? peer;
}
