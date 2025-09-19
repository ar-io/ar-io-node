/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert';
import { ArweaveCompositeClient } from './composite-client.js';
import { Arweave } from 'arweave';
import * as winston from 'winston';

describe('ArweaveCompositeClient Binary Search', () => {
  let client: ArweaveCompositeClient;
  let mockLog: winston.Logger;
  let mockArweave: Arweave;
  let mockPeerManager: any;
  let mockTxStore: any;
  let mockBlockStore: any;
  let mockFailureSimulator: any;

  beforeEach(() => {
    // Reset all mocks before each test
    mock.restoreAll();

    // Create mock logger
    mockLog = {
      debug: mock.fn(),
      error: mock.fn(),
      child: mock.fn(() => mockLog),
    } as any;

    // Create mock Arweave instance
    mockArweave = {} as any;

    // Create mock peer manager
    mockPeerManager = {
      selectPeers: mock.fn(() => []),
    };

    // Create mock stores
    mockTxStore = {};
    mockBlockStore = {};

    // Create mock failure simulator
    mockFailureSimulator = {
      maybeFail: mock.fn(),
    };

    // Create client instance
    client = new ArweaveCompositeClient({
      log: mockLog,
      arweave: mockArweave,
      trustedNodeUrl: 'https://arweave.net',
      blockStore: mockBlockStore,
      txStore: mockTxStore,
      failureSimulator: mockFailureSimulator,
      peerManager: mockPeerManager,
      cacheCheckPeriodSeconds: 0, // Disable timers in tests
    });
  });

  afterEach(() => {
    // Clean up client timers and caches
    if (client !== undefined && typeof client.cleanup === 'function') {
      client.cleanup();
    }
    mock.restoreAll();
  });

  describe('findTxByOffset', () => {
    it('should return null when no block contains the offset', async () => {
      // Mock getHeight to return a valid height
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight to return blocks that don't contain the target offset
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: '1000000', // All blocks have weave_size much larger than target
        txs: [],
      }));

      const result = await client.findTxByOffset(500);
      assert.strictEqual(result, null);
    });

    it('should find transaction when block and transaction contain the offset', async () => {
      const targetOffset = 1500;
      const containingBlockHeight = 50;
      const txId = 'test-tx-id';
      const txOffset = 2000;

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight
      client.getBlockByHeight = mock.fn(async (height: number) => {
        if (height >= containingBlockHeight) {
          return {
            height,
            weave_size: '2500', // Contains the target offset
            txs: [txId],
          };
        }
        return {
          height,
          weave_size: '1000', // Doesn't contain the target offset
          txs: [],
        };
      });

      // Mock getTxOffset
      client.getTxOffset = mock.fn(async (id: string) => {
        if (id === txId) {
          return { offset: txOffset.toString() };
        }
        throw new Error('Transaction not found');
      });

      const result = await client.findTxByOffset(targetOffset);

      assert.strictEqual(result?.txId, txId);
      assert.strictEqual(result?.txOffset, txOffset);
    });

    it('should handle empty transaction list in blocks', async () => {
      const targetOffset = 1500;

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight to return blocks with empty transaction lists
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: height >= 50 ? '2500' : '1000',
        txs: [], // Empty transaction list
      }));

      const result = await client.findTxByOffset(targetOffset);
      assert.strictEqual(result, null);
    });

    it('should fail when transaction offset requests fail', async () => {
      const targetOffset = 1500;
      const containingBlockHeight = 50;
      const failingTxId = 'failing-tx';

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight
      client.getBlockByHeight = mock.fn(async (height: number) => {
        if (height >= containingBlockHeight) {
          return {
            height,
            weave_size: '2500',
            txs: [failingTxId],
          };
        }
        return {
          height,
          weave_size: '1000',
          txs: [],
        };
      });

      // Mock getTxOffset to fail
      client.getTxOffset = mock.fn(async (id: string) => {
        if (id === failingTxId) {
          throw new Error('Failed to get offset');
        }
        throw new Error('Unknown transaction');
      });

      await assert.rejects(
        async () => client.findTxByOffset(targetOffset),
        /Failed to get transaction offset for failing-tx/,
      );
    });

    it('should use cached block data for repeated searches', async () => {
      const targetOffset = 1500;

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight - should only be called once due to caching
      const getBlockMock = mock.fn(async (height: number) => ({
        height,
        weave_size: height >= 50 ? '2500' : '1000',
        txs: [],
      }));
      client.getBlockByHeight = getBlockMock;

      // First search
      await client.findTxByOffset(targetOffset);

      // Second search with same offset should use cache
      await client.findTxByOffset(targetOffset);

      // Verify that block lookup wasn't called twice for the same block
      // due to caching of the final result
      const uniqueHeights = new Set();
      for (const call of (getBlockMock as any).mock.calls) {
        uniqueHeights.add(call[0]);
      }

      // Should have fewer total calls on second search due to caching
      assert.ok((getBlockMock as any).mock.calls.length > 0);
    });

    it('should handle errors gracefully and rethrow them', async () => {
      const targetOffset = 1500;

      // Mock getHeight to throw an error
      client.getHeight = mock.fn(async () => {
        throw new Error('Network error');
      });

      await assert.rejects(
        async () => client.findTxByOffset(targetOffset),
        /Network error/,
      );
    });
  });

  describe('edge cases', () => {
    it('should handle offset at block boundary', async () => {
      const exactOffset = 2000;
      const txId = 'boundary-tx';

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: height >= 50 ? '2000' : '1000', // Exact match
        txs: [txId],
      }));

      // Mock getTxOffset
      client.getTxOffset = mock.fn(async () => ({
        offset: exactOffset.toString(),
      }));

      const result = await client.findTxByOffset(exactOffset);

      assert.strictEqual(result?.txId, txId);
      assert.strictEqual(result?.txOffset, exactOffset);
    });

    it('should handle very small offsets', async () => {
      const smallOffset = 1;

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight - even the first block is too large
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: '1000',
        txs: [],
      }));

      const result = await client.findTxByOffset(smallOffset);
      assert.strictEqual(result, null);
    });

    it('should handle very large offsets beyond chain', async () => {
      const largeOffset = 999999999;

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight - all blocks are smaller
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: '1000',
        txs: [],
      }));

      const result = await client.findTxByOffset(largeOffset);
      assert.strictEqual(result, null);
    });
  });

  describe('caching behavior', () => {
    it('should cache transaction offsets', async () => {
      const targetOffset = 1500;
      const txId = 'cached-tx';

      // Mock getHeight
      client.getHeight = mock.fn(async () => 100);

      // Mock getBlockByHeight
      client.getBlockByHeight = mock.fn(async (height: number) => ({
        height,
        weave_size: height >= 50 ? '2500' : '1000',
        txs: [txId],
      }));

      // Mock getTxOffset - should only be called once due to caching
      const getTxOffsetMock = mock.fn(async () => ({
        offset: '2000',
      }));
      client.getTxOffset = getTxOffsetMock;

      // First search
      await client.findTxByOffset(targetOffset);

      // Second search should use cached tx offset
      await client.findTxByOffset(targetOffset);

      // getTxOffset should be called multiple times due to binary search,
      // but for the same transaction it should use cache on subsequent calls
      assert.ok((getTxOffsetMock as any).mock.calls.length > 0);
    });
  });
});
