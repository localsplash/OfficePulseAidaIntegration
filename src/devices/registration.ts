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
/** Asterisk realtime (sorcery) stores ';' as ^3B and '^' as ^5E; AstDB and other stores keep them raw. */
const decodeRealtime = (value: string): string =>
  value.replace(/\^([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
/**
 * A stored contact's usable addresses. `source` is the URI host: the NAT source address
 * when rewrite_contact is on, otherwise the phone's own. `own` is the phone's own address:
 * via_addr and Asterisk's x-ast-orig-host (its address before that rewrite). Tolerates
 * realtime escaping, angle brackets, a missing user part and IPv6 literals. DNS names are never resolved.
 */
export function contactAddresses(contact: Pick<PbxContact, 'uri' | 'localIp'>): { source?: string; own: string[] } {
  const decoded = decodeRealtime(contact.uri).trim();
  const uri = /<([^>]*)>/.exec(decoded)?.[1] ?? decoded;
  const host = /^sips?:(?:[^@;?>\s]*@)?(\[[^\]]+\]|[^:;?>\s]+)/i.exec(uri)?.[1];
  const origHost = /[;?&]x-ast-orig-host=(\[[^\]]+\]|[^:;?&>\s]+)/i.exec(uri)?.[1];
  const own = [contact.localIp, origHost].map(value => value ? usableIp(value) : undefined).filter((ip): ip is string => !!ip);
  return { source: host ? usableIp(host) : undefined, own: [...new Set(own)] };
}
export function normalizedMac(value: string): string | undefined {
  const mac = value.replace(/[:-]/g, '').toLowerCase();
  return /^[a-f0-9]{12}$/.test(mac) ? mac : undefined;
}
export function registrationMac(userAgent: string): string | undefined {
  return /(?:^|\/)MAC-([a-f0-9]{12})(?:$|[^a-f0-9])/i.exec(userAgent)?.[1]?.toLowerCase();
}
/**
 * An office's phones share one public IP and private ranges repeat across offices, so the
 * request's public IP must be the contact's source address and one app-reported local IP
 * must be the phone's own address.
 */
export function matchingContacts(contacts: PbxContact[], publicIp: string, localIps: string[], requirePublicIpMatch: boolean, now = Date.now()): PbxContact[] {
  const locals = localIps.map(usableIp).filter((ip): ip is string => !!ip);
  const source = normalizedIp(publicIp);
  return contacts.filter(c => {
    if (c.expiresAt <= now) return false;
    const addresses = contactAddresses(c);
    return locals.some(ip => addresses.own.includes(ip)) && (!requirePublicIpMatch || (!!source && source === addresses.source));
  });
}
