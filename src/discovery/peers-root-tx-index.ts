/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';
import { DataItemRootIndex, RootTxLookupResult } from '../types.js';
import { shuffleArray } from '../lib/random.js';
import { isValidDataId } from '../lib/validation.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

export type CachedPeerOffsets = RootTxLookupResult;

const METRICS_SOURCE = 'peers';

/**
 * Coerces a JSON offset/size field to a non-negative integer.
 *
 * Accepts both numbers and numeric strings: JSON emits these as numbers, but
 * being permissive costs nothing and keeps the parser tolerant of peers that
 * serialize large byte offsets as strings to dodge float precision limits.
 */
function parseOffsetValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Resolves root transaction offsets by asking peer AR.IO nodes for them
 * directly, over `GET /ar-io/offsets/:id`.
 *
 * This is the cheap sibling of {@link GatewaysRootTxIndex}. Both ultimately
 * read the same numbers out of a peer's index, but `GatewaysRootTxIndex`
 * harvests them from `X-AR-IO-Root-*` headers on `HEAD /raw/:id` — where they
 * are a byproduct of a successful *data retrieval*. When the peer doesn't have
 * the bytes cached, that HEAD runs its whole `ON_DEMAND_RETRIEVAL_ORDER`
 * cascade (trusted gateways, chunks, ANS-104 offset scanning) before
 * answering, so a miss is orders of magnitude more expensive than a hit. The
 * dedicated endpoint performs one indexed lookup and never touches contiguous
 * data, making misses as cheap as hits.
 *
 * Deliberately *no* header-based fallback: silently degrading to `HEAD /raw`
 * would reintroduce exactly the expensive probe this source exists to avoid.
 * Operators who want that fallback compose it explicitly by listing both
 * sources — `ROOT_TX_LOOKUP_ORDER=db,peers,gateways,...` — which is what the
 * ordered lookup list is for.
 *
 * Mirrors {@link GatewaysRootTxIndex}'s operational shape: priority tiers with
 * intra-tier shuffling, a per-peer token bucket, and a shared LRU cache.
 */
export class PeersRootTxIndex implements DataItemRootIndex {
  private log: winston.Logger;
  private peers: Map<number, string[]>;
  private readonly axiosInstance: AxiosInstance;
  private readonly cache?: LRUCache<string, CachedPeerOffsets>;
  private readonly limiters: Map<string, TokenBucket>;

