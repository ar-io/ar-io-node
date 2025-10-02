/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Test to verify the TokenBucket API from the 'limiter' package.
 * This confirms which properties and methods are available on TokenBucket.
 *
 * IMPORTANT FINDINGS:
 * - TokenBucket.content exists and is the correct way to check tokens
 * - TokenBucket does NOT have getTokensRemaining() (only RateLimiter has that)
 * - content starts at 0 and fills based on TIME, not instantaneously
 * - Checking content before the first removeTokens() will show 0 (harmless bug in our code)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TokenBucket } from 'limiter';

describe('TokenBucket API Verification', () => {
  it('should have a "content" property that starts at 0', () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 5,
      interval: 'second',
    });

    // Verify content property exists and is a number
    assert.strictEqual(typeof bucket.content, 'number');

    // content starts at 0 - it fills based on elapsed time
    assert.strictEqual(bucket.content, 0);
  });

  it('should NOT have a "getTokensRemaining" method', () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 5,
      interval: 'second',
    });

    // Verify getTokensRemaining does NOT exist on TokenBucket
    // (it only exists on RateLimiter, not TokenBucket)
    assert.strictEqual(typeof (bucket as any).getTokensRemaining, 'undefined');
  });

  it('should have a "removeTokens" method that works correctly', async () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 10,
      interval: 'second',
    });

    assert.strictEqual(typeof bucket.removeTokens, 'function');

    // removeTokens calls drip() internally
    // Since no time has passed, it will wait for tokens to become available
    // For this test, we wait a bit first
    await new Promise((resolve) => setTimeout(resolve, 100));

    const remaining = await bucket.removeTokens(3);
    // After 100ms with 10 tokens/sec, we should have ~1 token
    // removeTokens will wait for the rest
    assert(typeof remaining === 'number');
    assert(bucket.content >= 0);
  });

  it('should have a "tryRemoveTokens" method', async () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 10,
      interval: 'second',
    });

    assert.strictEqual(typeof bucket.tryRemoveTokens, 'function');

    // tryRemoveTokens returns false if not enough tokens
    const success1 = bucket.tryRemoveTokens(1);
    assert.strictEqual(success1, false); // No tokens yet (no time passed)

    // Wait for tokens to accumulate
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const success2 = bucket.tryRemoveTokens(3);
    assert.strictEqual(success2, true); // Should have 10 tokens now
    assert.strictEqual(bucket.content, 7);
  });

  it('demonstrates the pattern used in turbo-root-tx-index.ts', async () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 10,
      interval: 'second',
    });

    // This is the actual pattern from turbo-root-tx-index.ts:
    //
    // if (this.limiter.content < 1) {
    //   log.debug('Rate limiting Turbo request - waiting for tokens', {
    //     id,
    //     tokensAvailable: this.limiter.content,
    //   });
    // }
    // await this.limiter.removeTokens(1);

    // On first call, content will be 0
    assert.strictEqual(bucket.content, 0);

    // The check will trigger (harmless - just logs)
    if (bucket.content < 1) {
      // This will execute even though removeTokens will work fine
      assert.strictEqual(bucket.content, 0);
    }

    // removeTokens still works correctly (waits for token if needed)
    await bucket.removeTokens(1);

    // After first removeTokens, content is updated and future checks work
    assert(bucket.content >= 0);
  });

  it('content property reflects tokens after removeTokens is called', async () => {
    const bucket = new TokenBucket({
      bucketSize: 10,
      tokensPerInterval: 10,
      interval: 'second',
    });

    // Wait for tokens to accumulate
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await bucket.removeTokens(2);
    assert.strictEqual(bucket.content, 8);

    await bucket.removeTokens(3);
    assert.strictEqual(bucket.content, 5);
  });
});
