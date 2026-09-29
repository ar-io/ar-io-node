/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as net from 'node:net';

import { Request } from 'express';

import * as config from '../config.js';
import {
  clientAddressBehindProxies,
  forwardedHops,
  isTrustedProxy,
  parseTrustedProxies,
} from './trusted-proxies.js';

/**
 * Validate if a string is a valid IP address format
 * @param ip - The IP address string to validate
 * @returns true if the IP format is valid, false otherwise
 */
export function isValidIpFormat(ip: string): boolean {
  // IPv4-mapped IPv6 addresses (::ffff:192.168.1.1)
  if (ip.includes(':') && ip.includes('.')) {
    const ipv4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4MappedMatch) {
      // Validate the IPv4 part
      const ipv4Part = ipv4MappedMatch[1];
      const parts = ipv4Part.split('.');
      if (parts.length !== 4) return false;
      return parts.every((part) => {
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
      });
    }
    // Other IPv6 addresses with dots are invalid
    return false;
  }

  // IPv4 validation
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
      const num = parseInt(part, 10);
      return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
    });
  }

  // IPv6 validation (basic - check for colons and valid hex characters)
  if (ip.includes(':')) {
    // Basic IPv6 validation - must contain at least one colon and only valid hex/colon chars
    if (!/^[0-9a-fA-F:]+$/.test(ip)) {
      return false;
    }
    // Must not have more than one consecutive :: (zero compression)
    const doubleBrackets = ip.match(/::/g);
    if (doubleBrackets && doubleBrackets.length > 1) {
      return false;
    }
    // Must not contain more than 8 groups (split by single colons, excluding ::)
    const parts = ip.split(/::?/);
    const totalGroups = parts.reduce(
      (sum, part) => sum + (part ? part.split(':').length : 0),
      0,
    );
    return totalGroups <= 8;
  }

  return false;
}

/**
 * Normalize IPv4-mapped IPv6 addresses to IPv4 format
 * @param ip - The IP address to normalize
 * @returns The normalized IP address
 */
export function normalizeIpv4MappedIpv6(ip: string): string {
  const ipv4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return ipv4MappedMatch ? ipv4MappedMatch[1] : ip;
}

let defaultProxies: net.BlockList | undefined;

/**
 * The gateway's trusted proxies, from `TRUSTED_PROXIES`, parsed once.
 * Called at startup, so a malformed value stops the gateway there rather
 * than failing every request.
 */
export function gatewayTrustedProxies(): net.BlockList {
  defaultProxies ??= parseTrustedProxies(config.TRUSTED_PROXIES);
  return defaultProxies;
}

/**
 * The client a request came from, and every address it names.
 *
 * `clientIp` is the one to key rate limits on and to check against an
 * allowlist: the connecting address, or, when that is a trusted proxy
 * (`TRUSTED_PROXIES`), the address the proxy recorded (see
 * {@link clientAddressBehindProxies}). `X-Real-IP` is used only from a
 * trusted proxy, and only when there is no `X-Forwarded-For`.
 *
 * `clientIps` is every address the request names or came through, including
 * what the client itself put in its headers. It is for logging and for
 * blocklists, where a false claim only hurts the claimant; never grant
 * anything on it.
 */
export function extractAllClientIPs(
  req: Request,
  proxies: net.BlockList = gatewayTrustedProxies(),
): {
  clientIp?: string;
  clientIps: string[];
} {
  const clientIps: string[] = [];
  const add = (raw: string | undefined) => {
    if (raw === undefined) return undefined;
    const ip = normalizeIpv4MappedIpv6(raw.trim());
    if (ip === '' || ip.toLowerCase() === 'unknown' || !isValidIpFormat(ip)) {
      return undefined;
    }
    if (!clientIps.includes(ip)) clientIps.push(ip);
    return ip;
  };

  const forwardedFor = req.headers['x-forwarded-for'];
  for (const hop of forwardedHops(forwardedFor)) add(hop);
  const realIpHeader = req.headers['x-real-ip'];
  const realIp = add(
    Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader,
  );
  const socketIp = add(req.socket?.remoteAddress);
  const reqIp = add(req.ip);

  // Without trust proxy set, Express's req.ip is the socket's address too.
  const connectedFrom = socketIp ?? reqIp;
  let clientIp: string | undefined;
  if (connectedFrom !== undefined) {
    const trusted = isTrustedProxy(connectedFrom, proxies);
    clientIp =
      trusted &&
      forwardedHops(forwardedFor).length === 0 &&
      realIp !== undefined
        ? realIp
        : clientAddressBehindProxies(connectedFrom, forwardedFor, proxies);
  }

  return { clientIp, clientIps };
}