  constructor({
    log,
    peerUrls,
    requestTimeoutMs = config.PEERS_ROOT_TX_REQUEST_TIMEOUT_MS,
    rateLimitBurstSize = config.PEERS_ROOT_TX_RATE_LIMIT_BURST_SIZE,
    rateLimitTokensPerInterval = config.PEERS_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL,
    rateLimitInterval = config.PEERS_ROOT_TX_RATE_LIMIT_INTERVAL,
    cache,
  }: {
    log: winston.Logger;
    peerUrls: Record<string, number>;
    requestTimeoutMs?: number;
    rateLimitBurstSize?: number;
    rateLimitTokensPerInterval?: number;
    rateLimitInterval?: 'second' | 'minute' | 'hour' | 'day';
    cache?: LRUCache<string, CachedPeerOffsets>;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cache = cache;

    if (Object.keys(peerUrls).length === 0) {
      throw new Error('At least one peer URL must be provided');
    }

    // Initialize per-peer rate limiters
    this.limiters = new Map();
    for (const url of Object.keys(peerUrls)) {
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
    this.peers = new Map();
    for (const [url, priority] of Object.entries(peerUrls)) {
      if (!this.peers.has(priority)) {
        this.peers.set(priority, []);
      }
      this.peers.get(priority)?.push(url);
    }

    this.axiosInstance = axios.create({
      timeout: requestTimeoutMs,
      headers: {
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
    });
  }

  async getRootTx(id: string): Promise<RootTxLookupResult | undefined> {
    const log = this.log.child({ method: 'getRootTx', id });

    // Guard before the ID reaches a URL path segment. No peer could resolve a
    // malformed ID anyway, so this costs nothing and keeps the request
    // well-formed.
    if (!isValidDataId(id)) {
      log.debug('Refusing to query peers for a malformed ID');
      return undefined;
    }

    const cached = this.cache?.get(id);
    if (cached !== undefined) {
      log.debug('Cache hit for peer offsets lookup');
      metrics.rootTxCacheHitTotal.inc({ source: METRICS_SOURCE });
      return cached;
    }
    metrics.rootTxCacheMissTotal.inc({ source: METRICS_SOURCE });

    // lower number = higher priority
    const priorities = Array.from(this.peers.keys()).sort((a, b) => a - b);

    for (const priority of priorities) {
      const peersInTier = this.peers.get(priority);
      if (peersInTier === undefined) {
        continue;
      }

      for (const peerUrl of shuffleArray([...peersInTier])) {
        // Apply per-peer rate limiting before making a request
        const limiter = this.limiters.get(peerUrl);
        if (!limiter?.tryRemoveTokens(1)) {
          log.debug('Rate limit exceeded for peer - skipping', {
            peer: peerUrl,
            tokensAvailable: limiter?.content ?? 0,
          });
          continue;
        }

        const url = `${peerUrl}/ar-io/offsets/${id}`;

        try {
          const response = await this.axiosInstance.get(url);
          const result = this.parseOffsets(response.data);

          if (result === undefined) {
            // A 200 whose body we can't make sense of means the peer is
            // running something other than this endpoint at that path. Try
            // the next peer rather than trusting a partial parse.
            log.debug('Peer returned an unusable offsets body', {
              peer: peerUrl,
            });
            continue;
          }

          this.cache?.set(id, result);
          log.debug('Successfully retrieved offsets from peer', {
            peer: peerUrl,
            rootTxId: result.rootTxId,
            rootOffset: result.rootOffset,
            rootDataOffset: result.rootDataOffset,
          });

          return result;
        } catch (error: any) {
          const status = error.response?.status;
          if (status === 404) {
            log.debug('Peer cannot resolve offsets (404)', { peer: peerUrl });
          } else {
            log.debug('Failed to query peer for offsets', {
              peer: peerUrl,
              status,
              error: error.message,
            });
          }
          // Continue to the next peer
        }
      }
    }

    log.debug('No peer resolved offsets');
    return undefined;
  }

  /**
   * Validates and narrows a peer's response body.
   *
   * Peers are trusted to be honest but not to be the same release, so every
   * field is treated as optional and separately validated: a peer that omits
   * or malforms the offsets still yields a usable `rootTxId`, and the
   * composite's short-circuit logic decides whether that partial result is
   * actionable.
   *
   * @returns the parsed result, or `undefined` when the body carries no usable
   *   root transaction ID.
   */
  private parseOffsets(body: unknown): RootTxLookupResult | undefined {
    if (typeof body !== 'object' || body === null) {
      return undefined;
    }

    const raw = body as Record<string, unknown>;
    const rootTxId = raw.rootTxId;
    if (typeof rootTxId !== 'string' || !isValidDataId(rootTxId)) {
      return undefined;
    }

    const path =
      Array.isArray(raw.path) &&
      raw.path.length > 0 &&
      raw.path.every(
        (entry) => typeof entry === 'string' && isValidDataId(entry),
      )
        ? (raw.path as string[])
        : undefined;

    return {
      rootTxId,
      path,
      rootOffset: parseOffsetValue(raw.rootOffset),
      rootDataOffset: parseOffsetValue(raw.rootDataOffset),
      contentType:
        typeof raw.contentType === 'string' ? raw.contentType : undefined,
      size: parseOffsetValue(raw.size),
      dataSize: parseOffsetValue(raw.dataSize),
    };
  }
}
