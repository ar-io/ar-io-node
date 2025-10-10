/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Request, Response, NextFunction } from 'express';
import { MockRedisTokenBucketClient } from '../../test/mocks/mock-redis-token-bucket.js';
import { rateLimiterMiddleware } from './rate-limiter.js';
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  waitForAsync,
  simulateResponse,
} from '../../test/utils/rate-limiter-test-helpers.js';

// Create mock Redis client at module level
const mockRedis = new MockRedisTokenBucketClient();

// Helper function to create middleware with mock Redis client
function createTestMiddleware(options: any = {}) {
  return rateLimiterMiddleware({
    ...options,
    redisClient: mockRedis,
  });
}

describe('Rate Limiter Tests', () => {
  beforeEach(() => {
    // Clear mock state for each test
    mockRedis.clear();
    mock.restoreAll();
  });

  afterEach(() => {
    // Clean up after each test
    mockRedis.clear();
    mock.restoreAll();
  });

  describe('Token Bucket Behavior', () => {
    it('should create new bucket with full capacity', async () => {
      const now = Date.now();
      const result = await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now,
        60,
        0, // Don't consume any tokens
      );

      assert.strictEqual(result.bucket.tokens, 100);
      assert.strictEqual(result.bucket.capacity, 100);
      assert.strictEqual(result.bucket.refillRate, 10);
      assert.strictEqual(result.bucket.lastRefill, now);
      assert.strictEqual(result.consumed, 0);
      assert.strictEqual(result.success, true);
    });

    it('should refill tokens over time', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now,
        60,
        0,
      );

      // Simulate 5 seconds passing
      const later = now + 5000;
      const result = await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        later,
        60,
        0,
      );

      // Should have refilled 50 tokens (10 per second * 5 seconds)
      assert.strictEqual(result.bucket.tokens, 100); // Still at capacity
    });

    it('should cap refill at capacity', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now,
        60,
        30,
      );

      // Simulate 10 seconds passing (would refill 100 tokens, but capped at capacity)
      const result = await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now + 10000,
        60,
        0,
      );
      assert.strictEqual(result.bucket.tokens, 100);
    });

    it('should consume tokens correctly', async () => {
      const now = Date.now();
      const result = await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now,
        60,
        25,
      );

      assert.strictEqual(result.bucket.tokens, 75);
      assert.strictEqual(result.consumed, 25);
      assert.strictEqual(result.success, true);

      const bucket = mockRedis.getBucket('test-key');
      assert.strictEqual(bucket?.tokens, 75);
    });

    it('should allow tokens to go negative with consumeTokens', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        10,
        1,
        now,
        60,
        0,
      );

      // Use consumeTokens which allows negative tokens
      const remaining = await mockRedis.consumeTokens('test-key', 20, 60);
      assert.strictEqual(remaining, -10);
    });

    it('should store content length in bucket', async () => {
      const now = Date.now();
      const result = await mockRedis.getOrCreateBucketAndConsume(
        'test-key',
        100,
        10,
        now,
        60,
        10,
      );

      await mockRedis.consumeTokens('test-key', 0, 60, 1024);

      const bucket = mockRedis.getBucket('test-key');
      assert.strictEqual(bucket?.contentLength, 1024);
    });

    describe('Atomic consumption behavior', () => {
      it('should fail when insufficient tokens', async () => {
        const now = Date.now();
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          10,
          1,
          now,
          60,
          20,
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.consumed, 0);
        assert.strictEqual(result.bucket.tokens, 10); // Tokens should remain unchanged
      });

      it('should consume exact amount when sufficient tokens', async () => {
        const now = Date.now();
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          100,
          1,
          now,
          60,
          50,
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.consumed, 50);
        assert.strictEqual(result.bucket.tokens, 50);
      });

      it('should work with refilled tokens', async () => {
        const now = Date.now();
        // Create bucket and consume most tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          100,
          10,
          now,
          60,
          90,
        );

        // Wait and try to consume more - should succeed due to refill
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          100,
          10,
          now + 5000,
          60,
          40,
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.consumed, 40);
        // Should have: 10 remaining + (10*5) refilled - 40 consumed = 20
        assert.strictEqual(result.bucket.tokens, 20);
      });

      it('should cache contentLength correctly', async () => {
        const now = Date.now();
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          100,
          10,
          now,
          60,
          10,
        );

        // Simulate setting contentLength
        await mockRedis.consumeTokens('test-key', 0, 60, 2048);

        // Next atomic consumption should use cached contentLength for actualTokensNeeded
        const result2 = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          100,
          10,
          now,
          60,
          5,
        );

        assert.strictEqual(result2.success, true);
        assert.strictEqual(result2.consumed, 2); // Should consume based on contentLength (2048 bytes = 2 tokens), not requested 5

        const bucket = mockRedis.getBucket('test-key');
        assert.strictEqual(bucket?.contentLength, 2048);
      });
    });
  });

  describe('Middleware Integration', () => {
    it('should allow request when tokens are available', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual((res as any).getStatus(), 200);
    });

    it('should track buckets on request object', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      assert.ok(req.resourceBucket);
      assert.ok(req.ipBucket);
      assert.strictEqual(req.resourceBucket.capacity, 100);
      assert.strictEqual(req.ipBucket.capacity, 100);
    });

    it('should handle different domains correctly', async () => {
      const middleware = createTestMiddleware();

      const req1 = createMockRequest('GET', '/test', '192.168.1.1', {
        host: 'example.com',
      });
      const req2 = createMockRequest('GET', '/test', '192.168.1.1', {
        host: 'another.org',
      });

      const res1 = createMockResponse();
      const res2 = createMockResponse();
      const next1 = createMockNext();
      const next2 = createMockNext();

      await middleware(
        req1 as Request,
        res1 as Response,
        next1 as NextFunction,
      );
      await middleware(
        req2 as Request,
        res2 as Response,
        next2 as NextFunction,
      );

      // Different domains should have different resource keys
      assert.notStrictEqual(req1.resourceBucket?.key, req2.resourceBucket?.key);
      // But same IP should have the same IP keys for different domains
      assert.strictEqual(req1.ipBucket?.key, req2.ipBucket?.key);
    });

    it('should handle IP allowlist correctly', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['192.168.1.1', '10.0.0.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting for allowlisted IP
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });
  });

  describe('Enhanced IP Allowlist with Forwarded Headers', () => {
    it('should allow request when X-Forwarded-For first IP is allowlisted', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['203.0.113.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1, 172.16.0.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since first IP in chain is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should allow request when X-Forwarded-For second IP is allowlisted', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['192.168.1.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1, 172.16.0.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since second IP in chain is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should allow request when X-Forwarded-For last IP is allowlisted', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['172.16.0.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1, 172.16.0.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since last IP in chain is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should apply rate limiting when no IP in chain is allowlisted', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['10.0.0.5'],
        limitsEnabled: true,
        resourceCapacity: 100,
        ipCapacity: 100,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1, 172.16.0.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should proceed with rate limiting since no IP is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.ok(req.resourceBucket);
      assert.ok(req.ipBucket);
    });

    it('should handle X-Real-IP header in allowlist check', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['198.51.100.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-real-ip': '198.51.100.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since X-Real-IP is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should handle socket.remoteAddress in allowlist check', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['127.0.0.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '127.0.0.1');
      // Simulate socket.remoteAddress
      (req as any).socket = { remoteAddress: '127.0.0.1' };

      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since socket IP is allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should support CIDR ranges in allowlist', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['192.168.1.0/24'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.100, 172.16.0.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since 192.168.1.100 is in 192.168.1.0/24
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should handle IPv4-mapped IPv6 addresses in allowlist', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['192.168.1.1'],
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '::ffff:192.168.1.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since ::ffff:192.168.1.1 normalizes to 192.168.1.1
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should handle malformed headers gracefully', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['192.168.1.1'],
        limitsEnabled: true,
        resourceCapacity: 100,
        ipCapacity: 100,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': 'unknown, , 192.168.1.1, invalid-ip',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should skip rate limiting since 192.168.1.1 is valid and allowlisted
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual(req.resourceBucket, undefined);
      assert.strictEqual(req.ipBucket, undefined);
    });

    it('should use primary client IP for bucket keys even when allowlist check fails', async () => {
      const middleware = createTestMiddleware({
        ipAllowlist: ['10.0.0.5'], // Not in the request
        limitsEnabled: true,
        resourceCapacity: 100,
        ipCapacity: 100,
      });

      const req = createMockRequest('GET', '/test', '10.0.0.1', {
        'x-forwarded-for': '203.0.113.1, 192.168.1.1',
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should proceed with rate limiting and use first valid IP (203.0.113.1) for bucket keys
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.ok(req.resourceBucket);
      assert.ok(req.ipBucket);

      // Bucket keys should be based on first IP from X-Forwarded-For
      assert.ok(req.ipBucket.key.includes('203.0.113.1'));
    });
  });

  describe('Rate Limiting', () => {
    it('should block request when resource tokens exhausted', async () => {
      // Create bucket with only 1 token
      const now = Date.now();
      mockRedis.setBucket('{rl:GET:example.com:/test}:resource', {
        key: '{rl:GET:example.com:/test}:resource',
        tokens: 0,
        lastRefill: now,
        capacity: 100,
        refillRate: 0,
      });

      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 0,
        ipCapacity: 100,
        ipRefillRate: 10,
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      assert.strictEqual((res as any).getStatus(), 429);
      assert.deepStrictEqual((res as any).getResponseData(), {
        error: 'Too Many Requests',
        message: 'Resource rate limit exceeded',
      });
      assert.strictEqual((next as any).mock.calls.length, 0);
    });

    it('should block request when IP tokens exhausted', async () => {
      // Create IP bucket with 0 tokens
      const now = Date.now();
      mockRedis.setBucket('rl:ip:192.168.1.1', {
        key: 'rl:ip:192.168.1.1',
        tokens: 0,
        lastRefill: now,
        capacity: 100,
        refillRate: 0,
      });

      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 0,
        limitsEnabled: true,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      assert.strictEqual((res as any).getStatus(), 429);
      assert.deepStrictEqual((res as any).getResponseData(), {
        error: 'Too Many Requests',
        message: 'IP rate limit exceeded',
      });
      assert.strictEqual((next as any).mock.calls.length, 0);
    });

    it('should allow request when limits disabled even with no tokens', async () => {
      const now = Date.now();
      mockRedis.setBucket('{rl:GET:example.com:/test}:resource', {
        key: '{rl:GET:example.com:/test}:resource',
        tokens: 0,
        lastRefill: now,
        capacity: 100,
        refillRate: 0,
      });

      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 0,
        ipCapacity: 100,
        ipRefillRate: 10,
        limitsEnabled: false, // Limits disabled
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should allow through even with no tokens
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual((res as any).getStatus(), 200);
    });
  });

  describe('Token Consumption', () => {
    it('should consume tokens based on response size', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Simulate 5KB response
      simulateResponse(res, 5120);

      // Wait for async operations
      await waitForAsync();

      // Check tokens were consumed (5KB = 5 tokens)
      assert.ok(req.resourceBucket?.key);
      assert.ok(req.ipBucket?.key);
      const resourceBucket = mockRedis.getBucket(req.resourceBucket.key);
      const ipBucket = mockRedis.getBucket(req.ipBucket.key);

      assert.strictEqual(resourceBucket?.tokens, 95); // 100 - 5
      assert.strictEqual(ipBucket?.tokens, 95); // 100 - 5
    });

    it('should consume minimum 1 token for small responses', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Simulate tiny response (less than 1KB)
      simulateResponse(res, 100);

      await waitForAsync();

      assert.ok(req.resourceBucket?.key);
      assert.ok(req.ipBucket?.key);
      const resourceBucket = mockRedis.getBucket(req.resourceBucket.key);
      const ipBucket = mockRedis.getBucket(req.ipBucket.key);

      // Should consume minimum 1 token
      assert.strictEqual(resourceBucket?.tokens, 99); // 100 - 1
      assert.strictEqual(ipBucket?.tokens, 99); // 100 - 1
    });

    it('should use cached contentLength for precise token consumption', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
      });

      // First request - no cached contentLength, uses prediction
      const req1 = createMockRequest('GET', '/test', '192.168.1.1');
      const res1 = createMockResponse();
      const next1 = createMockNext();
      await middleware(
        req1 as Request,
        res1 as Response,
        next1 as NextFunction,
      );

      // Simulate 50KB response, should consume 1 predicted + 49 additional = 50 total
      simulateResponse(res1, 50 * 1024);
      await waitForAsync();

      // Verify first request consumed 50 tokens total (99 remaining after upfront, then adjusted to 50 remaining)
      const bucketAfterFirst = mockRedis.getBucket(req1.resourceBucket!.key);
      assert.strictEqual(bucketAfterFirst?.tokens, 50);
      assert.strictEqual(bucketAfterFirst?.contentLength, 50 * 1024); // Should be cached

      // Second request - should find cached contentLength and consume 50 tokens upfront
      const req2 = createMockRequest('GET', '/test', '192.168.1.1');
      const res2 = createMockResponse();
      const next2 = createMockNext();
      await middleware(
        req2 as Request,
        res2 as Response,
        next2 as NextFunction,
      );

      // Should have consumed 50 tokens upfront based on cached contentLength
      assert.ok(req2.resourceBucket);
      assert.strictEqual(req2.resourceBucket.tokens, 0); // 50 - 50 = 0

      // Simulate same 50KB response - should need no adjustment since prediction was perfect
      simulateResponse(res2, 50 * 1024);
      await waitForAsync();

      // Verify no additional consumption occurred
      const bucketAfterSecond = mockRedis.getBucket(req2.resourceBucket!.key);
      assert.strictEqual(bucketAfterSecond?.tokens, 0); // Should remain 0, no adjustment needed
    });
  });

  describe('Time-based Refill', () => {
    it('should refill tokens over time correctly', async () => {
      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10, // 10 tokens per second
        ipCapacity: 100,
        ipRefillRate: 10,
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Consume some tokens
      simulateResponse(res, 50 * 1024); // 50KB = 50 tokens
      await waitForAsync();

      // Advance time by 3 seconds
      mockRedis.advanceTime(3000);

      // Make another request
      const req2 = createMockRequest('GET', '/test', '192.168.1.1');
      const res2 = createMockResponse();
      const next2 = createMockNext();

      await middleware(
        req2 as Request,
        res2 as Response,
        next2 as NextFunction,
      );

      // Check refilled tokens (should have refilled 30 tokens, then consumed 50 for second request based on cached contentLength)
      assert.ok(req2.resourceBucket);
      assert.strictEqual(req2.resourceBucket.tokens, 30); // 50 consumed, 30 refilled, 50 consumed for second request (cached contentLength)
    });
  });

  describe('Error Handling', () => {
    it('should handle error in getOrCreateBuckets gracefully', async () => {
      // Mock an error
      const originalGetOrCreate = mockRedis.getOrCreateBucketAndConsume;
      mockRedis.getOrCreateBucketAndConsume = async () => {
        throw new Error('Redis connection failed');
      };

      const middleware = createTestMiddleware({
        resourceCapacity: 100,
        resourceRefillRate: 10,
        ipCapacity: 100,
        ipRefillRate: 10,
        limitsEnabled: false, // Set to false so Redis errors don't block requests
      });

      const req = createMockRequest('GET', '/test', '192.168.1.1');
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next as NextFunction);

      // Should proceed despite error
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual((res as any).getStatus(), 200);

      // Restore original method
      mockRedis.getOrCreateBucketAndConsume = originalGetOrCreate;
    });
  });

  describe('x402 Paid Tier Rate Limiting', () => {
    describe('Capacity Multiplier', () => {
      it('should apply 10x capacity multiplier for paid requests on new bucket', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const expectedCapacity = baseCapacity * 10; // 10x multiplier

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0, // Don't consume any tokens
          true, // x402 payment provided
          10, // capacityMultiplier
          2, // refillMultiplier
        );

        // Should start with 10x tokens
        assert.strictEqual(result.bucket.tokens, expectedCapacity);
        // But base capacity should remain unchanged
        assert.strictEqual(result.bucket.capacity, baseCapacity);
        assert.strictEqual(result.success, true);
      });

      it('should top off existing bucket to 10x capacity when payment provided', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // Create bucket with some tokens consumed
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          50, // Consume 50 tokens
          false, // No payment
        );

        // Make paid request - should top off to 1000 tokens
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true, // x402 payment provided
          10,
          2,
        );

        // Should have topped off to 10x capacity
        assert.strictEqual(result.bucket.tokens, 1000);
        assert.strictEqual(result.bucket.capacity, baseCapacity);
      });

      it('should cap unpaid requests at base capacity after paid request', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // Make paid request - starts with 1000 tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          100, // Consume 100, leaving 900
          true, // x402 payment
          10,
          2,
        );

        // Make unpaid request - should cap at base capacity (100)
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          false, // No payment
        );

        // Should have been capped to base capacity
        assert.strictEqual(result.bucket.tokens, baseCapacity);
      });

      it('should allow consuming up to 10x capacity with payment', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // Create bucket with payment - 1000 tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true, // x402 payment
          10,
          2,
        );

        // Try to consume 500 tokens (more than base, but within paid tier)
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          500,
          true, // Payment provided for this request too
          10,
          2,
        );

        // Should succeed because we have 1000 tokens
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.consumed, 500);
        assert.strictEqual(result.bucket.tokens, 500);
      });

      it('should fail to consume more than 10x capacity even with payment', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // Create bucket with payment - 1000 tokens
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          1500, // Try to consume more than available
          true, // x402 payment
          10,
          2,
        );

        // Should fail - not enough tokens
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.consumed, 0);
        assert.strictEqual(result.bucket.tokens, 1000); // Unchanged
      });
    });

    describe('Refill Multiplier', () => {
      it('should not use refill multiplier (just tops off) when payment provided', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const baseRefillRate = 10;

        // Create bucket with some consumption
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          now,
          60,
          50, // Consume 50
          false,
        );

        // Wait 2 seconds
        const later = now + 2000;

        // Make paid request - should top off to 1000 regardless of time
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          later,
          60,
          0,
          true, // Payment
          10,
          2,
        );

        // Should have topped off to full paid capacity
        assert.strictEqual(result.bucket.tokens, 1000);
      });

      it('should use base refill rate for unpaid requests', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const baseRefillRate = 10; // 10 tokens/second

        // Create bucket and consume most tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          now,
          60,
          90, // Consume 90, leaving 10
          false,
        );

        // Wait 5 seconds
        const later = now + 5000;

        // Make unpaid request - should refill at base rate
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          later,
          60,
          0,
          false, // No payment
        );

        // Should have: 10 remaining + (10 tokens/sec * 5 sec) = 60 tokens
        assert.strictEqual(result.bucket.tokens, 60);
      });
    });

    describe('Payment State Transitions', () => {
      it('should handle paid -> unpaid -> paid transitions correctly', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // 1. Paid request - starts with 1000
        let result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          200,
          true, // Paid
          10,
          2,
        );
        assert.strictEqual(result.bucket.tokens, 800); // 1000 - 200

        // 2. Unpaid request - should cap at 100
        result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 1000,
          60,
          0,
          false, // Unpaid
        );
        assert.strictEqual(result.bucket.tokens, 100); // Capped

        // 3. Paid request - should top off to 1000 again
        result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 2000,
          60,
          0,
          true, // Paid again
          10,
          2,
        );
        assert.strictEqual(result.bucket.tokens, 1000); // Topped off
      });

      it('should handle multiple consecutive paid requests correctly', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // First paid request
        let result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          300,
          true,
          10,
          2,
        );
        assert.strictEqual(result.bucket.tokens, 700); // 1000 - 300

        // Second paid request - should top off to 1000 again
        result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 1000,
          60,
          500,
          true, // Another paid request
          10,
          2,
        );
        assert.strictEqual(result.bucket.tokens, 500); // 1000 - 500

        // Third paid request
        result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 2000,
          60,
          100,
          true,
          10,
          2,
        );
        assert.strictEqual(result.bucket.tokens, 900); // 1000 - 100
      });

      it('should handle multiple consecutive unpaid requests after paid', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        // Paid request - leaves 800 tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          200,
          true,
          10,
          2,
        );

        // First unpaid request - should cap at 100
        let result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 1000,
          60,
          30,
          false,
        );
        assert.strictEqual(result.bucket.tokens, 70); // 100 - 30

        // Second unpaid request - should refill and consume
        // From 70 tokens, wait 1 second (10 tokens/sec refill), then consume 20
        result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now + 2000,
          60,
          20,
          false,
        );
        assert.strictEqual(result.bucket.tokens, 60); // 70 + 10 (refill) - 20
      });
    });

    describe('Custom Multipliers', () => {
      it('should support custom capacity multiplier', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const customMultiplier = 5; // 5x instead of 10x

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true,
          customMultiplier,
          2,
        );

        // Should have 5x capacity
        assert.strictEqual(result.bucket.tokens, 500);
        assert.strictEqual(result.bucket.capacity, baseCapacity);
      });

      it('should support custom refill multiplier', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const baseRefillRate = 10;
        const customRefillMultiplier = 3; // 3x instead of 2x

        // Create bucket and consume tokens
        await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          now,
          60,
          50,
          false,
        );

        // Note: With payment, it just tops off regardless of refill multiplier
        // The refill multiplier would be used in the Lua script for time-based refills
        // but in our mock, paid requests always top off to full capacity
        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          baseRefillRate,
          now + 1000,
          60,
          0,
          true,
          10,
          customRefillMultiplier,
        );

        // Should top off to full paid capacity
        assert.strictEqual(result.bucket.tokens, 1000);
      });

      it('should work with 1x multipliers (effectively disabled)', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true, // Payment provided
          1, // 1x capacity (no boost)
          1, // 1x refill (no boost)
        );

        // Should have base capacity even with payment
        assert.strictEqual(result.bucket.tokens, baseCapacity);
      });
    });

    describe('Edge Cases', () => {
      it('should handle zero capacity correctly', async () => {
        const now = Date.now();

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          0, // Zero base capacity
          10,
          now,
          60,
          0,
          true,
          10,
          2,
        );

        // Should have 0 * 10 = 0 tokens even with payment
        assert.strictEqual(result.bucket.tokens, 0);
      });

      it('should handle very large multipliers', async () => {
        const now = Date.now();
        const baseCapacity = 100;
        const largeMultiplier = 1000;

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true,
          largeMultiplier,
          2,
        );

        // Should have 100 * 1000 = 100,000 tokens
        assert.strictEqual(result.bucket.tokens, 100000);
      });

      it('should handle fractional multipliers', async () => {
        const now = Date.now();
        const baseCapacity = 100;

        const result = await mockRedis.getOrCreateBucketAndConsume(
          'test-key',
          baseCapacity,
          10,
          now,
          60,
          0,
          true,
          2.5, // 2.5x multiplier
          1.5,
        );

        // Should have 100 * 2.5 = 250 tokens
        assert.strictEqual(result.bucket.tokens, 250);
      });
    });
  });
});
