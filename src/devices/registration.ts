import { isIP } from 'node:net';
import type { PbxContact } from '../pbx/inventory.js';

/** Canonical IPv4/IPv6, including IPv4-mapped IPv6. No DNS lookups. */
export function normalizedIp(value: string): string | undefined {
  const ip = value.trim().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (isIP(ip) === 4) return ip.split('.').map(Number).join('.');
  if (isIP(ip) !== 6) return;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) {
    const n = parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return canonical;
}
export function usableIp(value: string): string | undefined {
  const ip = normalizedIp(value);
  if (!ip || /^(127\.|169\.254\.|0\.)/.test(ip) || ['::', '::1'].includes(ip) || /^fe[89ab]/.test(ip)) return;
  return ip;
}
export function contactPublicIp(uri: string): string | undefined {
  const match = /^sips?:[^@;\s]+@(\[[^\]]+\]|[^:;?\s]+)(?::\d+)?(?:[;?]|$)/i.exec(uri);
  return match ? normalizedIp(match[1]!) : undefined;
}
export function normalizedMac(value: string): string | undefined {
  const mac = value.replace(/[:-]/g, '').toLowerCase();
  return /^[a-f0-9]{12}$/.test(mac) ? mac : undefined;
}
export function registrationMac(userAgent: string): string | undefined {
  return /(?:^|\/)MAC-([a-f0-9]{12})(?:$|[^a-f0-9])/i.exec(userAgent)?.[1]?.toLowerCase();
}
export function matchingContacts(contacts: PbxContact[], publicIp: string, localIps: string[], requirePublicIpMatch: boolean, now = Date.now()): PbxContact[] {
  const locals = new Set(localIps.map(usableIp).filter(Boolean));
  return contacts.filter(c => c.expiresAt > now && !!usableIp(c.localIp) && locals.has(usableIp(c.localIp)) &&
    (!requirePublicIpMatch || (!!normalizedIp(publicIp) && normalizedIp(publicIp) === contactPublicIp(c.uri))));
}
