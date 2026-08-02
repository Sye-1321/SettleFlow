/**
 * Deny ranges derived from the IANA IPv4/IPv6 Special-Purpose Address
 * Registries, reviewed 2026-08-01. This list intentionally errs closed for
 * special-use ranges. Future updates require security review and corpus tests.
 *
 * Sources:
 * - https://www.iana.org/assignments/iana-ipv4-special-registry/
 * - https://www.iana.org/assignments/iana-ipv6-special-registry/
 */
export const PROHIBITED_IPV4_SUBNETS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export const PROHIBITED_IPV6_SUBNETS: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
