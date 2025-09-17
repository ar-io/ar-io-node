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
 * blocked origins and CIDR ranges before forwarding to the inner data source.
 */
export class FilteredContiguousDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private innerDataSource: ContiguousDataSource;
  private blockedOrigins: Set<string>;
  private blockedCidrs: string[];

  constructor({
    log,
    dataSource,
    blockedOrigins = [],
    blockedCidrs = [],
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    blockedOrigins?: string[];
    blockedCidrs?: string[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.innerDataSource = dataSource;
    this.blockedOrigins = new Set(blockedOrigins);
    this.blockedCidrs = blockedCidrs;

    this.log.info('FilteredContiguousDataSource initialized', {
      blockedOrigins: blockedOrigins.length,
      blockedCidrs: blockedCidrs.length,
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

    // Check if ANY IP matches any of the blocked CIDR ranges
    for (const ip of ipsToCheck) {
      for (const blockedCidr of this.blockedCidrs) {
        if (this.isIpInCidr(ip, blockedCidr)) {
          this.log.debug('IP blocked by CIDR', {
            ip,
            cidr: blockedCidr,
            allIps: ipsToCheck,
          });
          return true;
        }
      }
    }

    return false;
  }

  private isIpInCidr(ip: string, cidr: string): boolean {
    try {
      const [network, prefixLengthStr] = cidr.split('/');
      const prefixLength = parseInt(prefixLengthStr, 10);

      if (isNaN(prefixLength)) {
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
      const mask = (-1 << (32 - prefixLength)) >>> 0;

      return (ipNum & mask) === (networkNum & mask);
    } catch (error) {
      this.log.warn('Failed to parse CIDR', {
        cidr,
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
