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
  paidTokens: number; // Tokens added via payment (e.g., x402)
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
        paidTokens: 0, // No paid tokens initially
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
      // Note: paidTokens do not refill - they're only added by payment
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
   * Consume tokens from a bucket - prioritize paid tokens first
   * Returns breakdown of consumption
   */
  private consumeTokens(
    bucket: TokenBucket,
    tokens: number,
  ): { success: boolean; paid: number; regular: number } {
    // First, try to consume from paid tokens
    if (bucket.paidTokens >= tokens) {
      // Sufficient paid tokens to cover entire request
      bucket.paidTokens -= tokens;
      return { success: true, paid: tokens, regular: 0 };
    } else if (bucket.paidTokens > 0) {
      // Partial paid tokens available, need to use regular tokens too
      const paidUsed = bucket.paidTokens;
      const remainingNeeded = tokens - paidUsed;

      if (bucket.tokens >= remainingNeeded) {
        // Sufficient regular tokens for the remainder
        bucket.paidTokens = 0;
        bucket.tokens -= remainingNeeded;
        return { success: true, paid: paidUsed, regular: remainingNeeded };
      } else {
        // Insufficient total tokens
        return { success: false, paid: 0, regular: 0 };
      }
    } else {
      // No paid tokens, consume from regular tokens only
      if (bucket.tokens >= tokens) {
        bucket.tokens -= tokens;
        return { success: true, paid: 0, regular: tokens };
      } else {
        // Insufficient tokens
        return { success: false, paid: 0, regular: 0 };
      }
    }
  }

  /**
   * Top off bucket with paid tokens from payment
   */
  private topOffBucket(
    bucket: TokenBucket,
    contentLength: number,
    capacityMultiplier: number,
  ): void {
    const tokensToAdd = Math.ceil(contentLength / 1024) * capacityMultiplier;
    bucket.paidTokens += tokensToAdd;
    log.debug('[MemoryRateLimiter] Topped off bucket with paid tokens', {
      key: bucket.key,
      paidTokensAdded: tokensToAdd,
      totalPaidTokens: bucket.paidTokens,
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

    // Get or create IP bucket - this is the primary rate limit
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

    // Consume from IP bucket - returns breakdown of paid vs regular
    const consumeResult = this.consumeTokens(ipBucket, predictedTokens);

    if (!consumeResult.success) {
      log.info('[MemoryRateLimiter] IP limit exceeded', {
        key: ipKey,
        regularTokens: ipBucket.tokens,
        paidTokens: ipBucket.paidTokens,
        needed: predictedTokens,
      });

      return {
        allowed: false,
        limitType: 'ip',
      };
    }

    // Store bucket in request for later adjustment
    (req as any).ipBucket = ipBucket;

    // Check resource bucket ONLY if no paid tokens were consumed
    // (paid requests bypass per-resource limits)
    if (consumeResult.paid === 0) {
      const resourceBucket = this.getOrCreateBucket(
        resourceKey,
        this.config.resourceCapacity,
        this.config.resourceRefillRate,
        now,
      );

      // Consume from resource bucket
      const resourceConsumeResult = this.consumeTokens(
        resourceBucket,
        predictedTokens,
      );

      if (!resourceConsumeResult.success) {
        // Resource limit exceeded - refund IP tokens and deny
        if (consumeResult.regular > 0) {
          ipBucket.tokens = Math.min(
            ipBucket.capacity,
            ipBucket.tokens + consumeResult.regular,
          );
        }

        log.info('[MemoryRateLimiter] Resource limit exceeded', {
          key: resourceKey,
          regularTokens: resourceBucket.tokens,
          paidTokens: resourceBucket.paidTokens,
          needed: predictedTokens,
        });

        return {
          allowed: false,
          limitType: 'resource',
        };
      }

      // Resource check passed - store bucket for later adjustment
      (req as any).resourceBucket = resourceBucket;

      return {
        allowed: true,
        ipTokensConsumed: predictedTokens,
        ipPaidTokensConsumed: consumeResult.paid,
        ipRegularTokensConsumed: consumeResult.regular,
        resourceTokensConsumed: predictedTokens,
        resourcePaidTokensConsumed: resourceConsumeResult.paid,
        resourceRegularTokensConsumed: resourceConsumeResult.regular,
      };
    }

    // Paid request - skip resource check
    return {
      allowed: true,
      ipTokensConsumed: predictedTokens,
      ipPaidTokensConsumed: consumeResult.paid,
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
    const resourceBucket = (req as any).resourceBucket as
      | TokenBucket
      | undefined;

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
    const resourceTokenAdjustment = resourceBucket
      ? totalTokensNeeded - context.initialResourceTokens
      : 0;

    log.debug('[MemoryRateLimiter] Adjusting tokens', {
      responseSize: context.responseSize,
      totalTokensNeeded,
      ipAdjustment: ipTokenAdjustment,
      resourceAdjustment: resourceTokenAdjustment,
      ipBefore: {
        regular: ipBucket.tokens,
        paid: ipBucket.paidTokens,
      },
      resourceBefore: resourceBucket
        ? {
            regular: resourceBucket.tokens,
            paid: resourceBucket.paidTokens,
          }
        : undefined,
    });

    // Adjust IP bucket - consume additional or refund
    if (ipTokenAdjustment > 0) {
      // Need to consume more tokens - use the dual-token logic
      this.consumeTokens(ipBucket, ipTokenAdjustment);
    } else if (ipTokenAdjustment < 0) {
      // Refund tokens to regular pool (not paid)
      ipBucket.tokens = Math.max(
        0,
        Math.min(
          ipBucket.capacity,
          ipBucket.tokens - ipTokenAdjustment, // subtract negative = add
        ),
      );
    }

    // Adjust resource bucket if it was checked
    if (resourceBucket) {
      if (resourceTokenAdjustment > 0) {
        // Need to consume more tokens - use the dual-token logic
        this.consumeTokens(resourceBucket, resourceTokenAdjustment);
      } else if (resourceTokenAdjustment < 0) {
        // Refund tokens to regular pool (not paid)
        resourceBucket.tokens = Math.max(
          0,
          Math.min(
            resourceBucket.capacity,
            resourceBucket.tokens - resourceTokenAdjustment, // subtract negative = add
          ),
        );
      }
    }

    log.debug('[MemoryRateLimiter] Tokens adjusted', {
      ipAfter: {
        regular: ipBucket.tokens,
        paid: ipBucket.paidTokens,
      },
      resourceAfter: resourceBucket
        ? {
            regular: resourceBucket.tokens,
            paid: resourceBucket.paidTokens,
          }
        : undefined,
    });
  }
}
