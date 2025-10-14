/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { isIP } from 'is-ip';
import { isAnyIpAllowlisted } from '../lib/ip-utils.js';
import log from '../log.js';
import {
  RateLimiter,
  RateLimitCheckResult,
  TokenAdjustmentContext,
} from './types.js';

/**
 * Token bucket stored in memory
 */
interface TokenBucket {
  key: string;
  tokens: number;
  capacity: number;
  lastRefill: number;
  refillRate: number;
  contentLength?: number; // Cached content length from previous requests
}

/**
 * Configuration options for memory rate limiter
 */
export interface MemoryRateLimiterConfig {
  resourceCapacity: number;
  resourceRefillRate: number;
  ipCapacity: number;
  ipRefillRate: number;
  limitsEnabled: boolean;
  ipAllowlist: string[];
  capacityMultiplier: number; // Multiplier for x402 payments
  maxBuckets?: number; // Maximum number of buckets to store (for LRU)
}

/**
 * In-memory rate limiter implementation using Map-based token buckets
 * Suitable for single-process deployments and local development
 */
export class MemoryRateLimiter implements RateLimiter {
  private buckets: Map<string, TokenBucket>;
  private config: MemoryRateLimiterConfig;
  private accessOrder: Map<string, number>; // For LRU eviction

  constructor(config: MemoryRateLimiterConfig) {
    this.config = config;
    this.buckets = new Map();
    this.accessOrder = new Map();
  }

  /**
   * Get canonical path from request
   */
  private getCanonicalPath(req: Request): string {
    const full = `${req.baseUrl || ''}${req.path || ''}`;
    const normalized = full === '' ? '/' : full.replace(/\/{2,}/g, '/');
    return normalized.slice(0, 256);
  }

  /**
   * Extract domain from host header
   */
  private extractDomain(host: string): string {
    if (!host) {
      return 'unknown';
    }

    const hostWithoutPort = host.split(':')[0];

    if (isIP(hostWithoutPort)) {
      return 'unknown';
    }

    const parts = hostWithoutPort.split('.');
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }

