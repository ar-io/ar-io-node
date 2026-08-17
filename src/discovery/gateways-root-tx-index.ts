/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance, AxiosResponse } from 'axios';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';
import { DataItemRootIndex } from '../types.js';
import { shuffleArray } from '../lib/random.js';
import { parseNonNegativeInt } from '../lib/http-utils.js';
import { createAgentPair } from '../lib/http-agent.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

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
 * - LRU caching of results
 * - Graceful fallback between gateways
 */
export class GatewaysRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedGatewayOffsets>;
  private readonly limiters: Map<string, TokenBucket>;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.GATEWAYS_ROOT_TX_REQUEST_TIMEOUT_MS,
    rateLimitBurstSize = config.GATEWAYS_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.GATEWAYS_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.GATEWAYS_ROOT_TX_RATE_LIMIT_INTERVAL,
    cache,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, number>;
    requestTimeoutMs?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    cache?: LRUCache<string, CachedGatewayOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = cache;

    if (Object.keys(trustedGatewaysUrls).length === 0) {
      throw new Error('At least one gateway URL must be provided');
    }

    // Initialize per-gateway rate limiters
    this.limiters = new Map();
    for (const url of Object.keys(trustedGatewaysUrls)) {
      this.limiters.set(
        url,
        new TokenBucket({
          bucketSize: rateLimitBurstSize,
          tokensPerInterval: rateLimitTokensPerInterval,
          interval: rateLimitInterval,
        }),
      );
    }

    // lower number = higher priority
    this.trustedGateways = new Map();
    for (const [url, priority] of Object.entries(trustedGatewaysUrls)) {
      if (!this.trustedGateways.has(priority)) {
        this.trustedGateways.set(priority, []);
      }
      this.trustedGateways.get(priority)?.push(url);
    }

    // Initialize axios instance
    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      ...createAgentPair({ client: 'GatewaysRootTxIndex', log: this.log }),
      headers: {
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
    });
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
      metrics.rootTxCacheHitTotal.inc({ source: 'gateways' });
      return cached;
    }
    metrics.rootTxCacheMissTotal.inc({ source: 'gateways' });

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
            // Apply per-gateway rate limiting before making request
            const limiter = this.limiters.get(gatewayUrl);
            if (!limiter?.tryRemoveTokens(1)) {
              log.debug('Rate limit exceeded for gateway - skipping', {
                id,
                gateway: gatewayUrl,
                tokensAvailable: limiter?.content ?? 0,
              });
              continue;
            }

            const url = `${gatewayUrl}/raw/${id}`;
            log.debug('Making HEAD request to gateway', { url });

            const response = await this.fetchPeerHeaders(url);

            // Parse offset headers from response.
            //
            // Naming-symmetry transition: peers running the latest code
            // emit the request-shaped pair (`X-AR-IO-Root-Item-Offset` /
            // `X-AR-IO-Root-Item-Size`) alongside the legacy pair
            // (`X-AR-IO-Root-Data-Item-Offset` / `X-AR-IO-Root-Data-Offset`).
            // Prefer the aligned name when present, fall back to legacy.
            // The legacy headers will be removed after a deprecation
            // window — see docs/glossary.md.
            const rootTxId = response.headers['x-ar-io-root-transaction-id'];
            const rootOffsetStr =
              response.headers['x-ar-io-root-item-offset'] ??
              response.headers['x-ar-io-root-data-item-offset'];
            const rootDataOffsetStr =
              response.headers['x-ar-io-root-data-offset'];
            const rootItemSizeStr = response.headers['x-ar-io-root-item-size'];
            const contentType = response.headers['content-type'];
            const contentLengthStr = response.headers['content-length'];

            // Root transaction ID found - offsets can only be present if root ID exists
            if (rootTxId) {
              const rootOffset = parseNonNegativeInt(rootOffsetStr);
              const rootDataOffset = parseNonNegativeInt(rootDataOffsetStr);
              // Content-Length is the size of the data, not the full data item with headers
              const dataSize = parseNonNegativeInt(contentLengthStr);
              // Prefer the explicit `Root-Item-Size` header when emitted;
              // otherwise compute the legacy way: header size + data size.
              const explicitItemSize = parseNonNegativeInt(rootItemSizeStr);
              const size =
                explicitItemSize !== undefined
                  ? explicitItemSize
                  : rootOffset !== undefined &&
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

  /**
   * HEAD `/raw/:id` first; on a non-404 failure (network error, 405, 5xx,
   * etc.) fall back to a zero-byte range GET. Some peers — especially
   * those behind CDNs or proxies — don't support HEAD on this route even
   * though the upstream gateway would. `bytes=0-0` is the smallest legal
   * range; the server returns 1 byte of body we discard, and the headers
   * are what we want.
   *
   * 404 is treated as a definitive "item doesn't exist on this peer" and
   * propagated to the caller — falling back to GET would just hit the
   * same 404 (or worse, mask a real not-found).
   *
   * Successful HEAD responses are returned as-is, even if they're missing
   * the `X-AR-IO-Root-*` headers (the data may legitimately have no
   * parent, e.g. an L1 tx) — falling back to GET in that case would just
   * waste a request without changing the answer.
   */
  private async fetchPeerHeaders(url: string): Promise<AxiosResponse> {
    try {
      return await this.axiosInstance.head(url);
    } catch (err: any) {
      // 404: respect; peer says item doesn't exist here.
      if (err.response?.status === 404) {
        throw err;
      }
      // Network error, 405 Method Not Allowed, 5xx, etc. — try GET.
      return this.axiosInstance.get(url, {
        headers: { Range: 'bytes=0-0' },
        responseType: 'arraybuffer',
      });
    }
  }
}
