/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Test to verify TokenBucket rate limiting behavior.
 * This confirms that rate limiting actually works as expected.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TokenBucket } from 'limiter';

describe('TokenBucket Behavior', () => {
  it('should delay requests when tokens are exhausted', async () => {
    const bucket = new TokenBucket({
      bucketSize: 2, // Can burst 2 tokens
      tokensPerInterval: 1, // Refills 1 token per second
      interval: 'second',
    });

    // First two requests should be immediate
    const start = Date.now();

    await bucket.removeTokens(1);
    const time1 = Date.now() - start;
    assert(time1 < 100, `First request should be immediate, took ${time1}ms`);
    assert.strictEqual(bucket.content, 1);

    await bucket.removeTokens(1);
    const time2 = Date.now() - start;
    assert(time2 < 100, `Second request should be immediate, took ${time2}ms`);
    assert.strictEqual(bucket.content, 0);

    // Third request should wait for refill (~1 second)
    await bucket.removeTokens(1);
    const time3 = Date.now() - start;
    assert(
      time3 >= 900,
      `Third request should wait ~1 second, took ${time3}ms`,
    );
    assert(
      time3 < 1200,
      `Third request should not wait much more than 1 second, took ${time3}ms`,
    );
  });

  it('should refill tokens over time', async () => {
    const bucket = new TokenBucket({
      bucketSize: 5,
      tokensPerInterval: 2, // 2 tokens per second
      interval: 'second',
    });

    // Use all tokens
    await bucket.removeTokens(5);
    assert.strictEqual(bucket.content, 0);

    // Wait for 1 second - should get 2 tokens back
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Manually trigger drip to update content
    bucket.drip();

    assert(
      bucket.content >= 2,
      `Should have at least 2 tokens after 1 second, has ${bucket.content}`,
    );
    assert(
      bucket.content <= 3,
      `Should have at most 3 tokens after 1 second, has ${bucket.content}`,
    );
  });

  it('content property accurately reflects available tokens', async () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 5,
      interval: 'second',
    });

    // Check initial content
    assert.strictEqual(bucket.content, 10);

    // Remove tokens and check content updates
    const operations = [
      { remove: 2, expectedAfter: 8 },
      { remove: 3, expectedAfter: 5 },
      { remove: 1, expectedAfter: 4 },
    ];

    for (const op of operations) {
      await bucket.removeTokens(op.remove);
      assert.strictEqual(
        bucket.content,
        op.expectedAfter,
        `After removing ${op.remove} tokens, content should be ${op.expectedAfter}`,
      );
    }
  });

  it('should respect bucket size limit when refilling', async () => {
    const bucket = new TokenBucket({
      bucketSize: 3, // Max 3 tokens
      tokensPerInterval: 10, // Tries to add 10 per second (but limited by bucketSize)
      interval: 'second',
    });

    // Use some tokens
    await bucket.removeTokens(2);
    assert.strictEqual(bucket.content, 1);

    // Wait for refill
    await new Promise((resolve) => setTimeout(resolve, 1100));
    bucket.drip();

    // Should be capped at bucketSize (3), not 11
    assert(
      bucket.content <= 3,
      `Content should be capped at bucketSize (3), got ${bucket.content}`,
    );
  });

  it('should work correctly with tryRemoveTokens for non-blocking checks', () => {
    const bucket = new TokenBucket({
      bucketSize: 5,
      tokensPerInterval: 5,
      interval: 'second',
    });

    // Should succeed - enough tokens
    let success = bucket.tryRemoveTokens(3);
    assert.strictEqual(success, true);
    assert.strictEqual(bucket.content, 2);

    // Should succeed - exactly enough tokens
    success = bucket.tryRemoveTokens(2);
    assert.strictEqual(success, true);
    assert.strictEqual(bucket.content, 0);

    // Should fail - not enough tokens
    success = bucket.tryRemoveTokens(1);
    assert.strictEqual(success, false);
    assert.strictEqual(bucket.content, 0); // Content unchanged on failure
  });

  it('demonstrates the pattern used in turbo-root-tx-index', async () => {
    const bucket = new TokenBucket({
      bucketSize: 2,
      tokensPerInterval: 1,
      interval: 'second',
    });

    // Simulate the pattern from turbo-root-tx-index.ts
    const makeRequest = async (id: string) => {
      const start = Date.now();

      // Check if we need to wait (this is the check that uses .content)
      if (bucket.content < 1) {
        console.log(`Would log: Rate limiting request for ${id}`);
      }

      // This will wait if no tokens available
      await bucket.removeTokens(1);

      const duration = Date.now() - start;
      return { id, duration, tokensRemaining: bucket.content };
    };

    // First request - immediate
    const result1 = await makeRequest('req1');
    assert(result1.duration < 100, 'First request should be immediate');
    assert.strictEqual(result1.tokensRemaining, 1);

    // Second request - immediate
    const result2 = await makeRequest('req2');
    assert(result2.duration < 100, 'Second request should be immediate');
    assert.strictEqual(result2.tokensRemaining, 0);

    // Third request - should wait for token refill
    const result3 = await makeRequest('req3');
    assert(
      result3.duration >= 900,
      `Third request should wait ~1s, took ${result3.duration}ms`,
    );
  });
});