    return hostWithoutPort;
  }

  /**
   * Build bucket keys for resource and IP
   */
  private buildBucketKeys(
    method: string,
    path: string,
    ip: string,
    host: string,
  ): { resourceKey: string; ipKey: string } {
    const resourceTag = `rl:${method}:${host}:${path}`;
    return {
      resourceKey: `${resourceTag}:resource`,
      ipKey: `rl:ip:${ip}`,
    };
  }

  /**
   * Get or create a bucket with refill logic
   */
  private getOrCreateBucket(
    key: string,
    capacity: number,
    refillRate: number,
    now: number,
  ): TokenBucket {
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Create new bucket
      bucket = {
        key,
        tokens: capacity,
        capacity,
        lastRefill: now,
        refillRate,
      };
      this.buckets.set(key, bucket);
      this.evictIfNeeded();
    } else {
      // Refill tokens based on elapsed time
      const elapsedSeconds = (now - bucket.lastRefill) / 1000;
      const tokensToAdd = elapsedSeconds * refillRate;
      bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
      bucket.capacity = capacity; // Update capacity in case config changed
      bucket.refillRate = refillRate; // Update refill rate in case config changed
    }

    // Update access order for LRU
    this.accessOrder.set(key, now);

    return bucket;
  }

  /**
   * Evict least recently used buckets if we exceed max
   */
  private evictIfNeeded(): void {
    const maxBuckets = this.config.maxBuckets ?? 100000;
    if (this.buckets.size > maxBuckets) {
      // Find least recently used key
      let oldestKey: string | undefined;
      let oldestTime = Infinity;

      for (const [key, time] of this.accessOrder.entries()) {
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = key;
        }
      }

      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
        this.accessOrder.delete(oldestKey);
        log.debug('[MemoryRateLimiter] Evicted bucket', { key: oldestKey });
      }
    }
  }

  /**
   * Consume tokens from a bucket
   */
  private consumeTokens(bucket: TokenBucket, tokens: number): boolean {
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * Top off bucket capacity with payment
   */
  private topOffBucket(
    bucket: TokenBucket,
    contentLength: number,
    capacityMultiplier: number,
  ): void {
    const tokensToAdd = Math.ceil(contentLength / 1024) * capacityMultiplier;
    const newCapacity = bucket.capacity + tokensToAdd;
    bucket.capacity = newCapacity;
    bucket.tokens = Math.min(newCapacity, bucket.tokens + tokensToAdd);
    log.debug('[MemoryRateLimiter] Topped off bucket', {
      key: bucket.key,
      tokensAdded: tokensToAdd,
      newCapacity,
      newTokens: bucket.tokens,
    });
  }

  /**
   * Check IP allowlist
   */
  public isAllowlisted(clientIps: string[]): boolean {
    return isAnyIpAllowlisted(clientIps, this.config.ipAllowlist);
  }

  /**
   * Check rate limit and consume predicted tokens
   */
  public async checkLimit(
    req: Request,
    _res: Response,
    predictedTokens: number,
    x402PaymentProvided = false,
    contentLengthForTopOff = 0,
  ): Promise<RateLimitCheckResult> {
    const method = req.method;
    const canonicalPath = this.getCanonicalPath(req);
    const host = (req.headers.host ?? '').slice(0, 256);
    const primaryClientIp = req.ip ?? '0.0.0.0';

    const { resourceKey, ipKey } = this.buildBucketKeys(
      method,
      canonicalPath,
      primaryClientIp,
      host,
    );

    const now = Date.now();

    // Get or create resource bucket
    const resourceBucket = this.getOrCreateBucket(
      resourceKey,
      this.config.resourceCapacity,
      this.config.resourceRefillRate,
      now,
    );

    // Top off resource bucket if payment provided
    if (x402PaymentProvided && contentLengthForTopOff > 0) {
      this.topOffBucket(
        resourceBucket,
        contentLengthForTopOff,
        this.config.capacityMultiplier,
      );
    }

    // Calculate actual tokens needed from cached content length
    const actualTokensNeeded =
      resourceBucket.contentLength != null && resourceBucket.contentLength > 0
        ? Math.max(1, Math.ceil(resourceBucket.contentLength / 1024))
        : predictedTokens;

    // Consume from resource bucket
    const resourceSuccess = this.consumeTokens(resourceBucket, predictedTokens);

    if (!resourceSuccess) {
      log.info('[MemoryRateLimiter] Resource limit exceeded', {
        key: resourceKey,
        tokens: resourceBucket.tokens,
        needed: predictedTokens,
      });

      return {
        allowed: false,
        limitType: 'resource',
        cachedContentLength: resourceBucket.contentLength,
      };
    }

    // Get or create IP bucket
    const ipBucket = this.getOrCreateBucket(
      ipKey,
      this.config.ipCapacity,
      this.config.ipRefillRate,
      now,
    );

    // Top off IP bucket if payment provided
    if (x402PaymentProvided && contentLengthForTopOff > 0) {
      this.topOffBucket(
        ipBucket,
        contentLengthForTopOff,
        this.config.capacityMultiplier,
      );
    }

    // Consume from IP bucket
    const ipSuccess = this.consumeTokens(ipBucket, actualTokensNeeded);

    if (!ipSuccess) {
      // Rollback resource bucket consumption
      resourceBucket.tokens += predictedTokens;

      log.info('[MemoryRateLimiter] IP limit exceeded', {
        key: ipKey,
        tokens: ipBucket.tokens,
        needed: actualTokensNeeded,
      });

      return {
        allowed: false,
        limitType: 'ip',
        cachedContentLength: resourceBucket.contentLength,
      };
    }

    // Store buckets in request for later adjustment
    (req as any).resourceBucket = resourceBucket;
    (req as any).ipBucket = ipBucket;

    return {
      allowed: true,
      resourceTokensConsumed: predictedTokens,
      ipTokensConsumed: actualTokensNeeded,
      cachedContentLength: resourceBucket.contentLength,
    };
  }

  /**
   * Adjust tokens based on actual response size
   */
  public async adjustTokens(
    req: Request,
    context: TokenAdjustmentContext,
  ): Promise<void> {
    const resourceBucket = (req as any).resourceBucket as
      | TokenBucket
      | undefined;
    const ipBucket = (req as any).ipBucket as TokenBucket | undefined;

    if (!resourceBucket || !ipBucket) {
      log.warn('[MemoryRateLimiter] No buckets found for token adjustment');
      return;
    }

    // Calculate total tokens needed based on response size
    const totalTokensNeeded = Math.max(
      1,
      Math.ceil(context.responseSize / 1024),
    );
    const resourceTokenAdjustment =
      totalTokensNeeded - context.initialResourceTokens;
    const ipTokenAdjustment = totalTokensNeeded - context.initialIpTokens;

    log.debug('[MemoryRateLimiter] Adjusting tokens', {
      responseSize: context.responseSize,
      totalTokensNeeded,
      resourceAdjustment: resourceTokenAdjustment,
      ipAdjustment: ipTokenAdjustment,
      resourceBefore: resourceBucket.tokens,
      ipBefore: ipBucket.tokens,
    });

    // Adjust resource bucket
    if (resourceTokenAdjustment !== 0) {
      resourceBucket.tokens = Math.max(
        0,
        resourceBucket.tokens - resourceTokenAdjustment,
      );
      // Cache content length for future requests
      resourceBucket.contentLength = context.responseSize;
    }

    // Adjust IP bucket
    if (ipTokenAdjustment !== 0) {
      ipBucket.tokens = Math.max(0, ipBucket.tokens - ipTokenAdjustment);
    }

    log.debug('[MemoryRateLimiter] Tokens adjusted', {
      resourceAfter: resourceBucket.tokens,
      ipAfter: ipBucket.tokens,
    });
  }
}
