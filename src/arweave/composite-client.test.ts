/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { default as Arweave } from 'arweave';

import { ArweaveCompositeClient } from './composite-client.js';
import { UniformFailureSimulator } from '../lib/chaos.js';
import log from '../log.js';

describe('ArweaveCompositeClient', () => {
  let mockBlockStore: any;
  let mockTxStore: any;
  let failureSimulator: UniformFailureSimulator;
  let arweave: Arweave;
  let originalSetInterval: typeof setInterval;
  let mockSetInterval: any;

  beforeEach(() => {
    // Mock setInterval to prevent timers from starting
    originalSetInterval = global.setInterval;
    mockSetInterval = mock.fn(() => ({ unref: mock.fn() }));
    global.setInterval = mockSetInterval;

    mockBlockStore = {
      get: mock.fn(),
      getByHeight: mock.fn(),
      set: mock.fn(),
      delByHeight: mock.fn(),
      delByHash: mock.fn(),
    };

    mockTxStore = {
      get: mock.fn(),
      set: mock.fn(),
      del: mock.fn(),
    };

    failureSimulator = new UniformFailureSimulator({ failureRate: 0 });
    arweave = Arweave.init({});
  });

  afterEach(() => {
    // Restore setInterval
    global.setInterval = originalSetInterval;
    mock.restoreAll();
  });

  // Helper function to create a client with mocked network dependencies
  const createTestClient = (
    options: { preferredChunkGetUrls?: string[] } = {},
  ) => {
    return new ArweaveCompositeClient({
      log,
      arweave,
      trustedNodeUrl: 'https://test.example.com',
      chunkPostUrls: ['https://test.example.com/chunk'],
      blockStore: mockBlockStore,
      txStore: mockTxStore,
      failureSimulator,
      requestTimeout: 100, // Short timeout for tests
      maxConcurrentRequests: 1,
      ...options,
    });
  };

  describe('Preferred Chunk GET URLs', () => {
    it('should initialize with preferred chunk GET URLs', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      // Access private property for testing
      const weightedGetChunkPeers = (client as any).weightedGetChunkPeers;

      assert.equal(weightedGetChunkPeers.length, 2);
      assert.equal(weightedGetChunkPeers[0].id, 'http://peer1.example.com');
      assert.equal(weightedGetChunkPeers[0].weight, 100);
      assert.equal(weightedGetChunkPeers[1].id, 'http://peer2.example.com');
      assert.equal(weightedGetChunkPeers[1].weight, 100);
    });

    it('should only affect chunk GET peers, not chain or post peers', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      // Access private properties for testing
      const weightedGetChunkPeers = (client as any).weightedGetChunkPeers;
      const weightedChainPeers = (client as any).weightedChainPeers;
      const weightedPostChunkPeers = (client as any).weightedPostChunkPeers;

      // Only chunk GET peers should be initialized with preferred URLs
      assert.equal(weightedGetChunkPeers.length, 2);
      assert.equal(weightedChainPeers.length, 0);
      assert.equal(weightedPostChunkPeers.length, 0);
    });

    it('should work without preferred chunk GET URLs', () => {
      const client = createTestClient();

      // Access private property for testing
      const weightedGetChunkPeers = (client as any).weightedGetChunkPeers;

      assert.equal(weightedGetChunkPeers.length, 0);
    });

    it('should select peers from preferred URLs when available', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      const selectedPeers = client.selectPeers(1, 'weightedGetChunkPeers');

      assert.equal(selectedPeers.length, 1);
      assert.ok(preferredChunkGetUrls.includes(selectedPeers[0]));
    });

    it('should handle empty peer selection gracefully', () => {
      const client = createTestClient();

      const selectedPeers = client.selectPeers(5, 'weightedGetChunkPeers');

      assert.equal(selectedPeers.length, 0);
    });

    it('should not use trusted node for chunk retrieval', async () => {
      const preferredChunkGetUrls = ['http://peer1.example.com'];

      const client = createTestClient({ preferredChunkGetUrls });

      // Mock peerGetChunk to fail so we can verify trusted node is not used
      const originalPeerGetChunk = (client as any).peerGetChunk;
      (client as any).peerGetChunk = mock.fn(() => {
        throw new Error('No peers available');
      });

      try {
        await client.getChunkByAny({
          txSize: 1000,
          absoluteOffset: 0,
          dataRoot: 'test-root',
          relativeOffset: 0,
        });
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        // Should fail with peer error, not try trusted node
        assert.ok(
          error.message.includes(
            'Unable to fetch chunk from any available peers',
          ),
        );
        assert.ok(!error.message.includes('trusted node'));
      }

      // Restore original method
      (client as any).peerGetChunk = originalPeerGetChunk;
    });
  });
});
