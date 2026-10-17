/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Working out which client a request came from when it passed through
 * proxies. Pure: no configuration, so both the gateway (ip-utils) and the
 * index-swarm tracker use it.
 */
import * as net from 'node:net';

/**
 * Where a proxy in front of a gateway normally sits: loopback, the private
 * ranges (Docker networks among them), carrier-grade NAT and link-local, for
 * IPv4 and IPv6. The default for core's `TRUSTED_PROXIES`, and what the
 * index-swarm tracker believes on its listener behind the gateway's Envoy.
 */
export const PRIVATE_NETWORK_RANGES: readonly string[] = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** `::ffff:1.2.3.4` as `1.2.3.4`; anything else unchanged. */
function unmapIpv4(ip: string): string {
  const match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match !== null ? match[1] : ip;
}

/**
 * A set of proxies, from IPs and CIDRs.
 *
 * @throws on anything that is not strictly `address` or `address/bits`: a
 *   typo such as `10.0.0.0/` must not read as /0 and trust every address.
 */
export function parseTrustedProxies(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const match = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(entry);
    const address = match === null ? '' : unmapIpv4(match[1]);
    const prefix = match?.[2];
    const family = net.isIP(address);
    if (family === 0) {
      throw new Error(`Not an IP address or CIDR: ${raw}`);
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(address, type);
    } else {
      const bits = Number(prefix);
      if (bits > (family === 6 ? 128 : 32)) {
        throw new Error(`Not an IP address or CIDR: ${raw}`);
      }
      list.addSubnet(address, bits, type);
    }
  }
  return list;
}

/** Whether `ip` is one of `proxies`. False for anything that is not an IP. */
export function isTrustedProxy(ip: string, proxies: net.BlockList): boolean {
  const family = net.isIP(ip);
  return family !== 0 && proxies.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** The addresses in an `X-Forwarded-For` header, in order, valid ones only. */
export function forwardedHops(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((hop) => unmapIpv4(hop.trim()))
    .filter((hop) => net.isIP(hop) !== 0);
}

/**
 * The client behind a request: the address that connected, unless that is
 * a trusted proxy, in which case the nearest `X-Forwarded-For` hop that is
 * not itself a trusted proxy.
 *
 * A client can put anything in the header it sends; each proxy appends what
 * it saw. So the header is read from the right, and only as far as proxies
 * are trusted: the first untrusted hop is the one a trusted proxy recorded.
 * When every hop is trusted (a client inside the proxies' own network), it
 * is the leftmost, where the chain started.
 */
export function clientAddressBehindProxies(
  connectedFrom: string,
  forwardedFor: string | string[] | undefined,
  proxies: net.BlockList,
): string {
  const socketIp = unmapIpv4(connectedFrom);
  if (!isTrustedProxy(socketIp, proxies)) return socketIp;
  const hops = forwardedHops(forwardedFor);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(hops[i], proxies)) return hops[i];
  }
  return hops[0] ?? socketIp;
}
