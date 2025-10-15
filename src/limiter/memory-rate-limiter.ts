/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
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
  x402Tokens: number; // Tokens purchased via x402 payment
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
        x402Tokens: 0, // No x402 tokens initially
        capacity,
        lastRefill: now,
        refillRate,
      };
      this.buckets.set(key, bucket);
      this.evictIfNeeded();
    } else {
      // Refill tokens based on elapsed time (only regular tokens refill)
      const elapsedSeconds = (now - bucket.lastRefill) / 1000;
      const tokensToAdd = elapsedSeconds * refillRate;
      bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
      bucket.capacity = capacity; // Update capacity in case config changed
      bucket.refillRate = refillRate; // Update refill rate in case config changed
      // Note: x402Tokens do not refill - they're only added by payment
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
   * Consume tokens from a bucket - prioritize x402 tokens first
   * Returns breakdown of consumption
   */
  private consumeTokens(
    bucket: TokenBucket,
    tokens: number,
  ): { success: boolean; x402: number; regular: number } {
    // First, try to consume from x402 tokens
    if (bucket.x402Tokens >= tokens) {
      // Sufficient x402 tokens to cover entire request
      bucket.x402Tokens -= tokens;
      return { success: true, x402: tokens, regular: 0 };
    } else if (bucket.x402Tokens > 0) {
      // Partial x402 tokens available, need to use regular tokens too
      const x402Used = bucket.x402Tokens;
      const remainingNeeded = tokens - x402Used;

      if (bucket.tokens >= remainingNeeded) {
        // Sufficient regular tokens for the remainder
        bucket.x402Tokens = 0;
        bucket.tokens -= remainingNeeded;
        return { success: true, x402: x402Used, regular: remainingNeeded };
      } else {
        // Insufficient total tokens
        return { success: false, x402: 0, regular: 0 };
      }
    } else {
      // No x402 tokens, consume from regular tokens only
      if (bucket.tokens >= tokens) {
        bucket.tokens -= tokens;
        return { success: true, x402: 0, regular: tokens };
      } else {
        // Insufficient tokens
        return { success: false, x402: 0, regular: 0 };
      }
    }
  }

  /**
   * Top off bucket with x402 tokens from payment
   */
  private topOffBucket(
    bucket: TokenBucket,
    contentLength: number,
    capacityMultiplier: number,
  ): void {
    const tokensToAdd = Math.ceil(contentLength / 1024) * capacityMultiplier;
    bucket.x402Tokens += tokensToAdd;
    log.debug('[MemoryRateLimiter] Topped off bucket with x402 tokens', {
      key: bucket.key,
      x402TokensAdded: tokensToAdd,
      totalX402Tokens: bucket.x402Tokens,
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

    const { ipKey } = this.buildBucketKeys(
      method,
      canonicalPath,
      primaryClientIp,
      host,
    );

    const now = Date.now();

    // Get or create IP bucket - this is the only rate limit we check
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

    // Consume from IP bucket - returns breakdown of x402 vs regular
    const consumeResult = this.consumeTokens(ipBucket, predictedTokens);

    if (!consumeResult.success) {
      log.info('[MemoryRateLimiter] IP limit exceeded', {
        key: ipKey,
        regularTokens: ipBucket.tokens,
        x402Tokens: ipBucket.x402Tokens,
        needed: predictedTokens,
      });

      return {
        allowed: false,
        limitType: 'ip',
      };
    }

    // Store bucket in request for later adjustment
    (req as any).ipBucket = ipBucket;

    return {
      allowed: true,
      ipTokensConsumed: predictedTokens,
      ipX402TokensConsumed: consumeResult.x402,
      ipRegularTokensConsumed: consumeResult.regular,
    };
  }

  /**
   * Adjust tokens based on actual response size
   */
  public async adjustTokens(
    req: Request,
    context: TokenAdjustmentContext,
  ): Promise<void> {
    const ipBucket = (req as any).ipBucket as TokenBucket | undefined;

    if (!ipBucket) {
      log.warn('[MemoryRateLimiter] No IP bucket found for token adjustment');
      return;
    }

    // Calculate total tokens needed based on response size
    const totalTokensNeeded = Math.max(
      1,
      Math.ceil(context.responseSize / 1024),
    );
    const ipTokenAdjustment = totalTokensNeeded - context.initialIpTokens;

    log.debug('[MemoryRateLimiter] Adjusting tokens', {
      responseSize: context.responseSize,
      totalTokensNeeded,
      ipAdjustment: ipTokenAdjustment,
      ipBefore: {
        regular: ipBucket.tokens,
        x402: ipBucket.x402Tokens,
      },
    });

    // Adjust IP bucket - consume additional or refund
    if (ipTokenAdjustment > 0) {
      // Need to consume more tokens - use the dual-token logic
      this.consumeTokens(ipBucket, ipTokenAdjustment);
    } else if (ipTokenAdjustment < 0) {
      // Refund tokens to regular pool (not x402)
      ipBucket.tokens = Math.max(
        0,
        Math.min(
          ipBucket.capacity,
          ipBucket.tokens - ipTokenAdjustment, // subtract negative = add
        ),
      );
    }

    log.debug('[MemoryRateLimiter] Tokens adjusted', {
      ipAfter: {
        regular: ipBucket.tokens,
        x402: ipBucket.x402Tokens,
      },
    });
  }
}
