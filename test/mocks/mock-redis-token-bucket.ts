/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  TokenBucket,
  RateLimiterRedisClient,
  BucketConsumptionResult,
} from '../../src/lib/rate-limiter-redis.js';

/**
 * Mock Redis client that simulates token bucket behavior
 * This simulates the actual Redis Lua scripts for testing
 */
export class MockRedisTokenBucketClient implements RateLimiterRedisClient {
  private buckets: Map<string, TokenBucket> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  public callCounts = {
    getOrCreateBucketAndConsume: 0,
    consumeTokens: 0,
  };

  constructor() {
    // Bind methods to preserve 'this' context
    this.getOrCreateBucketAndConsume =
      this.getOrCreateBucketAndConsume.bind(this);
    this.consumeTokens = this.consumeTokens.bind(this);
    this.defineCommand = this.defineCommand.bind(this);
  }

  /**
   * Mock defineCommand - does nothing but maintains API compatibility
   */
  defineCommand(_name: string, _opts: any): void {
    // No-op - just for API compatibility
  }

  /**
   * Mock event listener - does nothing but maintains API compatibility
   */
  on(_event: string, _handler: any): void {
    // No-op - just for API compatibility
  }

  /**
   * Simulates the Redis Lua script for getOrCreateBucketAndConsume
   * Creates/refills bucket and attempts to consume tokens atomically
   */
  async getOrCreateBucketAndConsume(
    key: string,
    capacity: number,
    refillRate: number,
    now: number,
    ttlSeconds: number,
    tokensToConsume: number,
    x402PaymentProvided: boolean = false,
    capacityMultiplier: number = 10,
    contentLengthForTopOff: number = 0,
  ): Promise<BucketConsumptionResult> {
    this.callCounts.getOrCreateBucketAndConsume++;

    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Create new bucket with base capacity
      bucket = {
        key,
        tokens: capacity,
        lastRefill: now,
        capacity,
        refillRate,
      };
      // If x402 payment provided, start with boosted tokens based on content size
      if (x402PaymentProvided) {
        let effectiveCapacity;
        if (contentLengthForTopOff > 0) {
          // Calculate proportional top-off based on content size
          const baseTokens = Math.max(
            1,
            Math.ceil(contentLengthForTopOff / 1024),
          );
          effectiveCapacity = baseTokens * capacityMultiplier;
        } else {
          // Fallback to base capacity multiplier if no content length provided
          effectiveCapacity = capacity * capacityMultiplier;
        }
        bucket.tokens = effectiveCapacity;
      }
    } else {
      // Calculate effective capacity for this operation
      const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
      let effectiveCapacity = bucket.capacity;
      let toAdd = 0;

      // Apply multipliers and calculate tokens to add based on payment status
      if (x402PaymentProvided) {
        // For paid requests: calculate proportional top-off based on content size
        if (contentLengthForTopOff > 0) {
          const baseTokens = Math.max(
            1,
            Math.ceil(contentLengthForTopOff / 1024),
          );
          effectiveCapacity = baseTokens * capacityMultiplier;
        } else {
          // Fallback to base capacity multiplier if no content length provided
          effectiveCapacity = effectiveCapacity * capacityMultiplier;
        }
        // Top-off to effective capacity (instant refill for paid requests)
        toAdd = effectiveCapacity;
      } else {
        // For unpaid requests: normal time-based refill at base rate
        toAdd = Math.floor(elapsedSeconds * bucket.refillRate);
      }

      // Add tokens but cap at effective capacity (prevents overflow)
      if (toAdd > 0) {
        bucket.tokens = Math.min(effectiveCapacity, bucket.tokens + toAdd);
        bucket.lastRefill = now;
      }
    }

    // Determine actual tokens needed (may override prediction with cached contentLength)
    let actualTokensNeeded = tokensToConsume;
    if (
      tokensToConsume > 0 &&
      bucket.contentLength != null &&
      bucket.contentLength > 0
    ) {
      actualTokensNeeded = Math.max(1, Math.ceil(bucket.contentLength / 1024));
    }

    // Ensure paidTokens field exists (for backward compatibility)
    if (bucket.paidTokens === undefined) {
      bucket.paidTokens = 0;
    }

    // Attempt to consume actual tokens needed, prioritizing paid tokens
    let consumed = 0;
    let paidConsumed = 0;
    let regularConsumed = 0;
    let success = false;

