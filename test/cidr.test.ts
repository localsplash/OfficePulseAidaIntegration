import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidrs, normalizeIpv4, parseCidr, resolveClientIp } from '../src/net/cidr.js';

test('parseCidr rejects malformed input', () => {
  assert.throws(() => parseCidr('nonsense'));
  assert.throws(() => parseCidr('10.0.0.0/33'));
  assert.throws(() => parseCidr('300.0.0.1/8'));
  assert.doesNotThrow(() => parseCidr('10.0.0.0/24'));
  assert.doesNotThrow(() => parseCidr('10.0.0.1'));
});

test('ipInCidrs matches network membership', () => {
  assert.equal(ipInCidrs('10.1.2.3', ['10.1.2.0/24']), true);
  assert.equal(ipInCidrs('10.1.3.3', ['10.1.2.0/24']), false);
  assert.equal(ipInCidrs('10.1.2.3', ['10.1.2.3/32']), true);
  assert.equal(ipInCidrs('192.168.0.1', ['10.0.0.0/8', '192.168.0.0/16']), true);
  assert.equal(ipInCidrs(null, ['0.0.0.0/0']), false);
});

test('normalizeIpv4 handles mapped addresses and rejects IPv6', () => {
  assert.equal(normalizeIpv4('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIpv4('10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIpv4('fe80::1'), null);
  assert.equal(normalizeIpv4(undefined), null);
});

test('resolveClientIp ignores XFF from untrusted peers (spoof defense)', () => {
  // Attacker on the LAN sets X-Forwarded-For to a trusted address; the
  // socket peer is not a trusted proxy so the header must be ignored.
  const resolved = resolveClientIp('10.9.9.9', '10.0.0.1', ['10.0.0.100/32']);
  assert.equal(resolved, '10.9.9.9');
});

test('resolveClientIp honors right-most XFF only via a trusted proxy', () => {
  const resolved = resolveClientIp('10.0.0.100', '1.2.3.4, 10.0.0.7', ['10.0.0.100/32']);
  assert.equal(resolved, '10.0.0.7');
});

test('resolveClientIp denies non-IPv4 peers', () => {
  assert.equal(resolveClientIp('fe80::1', undefined, []), null);
});
