/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import { Span } from '@opentelemetry/api';

/**
 * A wrapper around ContiguousDataSource that filters requests based on
 * blocked origins and IP addresses/CIDR ranges before forwarding to the inner data source.
 *
 * @example
 * ```typescript
 * const filteredSource = new FilteredContiguousDataSource({
 *   log,
 *   dataSource: innerSource,
 *   blockedOrigins: ['evil.gateway.com'],
 *   blockedIpsAndCidrs: ['192.168.1.1', '10.0.0.0/8', '2001:db8::1']
 * });
 * ```
 */
export class FilteredContiguousDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private innerDataSource: ContiguousDataSource;
  private blockedOrigins: Set<string>;
  private blockedCidrs: string[];

  /**
   * Creates a new FilteredContiguousDataSource
   *
   * @param options - Configuration options
   * @param options.log - Winston logger instance
   * @param options.dataSource - The inner data source to wrap
   * @param options.blockedOrigins - Array of origin strings to block (from X-AR-IO-Origin header)
   * @param options.blockedIpsAndCidrs - Array of IP addresses and CIDR ranges to block
   *   - Individual IPs: '192.168.1.1', '2001:db8::1'
   *   - CIDR ranges: '192.168.1.0/24', '10.0.0.0/8' (IPv4 only)
   */
  constructor({
    log,
    dataSource,
    blockedOrigins = [],
    blockedIpsAndCidrs = [],
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    blockedOrigins?: string[];
    /** Array of IP addresses and CIDR ranges to block. Individual IPs (IPv4/IPv6) and IPv4 CIDR ranges are supported. */
    blockedIpsAndCidrs?: string[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.innerDataSource = dataSource;
    this.blockedOrigins = new Set(blockedOrigins);
    this.blockedCidrs = blockedIpsAndCidrs;

    this.log.info('FilteredContiguousDataSource initialized', {
      blockedOrigins: blockedOrigins.length,
      blockedIpsAndCidrs: blockedIpsAndCidrs.length,
    });
  }

  private isOriginBlocked(origin?: string): boolean {
    if (origin === undefined || origin === '') {
      return false;
    }
    return this.blockedOrigins.has(origin);
  }

  private isCidrBlocked(clientIp?: string, clientIps?: string[]): boolean {
    const ipsToCheck: string[] = [];

    // Add legacy clientIp for backwards compatibility
    if (clientIp !== undefined && clientIp !== '') {
      ipsToCheck.push(clientIp);
    }

    // Add all client IPs if available
    if (clientIps && clientIps.length > 0) {
      ipsToCheck.push(...clientIps);
    }

    if (ipsToCheck.length === 0) {
      return false;
    }

    // Normalize IPs: trim whitespace, handle IPv4-mapped IPv6, remove duplicates
    const normalizedIps = Array.from(
      new Set(
        ipsToCheck
          .map((ip) => ip.trim())
          .filter((ip) => ip.length > 0)
          .map((ip) => {
            // Handle IPv4-mapped IPv6 addresses (::ffff:192.168.1.1)
            const ipv4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
            return ipv4MappedMatch ? ipv4MappedMatch[1] : ip;
          }),
      ),
    );

    // Check if ANY IP matches any of the blocked entries (exact match or CIDR range)
    for (const ip of normalizedIps) {
      for (const blockedEntry of this.blockedCidrs) {
        let isBlocked = false;

        if (blockedEntry.includes('/')) {
          // CIDR notation - use CIDR matching (IPv4 only)
          isBlocked = this.isIpInCidr(ip, blockedEntry);
        } else {
          // Exact string matching (works for both IPv4 and IPv6)
          isBlocked = ip === blockedEntry;
        }

        if (isBlocked) {
          this.log.debug('IP blocked', {
            ip,
            blockedEntry,
            matchType: blockedEntry.includes('/') ? 'cidr' : 'exact',
            allIps: normalizedIps,
          });
          return true;
        }
      }
    }

    return false;
  }

  private isIpInCidr(ip: string, cidr: string): boolean {
    try {
      // Early return for IPv6 addresses (contain ':' but no '.')
      if (ip.includes(':') && !ip.includes('.')) {
        return false;
      }

      // Support bare IPs by treating them as /32 CIDRs
      let network: string;
      let prefixLength: number;

      if (cidr.includes('/')) {
        [network, prefixLength] = cidr
          .split('/')
          .map((part, index) => (index === 0 ? part : parseInt(part, 10))) as [
          string,
          number,
        ];
      } else {
        // Bare IP - treat as /32 (exact match)
        network = cidr;
        prefixLength = 32;
      }

      // Validate CIDR prefix length (0-32 for IPv4)
      if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
        return false;
      }

      // Validate IPv4 addresses with stricter checks
      const validateIPv4 = (ipStr: string): boolean => {
        const octets = ipStr.split('.');
        if (octets.length !== 4) {
          return false;
        }
        return octets.every((octet) => {
          // Reject leading zeros (except "0" itself) to prevent octal interpretation
          if (octet.length > 1 && octet[0] === '0') {
            return false;
          }
          if (!/^\d+$/.test(octet)) {
            return false;
          }
          const num = parseInt(octet, 10);
          return num >= 0 && num <= 255;
        });
      };

      if (!validateIPv4(ip) || !validateIPv4(network)) {
        return false;
      }

      // Convert IPv4 addresses to numbers for comparison
      const ipToNumber = (ipStr: string): number => {
        return ipStr
          .split('.')
          .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
      };

      const ipNum = ipToNumber(ip);
      const networkNum = ipToNumber(network);

      // Handle /0 mask correctly - when prefixLength is 0, mask should be 0
      const mask = prefixLength === 0 ? 0 : (-1 << (32 - prefixLength)) >>> 0;

      return (ipNum & mask) === (networkNum & mask);
    } catch (error) {
      this.log.warn('Failed to parse CIDR', {
        cidr,
        ip,
        error: (error as Error).message,
      });
      return false;
    }
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
  }): Promise<ContiguousData> {
    // Check if request should be blocked
    if (requestAttributes) {
      if (this.isOriginBlocked(requestAttributes.origin)) {
        this.log.info('Blocking request due to blocked origin', {
          id,
          origin: requestAttributes.origin,
        });
        throw new Error(
          `Request blocked: origin '${requestAttributes.origin}' is blocked`,
        );
      }

      if (
        this.isCidrBlocked(
          requestAttributes.clientIp,
          requestAttributes.clientIps,
        )
      ) {
        this.log.info('Blocking request due to blocked IP', {
          id,
          clientIp: requestAttributes.clientIp,
          clientIps: requestAttributes.clientIps,
        });
        throw new Error(
          `Request blocked: One or more IPs in [${requestAttributes.clientIps?.join(', ') || requestAttributes.clientIp}] are blocked`,
        );
      }
    }

    // Request is not blocked, forward to inner data source
    return this.innerDataSource.getData({
      id,
      requestAttributes,
      region,
      parentSpan,
    });
  }
}