    if (actualTokensNeeded === 0) {
      // No tokens needed, always succeed
      success = true;
    } else if (bucket.paidTokens >= actualTokensNeeded) {
      // Sufficient paid tokens to cover entire request
      bucket.paidTokens -= actualTokensNeeded;
      paidConsumed = actualTokensNeeded;
      consumed = actualTokensNeeded;
      success = true;
    } else if (bucket.paidTokens > 0) {
      // Partial paid tokens, need to use regular tokens too
      paidConsumed = bucket.paidTokens;
      const remainingNeeded = actualTokensNeeded - paidConsumed;

      if (bucket.tokens >= remainingNeeded) {
        // Sufficient regular tokens for the remainder
        bucket.paidTokens = 0;
        bucket.tokens -= remainingNeeded;
        regularConsumed = remainingNeeded;
        consumed = actualTokensNeeded;
        success = true;
      } else {
        // Insufficient total tokens - fail the request (no partial consumption)
        success = false;
        consumed = 0;
        paidConsumed = 0;
        regularConsumed = 0;
      }
    } else if (bucket.tokens >= actualTokensNeeded) {
      // No paid tokens, consume from regular tokens only
      bucket.tokens -= actualTokensNeeded;
      regularConsumed = actualTokensNeeded;
      consumed = actualTokensNeeded;
      success = true;
    } else {
      // Insufficient tokens - fail the consumption (don't go negative in atomic operation)
      success = false;
      consumed = 0;
      paidConsumed = 0;
      regularConsumed = 0;
    }

    // Set TTL and save bucket
    this.setTTL(key, ttlSeconds * 1000);
    this.buckets.set(key, bucket);

    return {
      bucket,
      consumed,
      paidConsumed,
      regularConsumed,
      success,
    };
  }

  /**
   * Simulates the Redis Lua script for consumeTokens
   * Consumes tokens from the bucket, prioritizing paid tokens first
   */
  async consumeTokens(
    key: string,
    tokensToConsume: number,
    ttlSeconds: number,
    contentLength?: number,
  ): Promise<BucketConsumptionResult> {
    this.callCounts.consumeTokens++;

    const bucket = this.buckets.get(key);
    if (!bucket) {
      // Return error state if bucket doesn't exist
      return {
        bucket: {
          key,
          tokens: 0,
          paidTokens: 0,
          lastRefill: 0,
          capacity: 0,
          refillRate: 0,
        },
        consumed: 0,
        paidConsumed: 0,
        regularConsumed: 0,
        success: false,
      };
    }

    // Ensure paidTokens field exists (for backward compatibility)
    if (bucket.paidTokens === undefined) {
      bucket.paidTokens = 0;
    }

    let paidConsumed = 0;
    let regularConsumed = 0;

    if (tokensToConsume > 0) {
      // Positive cost: consume tokens prioritizing paid first
      if (bucket.paidTokens >= tokensToConsume) {
        // Sufficient paid tokens
        bucket.paidTokens -= tokensToConsume;
        paidConsumed = tokensToConsume;
      } else if (bucket.paidTokens > 0) {
        // Partial paid, remainder from regular
        paidConsumed = bucket.paidTokens;
        const remainder = tokensToConsume - paidConsumed;
        bucket.paidTokens = 0;
        bucket.tokens -= remainder;
        regularConsumed = remainder;
      } else {
        // No paid tokens, use regular only
        bucket.tokens -= tokensToConsume;
        regularConsumed = tokensToConsume;
      }
    } else if (tokensToConsume < 0) {
      // Negative cost: refund tokens (return to regular pool)
      bucket.tokens -= tokensToConsume; // subtract negative = add
    }

    // Store content length if provided (for resource buckets)
    if (contentLength !== undefined) {
      bucket.contentLength = contentLength;
    }

    // Reset TTL only
    this.setTTL(key, ttlSeconds * 1000);
    this.buckets.set(key, bucket);

    return {
      bucket,
      consumed: paidConsumed + regularConsumed,
      paidConsumed,
      regularConsumed,
      success: true,
    };
  }

  /**
   * Set TTL for a bucket - removes it after expiration
   */
  private setTTL(key: string, ms: number): void {
    // Clear existing timer
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
    }

    // Set new timer to remove bucket after TTL
    const timer = setTimeout(() => {
      this.buckets.delete(key);
      this.timers.delete(key);
    }, ms);

    this.timers.set(key, timer);
  }

  /**
   * Test helper: Get bucket directly
   */
  getBucket(key: string): TokenBucket | undefined {
    return this.buckets.get(key);
  }

  /**
   * Test helper: Check if bucket exists
   */
  hasBucket(key: string): boolean {
    return this.buckets.has(key);
  }

  /**
   * Test helper: Clear all buckets and timers
   */
  clear(): void {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.buckets.clear();
    this.callCounts.getOrCreateBucketAndConsume = 0;
    this.callCounts.consumeTokens = 0;
  }

  /**
   * Test helper: Set a bucket directly (for testing edge cases)
   */
  setBucket(key: string, bucket: TokenBucket): void {
    this.buckets.set(key, bucket);
  }

  /**
   * Test helper: Advance time for testing
   * Updates all bucket lastRefill times by the given amount
   */
  advanceTime(ms: number): void {
    for (const bucket of this.buckets.values()) {
      bucket.lastRefill -= ms;
    }
  }
}
