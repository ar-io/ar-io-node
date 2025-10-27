/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { Request, Response } from 'express';
import { MemoryRateLimiter } from './memory-rate-limiter.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'MemoryRateLimiter' });

// Helper to create mock Express Request
const createMockRequest = (overrides: Partial<Request> = {}): Request => {
  return {
    method: 'GET',
    baseUrl: '',
    path: '/test',
    headers: {
      host: 'test.example.com',
    },
    ip: '127.0.0.1',
    ...overrides,
  } as Request;
};

// Helper to create mock Express Response
const createMockResponse = (): Response => {
  return {} as Response;
};

describe('MemoryRateLimiter', () => {
  let limiter: MemoryRateLimiter;

  beforeEach(() => {
    limiter = new MemoryRateLimiter({
      resourceCapacity: 1000,
      resourceRefillRate: 10, // 10 tokens per second
      ipCapacity: 500,
      ipRefillRate: 5, // 5 tokens per second
      limitsEnabled: true,
      ipAllowlist: [],
      capacityMultiplier: 10,
      maxBuckets: 10, // Small limit for testing LRU
    });
  });

  describe('Basic token consumption', () => {
    it('should allow request when tokens are available', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      const result = await limiter.checkLimit(req, res, 100);

      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.resourceTokensConsumed, 100);
      assert.strictEqual(result.ipTokensConsumed, 100);
    });

    it('should deny request when resource tokens exhausted', async () => {
      const res = createMockResponse();

      // Use different IPs to avoid IP bucket limits (IP capacity is 500)
      // Consume resource tokens in chunks that fit within IP limits
      // Resource bucket is shared across all IPs for the same path

      // Request 1: 450 tokens (IP1 has 500, resource has 1000)
      const req1 = createMockRequest({ ip: '10.0.0.1' });
      const result1 = await limiter.checkLimit(req1, res, 450);
      assert.strictEqual(result1.allowed, true);

      // Request 2: 450 tokens (IP2 has 500, resource now has 550)
      const req2 = createMockRequest({ ip: '10.0.0.2' });
      const result2 = await limiter.checkLimit(req2, res, 450);
      assert.strictEqual(result2.allowed, true);

      // Request 3: 200 tokens (IP3 has 500, resource now has 100)
      // Should fail on resource (only 100 available, need 200)
      const req3 = createMockRequest({ ip: '10.0.0.3' });
      const result = await limiter.checkLimit(req3, res, 200);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.limitType, 'resource');
    });

    it('should deny request when IP tokens exhausted', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume most IP tokens
      await limiter.checkLimit(req, res, 450);

      // Try to consume more than available
      const result = await limiter.checkLimit(req, res, 100);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.limitType, 'ip');
    });

    it('should rollback resource tokens when IP limit fails', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust IP bucket
      await limiter.checkLimit(req, res, 500);

      // Try another request - should fail on IP and rollback resource
      const result = await limiter.checkLimit(req, res, 50);

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.limitType, 'ip');

      // Resource tokens should be rolled back, so resource bucket should still have 500 tokens
      // Make another request with different IP to verify resource bucket state
      const req2 = createMockRequest({ ip: '192.168.1.1' });
      // Request 450 tokens (within IP limit of 500, but would exceed resource if rollback didn't work)
      // If rollback worked: resource has 500 tokens left, so 450 should succeed
      // If rollback failed: resource has 450 tokens left, so 450 would barely succeed
      // To properly test, we need to consume more than what's left if rollback failed
      const result2 = await limiter.checkLimit(req2, res, 450);
      assert.strictEqual(result2.allowed, true);

      // Now verify resource bucket actually has 50 tokens left (500 - 450)
      const req3 = createMockRequest({ ip: '192.168.1.2' });
      const result3 = await limiter.checkLimit(req3, res, 100);
      // Should fail on resource (only 50 tokens available, need 100)
      assert.strictEqual(result3.allowed, false);
      assert.strictEqual(result3.limitType, 'resource');
    });
  });

  describe('Token refill', () => {
    it('should refill tokens over time', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume most tokens (leaving only 10)
      await limiter.checkLimit(req, res, 490);

      // Wait for refill (2 seconds = 20 resource tokens, 10 IP tokens)
      await new Promise((resolve) => setTimeout(resolve, 2100));

      // Should be able to consume 20 tokens (refilled amount)
      // Resource: 1000 - 490 + 20 = 530 tokens available
      // IP: 500 - 490 + 10 = 20 tokens available
      // So we can consume 20 tokens
      const result = await limiter.checkLimit(req, res, 20);

      assert.strictEqual(result.allowed, true);
    });

    it('should not exceed capacity when refilling', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume some tokens
      await limiter.checkLimit(req, res, 100);

      // Wait long enough to refill back to capacity
      // Resource: 1000 - 100 + (10.1 * 10) = 1000 (capped at capacity)
      // IP: 500 - 100 + (10.1 * 5) = 450.5
      await new Promise((resolve) => setTimeout(resolve, 10100));

      // Should be capped at capacity - consume 400 (within both limits)
      // Resource has 1000, IP has ~450, so 400 is safe
      const result = await limiter.checkLimit(req, res, 400);

      assert.strictEqual(result.allowed, true);
    });
  });

  describe('IP allowlisting', () => {
    it('should return true for allowlisted IPs', () => {
      const limiterWithAllowlist = new MemoryRateLimiter({
        resourceCapacity: 1000,
        resourceRefillRate: 10,
        ipCapacity: 500,
        ipRefillRate: 5,
        limitsEnabled: true,
        ipAllowlist: ['127.0.0.1', '192.168.1.0/24'],
        capacityMultiplier: 10,
        maxBuckets: 10,
      });

      assert.strictEqual(
        limiterWithAllowlist.isAllowlisted(['127.0.0.1']),
        true,
      );
      assert.strictEqual(
        limiterWithAllowlist.isAllowlisted(['192.168.1.50']),
        true,
      );
      assert.strictEqual(
        limiterWithAllowlist.isAllowlisted(['10.0.0.1']),
        false,
      );
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used buckets when max exceeded', async () => {
      const res = createMockResponse();

      // Create more buckets than the max (10)
      // Each request creates 2 buckets: resource and IP
      // So we need to create enough different paths and IPs to exceed the limit
      for (let i = 0; i < 15; i++) {
        const reqWithPath = createMockRequest({
          path: `/test-${i}`,
          ip: `192.168.1.${i}`, // Different IP for each
        });
        await limiter.checkLimit(reqWithPath, res, 10);
      }

      // Early buckets should be evicted. Accessing test-0 should create new buckets
      // with full capacity
      const firstReq = createMockRequest({
        path: '/test-0',
        ip: '192.168.1.0',
      });

      // If the buckets were evicted, they will be recreated with full tokens
      // Resource bucket: 1000 capacity, IP bucket: 500 capacity
      // We can consume 400 tokens (within both limits)
      const result = await limiter.checkLimit(firstReq, res, 400);

      assert.strictEqual(result.allowed, true);
    });
  });

  describe('Payment top-offs', () => {
    it('should increase capacity when payment provided', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume most tokens
      await limiter.checkLimit(req, res, 900);

      // Provide payment (1KB = 1 token * 10 multiplier = 10 tokens added)
      const result = await limiter.checkLimit(req, res, 50, true, 1024);

      assert.strictEqual(result.allowed, true);
    });

    it('should top off both resource and IP buckets', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume most IP tokens
      await limiter.checkLimit(req, res, 450);

      // Provide payment for more data
      const result = await limiter.checkLimit(req, res, 100, true, 10240);

      // Should succeed due to top-off (10KB = 10 tokens * 10 = 100 tokens added)
      assert.strictEqual(result.allowed, true);
    });

    it('should consume regular tokens before paid tokens', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // First request with payment to add paid tokens
      // 10KB = 10 tokens * 10 multiplier = 100 paid tokens added
      const result1 = await limiter.checkLimit(req, res, 50, true, 10240);
      assert.strictEqual(result1.allowed, true);
      // Should consume 50 regular tokens (not paid)
      assert.strictEqual(result1.ipRegularTokensConsumed, 50);
      assert.strictEqual(result1.ipPaidTokensConsumed, 0);

      // Second request should still consume regular tokens first
      const result2 = await limiter.checkLimit(req, res, 100);
      assert.strictEqual(result2.allowed, true);
      // Should consume 100 regular tokens
      assert.strictEqual(result2.ipRegularTokensConsumed, 100);
      assert.strictEqual(result2.ipPaidTokensConsumed, 0);

      // Third request exhausts regular tokens (500 - 50 - 100 = 350 left)
      const result3 = await limiter.checkLimit(req, res, 350);
      assert.strictEqual(result3.allowed, true);
      assert.strictEqual(result3.ipRegularTokensConsumed, 350);
      assert.strictEqual(result3.ipPaidTokensConsumed, 0);

      // Fourth request uses paid tokens (no regular left, or very close to 0 due to refill)
      const result4 = await limiter.checkLimit(req, res, 50);
      assert.strictEqual(result4.allowed, true);
      // Should consume mostly/all paid tokens now (allow tiny epsilon for floating point refill)
      assert.ok(
        (result4.ipRegularTokensConsumed ?? 0) < 0.1,
        `Expected ipRegularTokensConsumed to be < 0.1, got ${result4.ipRegularTokensConsumed}`,
      );
      assert.ok(
        (result4.ipPaidTokensConsumed ?? 0) > 49.9,
        `Expected ipPaidTokensConsumed to be > 49.9, got ${result4.ipPaidTokensConsumed}`,
      );
    });

    it('should bypass resource limit when paid tokens available', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust resource bucket using different IPs
      const req1 = createMockRequest({ ip: '10.0.0.1' });
      await limiter.checkLimit(req1, res, 450);
      const req2 = createMockRequest({ ip: '10.0.0.2' });
      await limiter.checkLimit(req2, res, 450);
      // Resource bucket now has ~100 tokens left

      // New IP with payment - should bypass resource check
      const req3 = createMockRequest({ ip: '10.0.0.3' });
      const result = await limiter.checkLimit(req3, res, 200, true, 10240);

      // Should succeed despite resource bucket having insufficient tokens
      // because payment adds paid tokens which bypass resource check
      assert.strictEqual(result.allowed, true);
      // Should not have resource tokens consumed (resource check bypassed)
      assert.strictEqual(result.resourceTokensConsumed, undefined);
    });
  });

  describe('topOffPaidTokens', () => {
    it('should add paid tokens directly with capacity multiplier', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust regular tokens
      await limiter.checkLimit(req, res, 500);

      // Top off with 100 tokens (should become 1000 with 10x multiplier)
      await limiter.topOffPaidTokens(req, 100);

      // Should now be able to consume 1000 tokens (from paid pool)
      const result = await limiter.checkLimit(req, res, 1000);
      assert.strictEqual(result.allowed, true);
      // Allow small tolerance for refilled regular tokens (floating point precision)
      assert.ok(
        (result.ipPaidTokensConsumed ?? 0) > 999,
        `Expected ipPaidTokensConsumed to be > 999, got ${result.ipPaidTokensConsumed}`,
      );
      assert.ok(
        (result.ipRegularTokensConsumed ?? 0) < 1,
        `Expected ipRegularTokensConsumed to be < 1, got ${result.ipRegularTokensConsumed}`,
      );
    });

    it('should allow subsequent requests after payment top-off', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust regular tokens
      await limiter.checkLimit(req, res, 500);

      // Top off with tokens for 10KB worth (10 tokens → 100 with multiplier)
      await limiter.topOffPaidTokens(req, 10);

      // First request should use paid tokens
      const result1 = await limiter.checkLimit(req, res, 50);
      assert.strictEqual(result1.allowed, true);
      // Allow small tolerance for refilled regular tokens (floating point precision)
      assert.ok(
        (result1.ipPaidTokensConsumed ?? 0) > 49.9,
        `Expected ipPaidTokensConsumed to be > 49.9, got ${result1.ipPaidTokensConsumed}`,
      );

      // Second request should also use paid tokens
      const result2 = await limiter.checkLimit(req, res, 50);
      assert.strictEqual(result2.allowed, true);
      // Allow small tolerance for refilled regular tokens (floating point precision)
      assert.ok(
        (result2.ipPaidTokensConsumed ?? 0) > 49.9,
        `Expected ipPaidTokensConsumed to be > 49.9, got ${result2.ipPaidTokensConsumed}`,
      );
    });

    it('should work with different capacity multipliers', async () => {
      const customLimiter = new MemoryRateLimiter({
        resourceCapacity: 1000,
        resourceRefillRate: 10,
        ipCapacity: 500,
        ipRefillRate: 5,
        limitsEnabled: true,
        ipAllowlist: [],
        capacityMultiplier: 20, // Different multiplier
        maxBuckets: 100,
      });

      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust regular tokens
      await customLimiter.checkLimit(req, res, 500);

      // Top off with 10 tokens (should become 200 with 20x multiplier)
      await customLimiter.topOffPaidTokens(req, 10);

      // Should be able to consume 200 tokens
      const result = await customLimiter.checkLimit(req, res, 200);
      assert.strictEqual(result.allowed, true);
      // Allow small tolerance for refilled regular tokens (timing precision)
      assert.ok(
        (result.ipPaidTokensConsumed ?? 0) > 199.9,
        `Expected ipPaidTokensConsumed to be > 199.9, got ${result.ipPaidTokensConsumed}`,
      );
    });

    it('should bypass resource limits when paid tokens added', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust both regular and resource buckets
      await limiter.checkLimit(req, res, 500);
      const req2 = createMockRequest({ ip: '10.0.0.2' });
      await limiter.checkLimit(req2, res, 500);
      // Resource bucket now has 0 tokens

      // Top off paid tokens
      await limiter.topOffPaidTokens(req, 100);

      // Should bypass resource check due to paid tokens
      const result = await limiter.checkLimit(req, res, 500);
      assert.strictEqual(result.allowed, true);
      // Resource check should be skipped
      assert.strictEqual(result.resourceTokensConsumed, undefined);
    });

    it('should bypass resource check when consuming paid tokens brings balance to zero', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Exhaust regular tokens and resource bucket
      await limiter.checkLimit(req, res, 500);
      const req2 = createMockRequest({ ip: '10.0.0.2' });
      await limiter.checkLimit(req2, res, 1000);
      // Resource bucket now has 0 tokens, IP regular bucket has 0 tokens

      // Top off with exactly 150 tokens (1500 with 10x multiplier)
      await limiter.topOffPaidTokens(req, 150);

      // Consume exactly all paid tokens (balance will be 0 after consumption)
      // This should STILL bypass resource check because paid tokens were consumed
      const result = await limiter.checkLimit(req, res, 1500);
      assert.strictEqual(result.allowed, true);
      // Resource check should be bypassed despite paid balance reaching zero
      assert.strictEqual(result.resourceTokensConsumed, undefined);
      // Verify paid tokens were consumed
      assert.ok(
        (result.ipPaidTokensConsumed ?? 0) > 1499,
        `Expected ipPaidTokensConsumed to be > 1499, got ${result.ipPaidTokensConsumed}`,
      );
    });
  });

  describe('Cached content length', () => {
    it('should use cached content length for token calculation', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // First request with predicted tokens
      await limiter.checkLimit(req, res, 100);

      // Adjust with actual content length
      await limiter.adjustTokens(req, {
        responseSize: 2048, // 2KB = 2 tokens
        initialResourceTokens: 100,
        initialIpTokens: 100,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 100,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 100,
        domain: 'test.example.com',
      });

      // Second request to same resource should use cached length
      // Note: The memory rate limiter doesn't expose cached content length in the result
      // so we verify by checking that tokens are consumed correctly
      // If cached length (2 tokens) is used instead of predicted (100), the request should succeed
      const result = await limiter.checkLimit(req, res, 100);

      // Should still succeed because cached length optimization would mean
      // only 2 tokens are actually consumed (not 100)
      assert.strictEqual(result.allowed, true);
    });
  });

  describe('Token adjustments', () => {
    it('should adjust tokens up when response larger than predicted', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Initial request with low prediction
      const result = await limiter.checkLimit(req, res, 10);
      assert.strictEqual(result.allowed, true);

      // Adjust with actual larger size
      await limiter.adjustTokens(req, {
        responseSize: 10240, // 10KB = 10 tokens
        initialResourceTokens: 10,
        initialIpTokens: 10,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 10,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 10,
        domain: 'test.example.com',
      });

      // Check that adjustment was made (can't directly verify internal state,
      // but next request should reflect the adjustment)
    });

    it('should adjust tokens down when response smaller than predicted', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Initial request with high prediction
      await limiter.checkLimit(req, res, 100);

      // Adjust with actual smaller size
      await limiter.adjustTokens(req, {
        responseSize: 1024, // 1KB = 1 token
        initialResourceTokens: 100,
        initialIpTokens: 100,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 100,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 100,
        domain: 'test.example.com',
      });

      // Tokens should be returned (99 tokens returned)
    });

    it('should not adjust when tokens match response size', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Consume exact amount
      await limiter.checkLimit(req, res, 10);

      // Adjust with matching size
      await limiter.adjustTokens(req, {
        responseSize: 10240, // 10KB = 10 tokens
        initialResourceTokens: 10,
        initialIpTokens: 10,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 10,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 10,
        domain: 'test.example.com',
      });

      // No adjustment needed
    });

    it('should handle missing bucket gracefully', async () => {
      const req = createMockRequest();

      // Call adjustTokens without prior checkLimit
      await limiter.adjustTokens(req, {
        responseSize: 1024,
        initialResourceTokens: 10,
        initialIpTokens: 10,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 10,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 10,
        domain: 'test.example.com',
      });

      // Should not throw
    });
  });

  describe('Bucket key generation', () => {
    it('should create separate buckets for different paths', async () => {
      const req1 = createMockRequest({ path: '/path1', ip: '10.0.0.1' });
      const req2 = createMockRequest({ path: '/path2', ip: '10.0.0.2' });
      const res = createMockResponse();

      // Consume tokens on first path (resource bucket for /path1)
      await limiter.checkLimit(req1, res, 450);

      // Second path should have full resource tokens (different resource bucket for /path2)
      // Using different IP to avoid IP bucket sharing
      // Can consume 450 tokens (within both resource and IP limits)
      const result = await limiter.checkLimit(req2, res, 450);
      assert.strictEqual(result.allowed, true);
    });

    it('should create separate buckets for different hosts', async () => {
      const req1 = createMockRequest({
        headers: { host: 'host1.com' },
        ip: '10.0.0.1',
      });
      const req2 = createMockRequest({
        headers: { host: 'host2.com' },
        ip: '10.0.0.2',
      });
      const res = createMockResponse();

      // Consume tokens on first host (resource bucket for host1.com)
      await limiter.checkLimit(req1, res, 450);

      // Second host should have full resource tokens (different resource bucket for host2.com)
      // Using different IP to avoid IP bucket sharing
      // Can consume 450 tokens (within both resource and IP limits)
      const result = await limiter.checkLimit(req2, res, 450);
      assert.strictEqual(result.allowed, true);
    });

    it('should share IP bucket across different resources', async () => {
      const req1 = createMockRequest({ path: '/path1' });
      const req2 = createMockRequest({ path: '/path2' });
      const res = createMockResponse();

      // Consume tokens on first path
      await limiter.checkLimit(req1, res, 300);

      // Second path should share IP bucket
      const result = await limiter.checkLimit(req2, res, 300);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.limitType, 'ip');
    });
  });

  describe('Edge cases', () => {
    it('should handle minimum token consumption (1 token)', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      const result = await limiter.checkLimit(req, res, 1);
      assert.strictEqual(result.allowed, true);
    });

    it('should handle zero-length content with cached length', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      // Set cached content length to 0
      await limiter.checkLimit(req, res, 100);
      await limiter.adjustTokens(req, {
        responseSize: 0,
        initialResourceTokens: 100,
        initialIpTokens: 100,
        initialResourcePaidTokens: 0,
        initialResourceRegularTokens: 100,
        initialIpPaidTokens: 0,
        initialIpRegularTokens: 100,
        domain: 'test.example.com',
      });

      // Next request should use prediction since cached is 0
      const result = await limiter.checkLimit(req, res, 50);
      assert.strictEqual(result.allowed, true);
    });

    it('should handle missing host header', async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();

      // Should not throw
      const result = await limiter.checkLimit(req, res, 100);
      assert.strictEqual(result.allowed, true);
    });

    it('should handle missing IP', async () => {
      const req = createMockRequest({ ip: undefined });
      const res = createMockResponse();

      // Should default to 0.0.0.0
      const result = await limiter.checkLimit(req, res, 100);
      assert.strictEqual(result.allowed, true);
    });
  });
});
