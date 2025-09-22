/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { TokenBucket, RateLimiterRedisClient } from '../../src/lib/rate-limiter-redis.js';

/**
 * Mock Redis client that simulates token bucket behavior
 * This simulates the actual Redis Lua scripts for testing
 */
export class MockRedisTokenBucketClient implements RateLimiterRedisClient {
  private buckets: Map<string, TokenBucket> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  public callCounts = {
    getOrCreateBucket: 0,
    consumeTokens: 0,
  };

  constructor() {
    // Bind methods to preserve 'this' context
    this.getOrCreateBucket = this.getOrCreateBucket.bind(this);
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
   * Simulates the Redis Lua script for getOrCreateBucket
   * Creates a new bucket or refills an existing one
   */
  async getOrCreateBucket(
    key: string,
    capacity: number,
    refillRate: number,
    now: number,
    ttlSeconds: number,
  ): Promise<string> {
    this.callCounts.getOrCreateBucket++;

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

    // Set TTL
    this.setTTL(key, ttlSeconds * 1000);
    this.buckets.set(key, bucket);

    return JSON.stringify(bucket);
  }

  /**
   * Simulates the Redis Lua script for consumeTokens
   * Consumes tokens from the bucket after refilling
   */
  async consumeTokens(
    key: string,
    tokensToConsume: number,
    now: number,
    ttlSeconds: number,
    contentLength?: number,
  ): Promise<number> {
    this.callCounts.consumeTokens++;

    const bucket = this.buckets.get(key);
    if (!bucket) {
      return -1; // Bucket doesn't exist
    }

    // Calculate tokens to refill based on elapsed time
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    const tokensToAdd = Math.floor(elapsedSeconds * bucket.refillRate);

    // Refill tokens, capped at capacity
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Consume tokens (can go negative in real implementation)
    bucket.tokens = bucket.tokens - tokensToConsume;

    // Store content length if provided (for resource buckets)
    if (contentLength !== undefined) {
      bucket.contentLength = contentLength;
    }

    // Reset TTL
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
    this.callCounts.getOrCreateBucket = 0;
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