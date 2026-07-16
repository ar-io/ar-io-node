/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request } from 'express';

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

/**
 * Extract and validate all client IPs from request headers and connection
 * @param req - Express request object
 * @returns Object containing primary clientIp and array of all clientIps
 */
export function extractAllClientIPs(req: Request): {
  clientIp?: string;
  clientIps: string[];
} {
  const clientIps: string[] = [];
  let clientIp: string | undefined;

  // Extract X-Forwarded-For header
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor !== undefined && xForwardedFor !== '') {
    // Handle both string and string[] headers (Express can return either)
    const forwardedValues = Array.isArray(xForwardedFor)
      ? xForwardedFor.flatMap((h) => h.split(','))
      : xForwardedFor.split(',');

    // Process each IP with validation and normalization
    for (const rawIp of forwardedValues) {
      const ip = rawIp.trim();

      // Skip empty, unknown, or invalid entries
      if (!ip || ip.toLowerCase() === 'unknown') {
        continue;
      }

      // Normalize IPv4-mapped IPv6 (::ffff:192.168.1.1 -> 192.168.1.1)
      const normalizedIp = normalizeIpv4MappedIpv6(ip);

      // Basic validation - check for valid IP format
      if (isValidIpFormat(normalizedIp)) {
        clientIps.push(normalizedIp);
      }
    }

    // Keep first valid IP for backwards compatibility
    clientIp = clientIps[0];
  }

  // Extract X-Real-IP header (commonly used by nginx)
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp !== undefined && xRealIp !== '') {
    // Handle both string and string[] headers (Express can return either)
    const realIpValue = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
    const trimmedRealIp = realIpValue.trim();

    // Skip empty, unknown, or invalid entries
    if (trimmedRealIp && trimmedRealIp.toLowerCase() !== 'unknown') {
      // Normalize IPv4-mapped IPv6 (::ffff:192.168.1.1 -> 192.168.1.1)
      const normalizedRealIp = normalizeIpv4MappedIpv6(trimmedRealIp);

      // Basic validation - check for valid IP format
      if (
        isValidIpFormat(normalizedRealIp) &&
        !clientIps.includes(normalizedRealIp)
      ) {
        clientIps.push(normalizedRealIp);
        // Set as fallback if no X-Forwarded-For
        if (clientIp === undefined) {
          clientIp = normalizedRealIp;
        }
      }
    }
  }

  // Always include remote address if available (even when X-Forwarded-For or X-Real-IP is present)
  if (
    req.socket?.remoteAddress !== undefined &&
    req.socket.remoteAddress !== ''
  ) {
    const remoteIp = req.socket.remoteAddress;
    // Normalize IPv4-mapped IPv6
    const normalizedRemote = normalizeIpv4MappedIpv6(remoteIp);

    if (!clientIps.includes(normalizedRemote)) {
      clientIps.push(normalizedRemote);
    }
    // Set as fallback if no X-Forwarded-For or X-Real-IP
    if (clientIp === undefined) {
      clientIp = normalizedRemote;
    }
  }

  // Fallback to req.ip if available and not already included
  if (req.ip !== undefined && req.ip !== '' && !clientIps.includes(req.ip)) {
    const normalizedReqIp = normalizeIpv4MappedIpv6(req.ip);
    if (
      isValidIpFormat(normalizedReqIp) &&
      !clientIps.includes(normalizedReqIp)
    ) {
      clientIps.push(normalizedReqIp);
      if (clientIp === undefined) {
        clientIp = normalizedReqIp;
      }
    }
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
 * Expand an IPv6 address to its 8 zero-padded 16-bit hex groups, or undefined if
 * it cannot be parsed. Handles `::` zero-compression. ip-utils otherwise only
 * does basic IPv6 validation; this is the minimum needed for prefix bucketing
 * (see {@link ipFaultDomain}).
 */
export function expandIpv6(ip: string): string[] | undefined {
  if (!ip.includes(':')) return undefined;
  const halves = ip.split('::');
  if (halves.length > 2) return undefined; // at most one `::`

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return undefined;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;

  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    out.push(parseInt(g, 16).toString(16).padStart(4, '0'));
  }
  return out;
}

/**
 * Reduce a peer host to a stable "fault domain" bucket key — the network block
 * an address belongs to — for seeding-diversity accounting. Two peers in the
 * same bucket count as one fault domain (e.g. the five `tip-*.arweave.xyz` nodes
 * all resolve into `38.29.227.0/24`).
 *
 * - IPv4 (incl. IPv4-mapped IPv6): masked to /`v4Bits` (default 24) → `"a.b.c.0/24"`.
 * - IPv6: expanded + truncated to the first `v6Bits` (default 48) → `"2001:db8:abcd::/48"`.
 * - Not a valid IP (e.g. an unresolved hostname): returned verbatim, so it counts
 *   as its own domain rather than silently collapsing distinct hosts.
 *
 * Pure and hot-path cheap; performs no DNS. Callers pass the already-resolved
 * peer host (the chunk-POST peer list is IP-literal after DNS resolution).
 */
export function ipFaultDomain(
  host: string,
  { v4Bits = 24, v6Bits = 48 }: { v4Bits?: number; v6Bits?: number } = {},
): string {
  const normalized = normalizeIpv4MappedIpv6(host.trim());

  // IPv4
  const ipv4Segment = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
  const ipv4Regex = new RegExp(
    `^${ipv4Segment}\\.${ipv4Segment}\\.${ipv4Segment}\\.${ipv4Segment}$`,
  );
  if (ipv4Regex.test(normalized)) {
    const bits = Math.max(0, Math.min(32, v4Bits));
    const ipInt =
      normalized
        .split('.')
        .reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const net = (ipInt & mask) >>> 0;
    const octets = [
      (net >>> 24) & 0xff,
      (net >>> 16) & 0xff,
      (net >>> 8) & 0xff,
      net & 0xff,
    ].join('.');
    return `${octets}/${bits}`;
  }

  // IPv6
  if (normalized.includes(':')) {
    const groups = expandIpv6(normalized);
    if (groups !== undefined) {
      const bits = Math.max(0, Math.min(128, v6Bits));
      const keptGroups = Math.ceil(bits / 16);
      const masked = groups.slice(0, keptGroups).map((g, i) => {
        const groupHigh = (i + 1) * 16;
        if (groupHigh <= bits) return g; // group fully inside the prefix
        const groupBits = bits - i * 16; // partial group: 1..15 bits kept
        const m = groupBits === 0 ? 0 : (0xffff << (16 - groupBits)) & 0xffff;
        return ((parseInt(g, 16) & m) >>> 0).toString(16).padStart(4, '0');
      });
      const prefix = masked.join(':');
      return keptGroups < 8 ? `${prefix}::/${bits}` : `${prefix}/${bits}`;
    }
  }

  // Not a parseable IP (unresolved hostname, garbage): its own domain.
  return host.trim();
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
