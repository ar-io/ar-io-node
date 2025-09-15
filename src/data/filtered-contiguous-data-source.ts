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
 * blocked origins and IP addresses before forwarding to the inner data source.
 */
export class FilteredContiguousDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private innerDataSource: ContiguousDataSource;
  private blockedOrigins: Set<string>;
  private blockedIpAddresses: string[];

  constructor({
    log,
    dataSource,
    blockedOrigins = [],
    blockedIpAddresses = [],
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    blockedOrigins?: string[];
    blockedIpAddresses?: string[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.innerDataSource = dataSource;
    this.blockedOrigins = new Set(blockedOrigins);
    this.blockedIpAddresses = blockedIpAddresses;

    this.log.info('FilteredContiguousDataSource initialized', {
      blockedOrigins: blockedOrigins.length,
      blockedIpAddresses: blockedIpAddresses.length,
    });
  }

  private isOriginBlocked(origin?: string): boolean {
    if (origin === undefined || origin === '') {
      return false;
    }
    return this.blockedOrigins.has(origin);
  }

  private isIpBlocked(clientIp?: string): boolean {
    if (clientIp === undefined || clientIp === '') {
      return false;
    }

    // Simple string matching for now - could be enhanced with CIDR matching
    for (const blockedIp of this.blockedIpAddresses) {
      if (clientIp === blockedIp) {
        return true;
      }
      // Basic CIDR check - if blocked IP contains '/' treat as CIDR
      if (blockedIp.includes('/')) {
        if (this.isIpInCidr(clientIp, blockedIp)) {
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

      if (this.isIpBlocked(requestAttributes.clientIp)) {
        this.log.info('Blocking request due to blocked IP', {
          id,
          clientIp: requestAttributes.clientIp,
        });
        throw new Error(
          `Request blocked: IP '${requestAttributes.clientIp}' is blocked`,
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