/**
 * Check if an IP address is within a CIDR range (IPv4 only)
 * @param ip - The IP address to check
 * @param cidr - The CIDR range (e.g., "192.168.1.0/24")
 * @returns true if the IP is within the CIDR range
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    if (!cidr || !cidr.includes('/')) return false;

    // Reject IPv6
    if (ip.includes(':')) return false;

    const [rawNetwork, rawPrefix] = cidr.split('/');
    if (!rawNetwork || rawPrefix === undefined) return false;

    const network = rawNetwork.trim();
    const prefixStr = rawPrefix.trim();

    // Validate prefix strictly: 0-32 (no leading + sign etc.)
    if (!/^(\d|[12]\d|3[0-2])$/.test(prefixStr)) return false;
    const prefix = parseInt(prefixStr, 10);

    // Strict IPv4 dotted-quad validation (disallow leading zeros other than single 0)
    const ipv4Segment = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
    const ipv4Regex = new RegExp(
      `^${ipv4Segment}\\.${ipv4Segment}\\.${ipv4Segment}\\.${ipv4Segment}$`,
    );
    if (!ipv4Regex.test(ip) || !ipv4Regex.test(network)) return false;

    // Helper: convert IPv4 to 32-bit int
    const ipToInt = (addr: string): number =>
      addr
        .split('.')
        .reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;

    const ipInt = ipToInt(ip);
    const networkInt = ipToInt(network);

    // Compute mask (prefix 0 -> mask 0x00000000)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

    // Enforce canonical network: network must have host bits zero
    const maskedNetwork = (networkInt & mask) >>> 0;
    if (maskedNetwork !== networkInt) return false;

    const maskedIp = (ipInt & mask) >>> 0;
    return maskedIp === networkInt;
  } catch {
    return false;
  }
}

/**
 * Check if any IP in a list matches any entry in an allowlist (supports CIDR)
 * @param clientIps - Array of client IP addresses to check
 * @param allowlist - Array of allowed IPs or CIDR ranges
 * @returns true if any client IP is in the allowlist
 */
export function isAnyIpAllowlisted(
  clientIps: string[],
  allowlist: string[],
): boolean {
  if (!clientIps.length || !allowlist.length) {
    return false;
  }

  // Normalize IPs: trim whitespace, handle IPv4-mapped IPv6, remove duplicates
  const normalizedIps = Array.from(
    new Set(
      clientIps
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0)
        .map((ip) => normalizeIpv4MappedIpv6(ip)),
    ),
  );

  // Check if ANY IP matches any allowlist entry
  for (const ip of normalizedIps) {
    for (const allowedEntry of allowlist) {
      let isAllowed = false;

      if (allowedEntry.includes('/')) {
        // CIDR notation - use CIDR matching (IPv4 only)
        isAllowed = isIpInCidr(ip, allowedEntry);
      } else {
        // Exact string matching (works for both IPv4 and IPv6)
        isAllowed = ip === allowedEntry;
      }

      if (isAllowed) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if any IP in a list matches any entry in a blocklist (supports CIDR)
 * @param clientIps - Array of client IP addresses to check
 * @param blocklist - Array of blocked IPs or CIDR ranges
 * @returns true if any client IP is in the blocklist
 */
export function isAnyIpBlocked(
  clientIps: string[],
  blocklist: string[],
): boolean {
  if (!clientIps.length || !blocklist.length) {
    return false;
  }

  // Normalize IPs: trim whitespace, handle IPv4-mapped IPv6, remove duplicates
  const normalizedIps = Array.from(
    new Set(
      clientIps
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0)
        .map((ip) => normalizeIpv4MappedIpv6(ip)),
    ),
  );

  // Check if ANY IP matches any blocklist entry
  for (const ip of normalizedIps) {
    for (const blockedEntry of blocklist) {
      let isBlocked = false;

      if (blockedEntry.includes('/')) {
        // CIDR notation - use CIDR matching (IPv4 only)
        isBlocked = isIpInCidr(ip, blockedEntry);
      } else {
        // Exact string matching (works for both IPv4 and IPv6)
        isBlocked = ip === blockedEntry;
      }

      if (isBlocked) {
        return true;
      }
    }
  }

  return false;
}
