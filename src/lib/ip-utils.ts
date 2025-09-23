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
    // Basic IPv4 validation
    if (!ip.includes('.') || ip.includes(':')) {
      return false; // Not IPv4
    }

    const [network, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);

    if (isNaN(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }

    // Convert IP and network to 32-bit integers
    const ipToInt = (ipAddr: string): number => {
      return (
        ipAddr
          .split('.')
          .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
      );
    };

    const ipInt = ipToInt(ip);
    const networkInt = ipToInt(network);

    // Handle /0 mask correctly - when prefix is 0, mask should be 0
    const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;

    return (ipInt & mask) === (networkInt & mask);
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
