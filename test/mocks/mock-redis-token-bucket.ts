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
  ): Promise<BucketConsumptionResult> {
    this.callCounts.getOrCreateBucketAndConsume++;

    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Create new bucket with full capacity
      bucket = {
        key,
        tokens: capacity,
        lastRefill: now,
        capacity,
        refillRate,
      };
    } else {
      // Calculate tokens to refill based on elapsed time
      const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
      const tokensToAdd = Math.floor(elapsedSeconds * refillRate);

      // Refill tokens, capped at capacity
      bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
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

    // Attempt to consume actual tokens needed
    let consumed = 0;
    let success = false;
    if (actualTokensNeeded === 0) {
      // No tokens needed, always succeed
      success = true;
    } else if (bucket.tokens >= actualTokensNeeded) {
      // Sufficient tokens - consume them
      bucket.tokens = bucket.tokens - actualTokensNeeded;
      consumed = actualTokensNeeded;
      success = true;
    } else {
      // Insufficient tokens - fail the consumption (don't go negative in atomic operation)
      success = false;
      consumed = 0;
    }

    // Set TTL and save bucket
    this.setTTL(key, ttlSeconds * 1000);
    this.buckets.set(key, bucket);

    return {
      bucket,
      consumed,
      success,
    };
  }

  /**
   * Simulates the Redis Lua script for consumeTokens
   * Consumes tokens from the bucket
   */
  async consumeTokens(
    key: string,
    tokensToConsume: number,
    ttlSeconds: number,
    contentLength?: number,
  ): Promise<number> {
    this.callCounts.consumeTokens++;

    const bucket = this.buckets.get(key);
    if (!bucket) {
      return -1; // Bucket doesn't exist
    }

    // Consume tokens (can go negative in real implementation)
    // Note: We no longer refill tokens here or update lastRefill - that's only done in getOrCreateBucket
    bucket.tokens = bucket.tokens - tokensToConsume;

    // Store content length if provided (for resource buckets)
    if (contentLength !== undefined) {
      bucket.contentLength = contentLength;
    }

    // Reset TTL only
    this.setTTL(key, ttlSeconds * 1000);
    this.buckets.set(key, bucket);

    return bucket.tokens;
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
