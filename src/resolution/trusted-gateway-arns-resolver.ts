/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import winston from 'winston';
import { headerNames } from '../constants.js';

import { isValidDataId } from '../lib/validation.js';
import { NameResolution, NameResolver } from '../types.js';

export const DEFAULT_ARNS_TTL_SECONDS = 60 * 15; // 15 minutes
export const DEFAULT_ARNS_UNDERNAME_LIMIT = 10;
export const DEFAULT_ARNS_UNDERNAME_INDEX = 0;

export class TrustedGatewayArNSResolver implements NameResolver {
  private log: winston.Logger;
  private trustedGatewayUrl: string;

  constructor({
    log,
    trustedGatewayUrl,
  }: {
    log: winston.Logger;
    trustedGatewayUrl: string;
  }) {
    this.log = log.child({ class: 'TrustedGatewayArNSResolver' });
    this.trustedGatewayUrl = trustedGatewayUrl;
  }

  async resolve({ name }: { name: string }): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      const nameUrl = this.trustedGatewayUrl.replace('__NAME__', name);
      const response = await axios({
        method: 'HEAD',
        url: '/',
        baseURL: nameUrl,
        validateStatus: (status) => [200, 404, 402].includes(status),
      });
      const resolvedId =
        response.headers[headerNames.arnsResolvedId.toLowerCase()];
      const processId =
        response.headers[headerNames.arnsProcessId.toLowerCase()];
      const ttl =
        parseInt(response.headers[headerNames.arnsTtlSeconds.toLowerCase()]) ||
        DEFAULT_ARNS_TTL_SECONDS;
      const limit =
        parseInt(response.headers[headerNames.arnsLimit.toLowerCase()]) ||
        DEFAULT_ARNS_UNDERNAME_LIMIT;
      const index =
        parseInt(response.headers[headerNames.arnsIndex.toLowerCase()]) ||
        DEFAULT_ARNS_UNDERNAME_INDEX;
      if (isValidDataId(resolvedId)) {
        this.log.info('Resolved name', { name, nameUrl, resolvedId, ttl });
        return {
          name,
          statusCode: response.status,
          resolvedId,
          resolvedAt: Date.now(),
          processId,
          ttl,
          limit,
          index,
        };
      } else {
        this.log.warn('Invalid resolved data ID', {
          name,
          nameUrl,
          resolvedId,
          ttl,
          limit,
          index,
        });
      }
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      processId: undefined,
      limit: undefined,
      index: undefined,
    };
  }
}
