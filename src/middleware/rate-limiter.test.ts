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
  createMockLogger,
  createMockMetrics,
  createMockTracer,
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
      const bucket = await mockRedis.getOrCreateBucket('test-key', 100, 10, now, 60);
      const parsedBucket = JSON.parse(bucket);

      assert.strictEqual(parsedBucket.tokens, 100);
      assert.strictEqual(parsedBucket.capacity, 100);
      assert.strictEqual(parsedBucket.refillRate, 10);
      assert.strictEqual(parsedBucket.lastRefill, now);
    });

    it('should refill tokens over time', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucket('test-key', 100, 10, now, 60);

      // Simulate 5 seconds passing
      const later = now + 5000;
      const bucket = await mockRedis.getOrCreateBucket('test-key', 100, 10, later, 60);
      const parsedBucket = JSON.parse(bucket);

      // Should have refilled 50 tokens (10 per second * 5 seconds)
      assert.strictEqual(parsedBucket.tokens, 100); // Still at capacity
    });

    it('should cap refill at capacity', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucket('test-key', 100, 10, now, 60);
      await mockRedis.consumeTokens('test-key', 30, now, 60);

      // Simulate 10 seconds passing (would refill 100 tokens, but capped at capacity)
      const bucket = await mockRedis.getOrCreateBucket('test-key', 100, 10, now + 10000, 60);
      const parsedBucket = JSON.parse(bucket);
      assert.strictEqual(parsedBucket.tokens, 100);
    });

    it('should consume tokens correctly', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucket('test-key', 100, 10, now, 60);

      const remaining = await mockRedis.consumeTokens('test-key', 25, now, 60);
      assert.strictEqual(remaining, 75);

      const bucket = mockRedis.getBucket('test-key');
      assert.strictEqual(bucket?.tokens, 75);
    });

    it('should allow tokens to go negative', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucket('test-key', 10, 1, now, 60);

      const remaining = await mockRedis.consumeTokens('test-key', 20, now, 60);
      assert.strictEqual(remaining, -10);
    });

    it('should store content length in bucket', async () => {
      const now = Date.now();
      await mockRedis.getOrCreateBucket('test-key', 100, 10, now, 60);

      await mockRedis.consumeTokens('test-key', 10, now, 60, 1024);

      const bucket = mockRedis.getBucket('test-key');
      assert.strictEqual(bucket?.contentLength, 1024);
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

      await middleware(req1 as Request, res1 as Response, next1 as NextFunction);
      await middleware(req2 as Request, res2 as Response, next2 as NextFunction);

      // Different domains should have different resource keys
      assert.notStrictEqual(req1.resourceBucket?.key, req2.resourceBucket?.key);
      // But same IP should have different IP keys for different domains
      assert.notStrictEqual(req1.ipBucket?.key, req2.ipBucket?.key);
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
      mockRedis.setBucket('{rl:example.com}:ip:192.168.1.1', {
        key: '{rl:example.com}:ip:192.168.1.1',
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
      const resourceBucket = mockRedis.getBucket(req.resourceBucket?.key!);
      const ipBucket = mockRedis.getBucket(req.ipBucket?.key!);

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

      const resourceBucket = mockRedis.getBucket(req.resourceBucket?.key!);
      const ipBucket = mockRedis.getBucket(req.ipBucket?.key!);

      // Should consume minimum 1 token
      assert.strictEqual(resourceBucket?.tokens, 99); // 100 - 1
      assert.strictEqual(ipBucket?.tokens, 99); // 100 - 1
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

      await middleware(req2 as Request, res2 as Response, next2 as NextFunction);

      // Check refilled tokens (should have refilled 30 tokens)
      assert.ok(req2.resourceBucket);
      assert.strictEqual(req2.resourceBucket.tokens, 80); // 50 consumed, 30 refilled
    });
  });

  describe('Error Handling', () => {
    it('should handle error in getOrCreateBuckets gracefully', async () => {
      // Mock an error
      const originalGetOrCreate = mockRedis.getOrCreateBucket;
      mockRedis.getOrCreateBucket = async () => {
        throw new Error('Redis connection failed');
      };

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

      // Should proceed despite error
      assert.strictEqual((next as any).mock.calls.length, 1);
      assert.strictEqual((res as any).getStatus(), 200);

      // Restore original method
      mockRedis.getOrCreateBucket = originalGetOrCreate;
    });
  });
});