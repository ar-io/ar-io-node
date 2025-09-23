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
import { isAnyIpBlocked } from '../lib/ip-utils.js';
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

    // Use shared utility function for IP blocking logic
    return isAnyIpBlocked(ipsToCheck, this.blockedCidrs);
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
