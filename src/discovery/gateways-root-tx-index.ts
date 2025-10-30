/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import * as rax from 'retry-axios';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';
import { DataItemRootIndex } from '../types.js';
import { shuffleArray } from '../lib/random.js';
import * as config from '../config.js';

export type CachedGatewayOffsets = {
  rootTxId: string;
  rootOffset?: number;
  rootDataOffset?: number;
  contentType?: string;
  size?: number;
  dataSize?: number;
};

/**
 * GatewaysRootTxIndex discovers root transaction offsets by making HEAD requests
 * to AR.IO gateways and parsing offset information from HTTP response headers.
 *
 * This provides a simpler, more universal solution for offset discovery that:
 * - Works with any AR.IO gateway that returns offset headers
 * - Doesn't require AWS credentials (unlike DynamoDB)
 * - Is more efficient than JSON API endpoints (HEAD vs GET)
 * - Leverages standard HTTP headers already in use
 *
 * The class supports:
 * - Multiple gateway URLs with priority tiers
 * - Rate limiting per gateway
 * - Automatic retries with exponential backoff
 * - LRU caching of results
 * - Graceful fallback between gateways
 */
export class GatewaysRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedGatewayOffsets>;
  private readonly limiter: TokenBucket;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    requestRetryCount = 3,
    rateLimitBurstSize = 5,
    rateLimitTokensPerInterval = 6,
    rateLimitInterval = 'minute',
    cache,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, number>;
    requestTimeoutMs?: number;
    requestRetryCount?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    cache?: LRUCache<string, CachedGatewayOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = cache;

    // Initialize rate limiter
    this.limiter = new TokenBucket({
      bucketSize: rateLimitBurstSize,
      tokensPerInterval: rateLimitTokensPerInterval,
      interval: rateLimitInterval,
    });

    if (Object.keys(trustedGatewaysUrls).length === 0) {
      throw new Error('At least one gateway URL must be provided');
    }

    // lower number = higher priority
    this.trustedGateways = new Map();
    for (const [url, priority] of Object.entries(trustedGatewaysUrls)) {
      if (!this.trustedGateways.has(priority)) {
        this.trustedGateways.set(priority, []);
      }
      this.trustedGateways.get(priority)?.push(url);
    }

    // Initialize axios instance with retry configuration
    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      headers: {
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
    });

    // Configure retry-axios for 429 handling with exponential backoff
    this.axiosInstance.defaults.raxConfig = {
      retry: requestRetryCount,
      instance: this.axiosInstance,
      statusCodesToRetry: [
        [100, 199],
        [429, 429],
        [500, 599],
      ],
      onRetryAttempt: (error: any) => {
        const cfg = rax.getConfig(error);
        const attempt = cfg?.currentRetryAttempt ?? 1;
        const status = error?.response?.status;

        log.debug('Retrying gateway HEAD request', {
          attempt,
          status,
          maxRetries: requestRetryCount,
          url: error?.config?.url,
        });
      },
    };

    rax.attach(this.axiosInstance);
  }

  async getRootTx(id: string): Promise<
    | {
        rootTxId: string;
        rootOffset?: number;
        rootDataOffset?: number;
        contentType?: string;
        size?: number;
        dataSize?: number;
      }
    | undefined
  > {
    const log = this.log.child({ method: 'getRootTx', id });

    // Check cache first
    const cached = this.cache?.get(id);
    if (cached !== undefined) {
      log.debug('Cache hit for gateway offsets lookup', { id });
      return cached;
    }

    // lower number = higher priority
    const priorities = Array.from(this.trustedGateways.keys()).sort(
      (a, b) => a - b,
    );

    let lastError: Error | null = null;

    for (const priority of priorities) {
      const gatewaysInTier = this.trustedGateways.get(priority);

      if (gatewaysInTier) {
        const shuffledGateways = shuffleArray([...gatewaysInTier]);

        for (const gatewayUrl of shuffledGateways) {
          try {
            // Apply rate limiting before making request
            if (!this.limiter.tryRemoveTokens(1)) {
              log.debug('Rate limit exceeded - skipping gateway', {
                id,
                gateway: gatewayUrl,
                tokensAvailable: this.limiter.content,
              });
              continue;
            }

            const url = `${gatewayUrl}/raw/${id}`;
            log.debug('Making HEAD request to gateway', { url });

            const response = await this.axiosInstance.head(url);

            // Parse offset headers from response
            const rootTxId = response.headers['x-ar-io-root-transaction-id'];
            const rootOffsetStr =
              response.headers['x-ar-io-root-data-item-offset'];
            const rootDataOffsetStr =
              response.headers['x-ar-io-root-data-offset'];
            const contentType = response.headers['content-type'];
            const contentLengthStr = response.headers['content-length'];

            // Root transaction ID found - offsets can only be present if root ID exists
            if (rootTxId) {
              const rootOffset = rootOffsetStr
                ? parseInt(rootOffsetStr, 10)
                : undefined;
              const rootDataOffset = rootDataOffsetStr
                ? parseInt(rootDataOffsetStr, 10)
                : undefined;
              // Content-Length is the size of the data, not the full data item with headers
              const dataSize = contentLengthStr
                ? parseInt(contentLengthStr, 10)
                : undefined;
              // Calculate total size if we have offsets: header size + data size
              const size =
                rootOffset !== undefined &&
                rootDataOffset !== undefined &&
                dataSize !== undefined
                  ? rootDataOffset - rootOffset + dataSize
                  : undefined;

              const result: CachedGatewayOffsets = {
                rootTxId,
                rootOffset,
                rootDataOffset,
                contentType,
                size,
                dataSize,
              };

              // Cache the result
              if (this.cache) {
                this.cache.set(id, result);
                log.debug('Cached gateway offsets result', { id, result });
              }

              log.debug('Successfully retrieved offsets from gateway', {
                id,
                rootTxId: result.rootTxId,
                rootOffset: result.rootOffset,
                rootDataOffset: result.rootDataOffset,
                gateway: gatewayUrl,
              });

              return result;
            }

            // No root ID in gateway response - item might not be nested or gateway doesn't support headers
            log.debug('No root ID in gateway response', {
              id,
              gateway: gatewayUrl,
              hasRootTxId: !!rootTxId,
            });
            // Continue to next gateway
          } catch (error: any) {
            if (error.response?.status === 404) {
              // Item not found in this gateway - try next
              log.debug('Item not found in gateway (404)', {
                id,
                gateway: gatewayUrl,
              });
              lastError = error;
              continue;
            }

            lastError = error;
            log.debug('Failed to query gateway', {
              gateway: gatewayUrl,
              error: error.message,
              status: error.response?.status,
            });
            // Continue to next gateway
          }
        }
      }
    }

    // All gateways failed or returned no offset headers
    if (lastError) {
      log.debug('Failed to retrieve offsets from all gateways', {
        id,
        error: lastError.message,
      });
    } else {
      log.debug('No gateways returned offset headers', { id });
    }

    return undefined;
  }
}
