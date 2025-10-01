/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { CompositeTxOffsetSource } from './composite-tx-offset-source.js';
import { TxOffsetSource, TxOffsetResult } from '../types.js';
import log from '../log.js';

describe('CompositeTxOffsetSource', () => {
  let compositeTxOffsetSource: CompositeTxOffsetSource;
  let mockPrimarySource: TxOffsetSource;
  let mockFallbackSource: TxOffsetSource;

  const validResult: TxOffsetResult = {
    data_root: 'abc123',
    id: 'tx123',
    offset: 1000,
    data_size: 256,
  };

  const invalidResult: TxOffsetResult = {
    data_root: undefined,
    id: undefined,
    offset: undefined,
    data_size: undefined,
  };

  beforeEach(() => {
    mockPrimarySource = {
      getTxByOffset: mock.fn(() => Promise.resolve(validResult)),
    };

    mockFallbackSource = {
      getTxByOffset: mock.fn(() => Promise.resolve(validResult)),
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('when fallback is enabled', () => {
    beforeEach(() => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: mockFallbackSource,
        fallbackEnabled: true,
      });
    });

    it('should return primary source result when valid', async () => {
      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, validResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        0,
      );
    });

    it('should use fallback when primary returns invalid result', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, validResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        1,
      );
    });

    it('should use fallback when primary returns partial invalid result', async () => {
      const partialInvalidResult = {
        data_root: 'abc123',
        id: undefined, // Missing id makes it invalid
        offset: 1000,
        data_size: 256,
      };
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(partialInvalidResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, validResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        1,
      );
    });

    it('should return fallback result even if invalid when primary is also invalid', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );
      mockFallbackSource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, invalidResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        1,
      );
    });

    it('should propagate primary source errors when no fallback available', async () => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: undefined,
        fallbackEnabled: true,
      });

      const testError = new Error('Primary source failed');
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.reject(testError),
      );

      await assert.rejects(
        () => compositeTxOffsetSource.getTxByOffset(1000),
        testError,
      );
    });
  });

  describe('when fallback is disabled', () => {
    beforeEach(() => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: mockFallbackSource,
        fallbackEnabled: false,
      });
    });

    it('should not use fallback even when primary returns invalid result', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, invalidResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        0,
      );
    });
  });

  describe('when no fallback source provided', () => {
    beforeEach(() => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: undefined,
        fallbackEnabled: true,
      });
    });

    it('should return primary result even if invalid when no fallback available', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      assert.deepStrictEqual(result, invalidResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
    });
  });

  describe('concurrency limit', () => {
    beforeEach(() => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: mockFallbackSource,
        fallbackEnabled: true,
        fallbackConcurrencyLimit: 2, // Set a low limit for testing
      });
    });

    it('should skip fallback when concurrency limit is reached', async () => {
      // Set up primary to always return invalid results
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      // Set up fallback to take some time to complete
      let fallbackResolve1: any;
      let fallbackResolve2: any;
      const fallbackPromise1 = new Promise<TxOffsetResult>((resolve) => {
        fallbackResolve1 = resolve;
      });
      const fallbackPromise2 = new Promise<TxOffsetResult>((resolve) => {
        fallbackResolve2 = resolve;
      });

      const fallbackCalls: number[] = [];
      mockFallbackSource.getTxByOffset = mock.fn((offset: number) => {
        fallbackCalls.push(offset);
        if (fallbackCalls.length === 1) return fallbackPromise1;
        if (fallbackCalls.length === 2) return fallbackPromise2;
        // Third call should not happen due to limit
        return Promise.resolve(validResult);
      });

      // Start 3 concurrent requests
      const promise1 = compositeTxOffsetSource.getTxByOffset(1001);
      const promise2 = compositeTxOffsetSource.getTxByOffset(1002);
      const promise3 = compositeTxOffsetSource.getTxByOffset(1003);

      // Wait a bit to ensure all requests have started
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify that only 2 fallback requests were made (limit is 2)
      assert.strictEqual(fallbackCalls.length, 2);

      // The third request should return the invalid primary result immediately
      const result3 = await promise3;
      assert.deepStrictEqual(result3, invalidResult);

      // Complete the first two fallback requests
      fallbackResolve1(validResult);
      fallbackResolve2(validResult);

      const result1 = await promise1;
      const result2 = await promise2;
      assert.deepStrictEqual(result1, validResult);
      assert.deepStrictEqual(result2, validResult);

      // Verify primary was called 3 times, fallback only 2 times
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        3,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        2,
      );
    });

    it('should allow new fallback requests after previous ones complete', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );
      mockFallbackSource.getTxByOffset = mock.fn(() =>
        Promise.resolve(validResult),
      );

      // Make requests up to the limit
      const result1 = await compositeTxOffsetSource.getTxByOffset(1001);
      const result2 = await compositeTxOffsetSource.getTxByOffset(1002);

      // After completion, new requests should be allowed
      const result3 = await compositeTxOffsetSource.getTxByOffset(1003);

      assert.deepStrictEqual(result1, validResult);
      assert.deepStrictEqual(result2, validResult);
      assert.deepStrictEqual(result3, validResult);

      // All three should have used fallback
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        3,
      );
    });

    it('should respect concurrency limit of 0', async () => {
      compositeTxOffsetSource = new CompositeTxOffsetSource({
        log,
        primarySource: mockPrimarySource,
        fallbackSource: mockFallbackSource,
        fallbackEnabled: true,
        fallbackConcurrencyLimit: 0, // No fallbacks allowed
      });

      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );
      mockFallbackSource.getTxByOffset = mock.fn(() =>
        Promise.resolve(validResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1000);

      // Should return primary result without using fallback
      assert.deepStrictEqual(result, invalidResult);
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        1,
      );
      assert.strictEqual(
        (mockFallbackSource.getTxByOffset as any).mock.callCount(),
        0,
      );
    });

    it('should handle fallback errors correctly with concurrency tracking', async () => {
      mockPrimarySource.getTxByOffset = mock.fn(() =>
        Promise.resolve(invalidResult),
      );

      const testError = new Error('Fallback failed');
      mockFallbackSource.getTxByOffset = mock.fn(() =>
        Promise.reject(testError),
      );

      // First request should throw the error but still decrement the counter
      await assert.rejects(
        () => compositeTxOffsetSource.getTxByOffset(1000),
        testError,
      );

      // Second request should still be able to use fallback (counter was decremented)
      mockFallbackSource.getTxByOffset = mock.fn(() =>
        Promise.resolve(validResult),
      );

      const result = await compositeTxOffsetSource.getTxByOffset(1001);
      assert.deepStrictEqual(result, validResult);

      // Verify both fallback calls were made
      assert.strictEqual(
        (mockPrimarySource.getTxByOffset as any).mock.callCount(),
        2,
      );
    });
  });
});
