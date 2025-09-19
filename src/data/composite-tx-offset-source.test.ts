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
});
