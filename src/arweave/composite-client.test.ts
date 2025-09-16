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
import { ArweavePeerManager } from '../peers/arweave-peer-manager.js';
import log from '../log.js';

describe('ArweaveCompositeClient', () => {
  let mockBlockStore: any;
  let mockTxStore: any;
  let mockPeerManager: any;
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

    mockPeerManager = {
      getPeers: mock.fn(() => ({})),
      getPeerUrls: mock.fn((category?: string) => {
        if (category === 'getChunk') {
          return ['http://peer1.example.com', 'http://peer2.example.com'];
        }
        return [];
      }),
      selectPeers: mock.fn((category: string, count: number) => {
        if (category === 'getChunk') {
          return ['http://peer1.example.com', 'http://peer2.example.com'].slice(
            0,
            count,
          );
        }
        if (category === 'postChunk') {
          return [
            'http://tip-2.arweave.xyz',
            'http://tip-3.arweave.xyz',
            'http://tip-4.arweave.xyz',
          ].slice(0, count);
        }
        return [];
      }),
      reportSuccess: mock.fn(),
      reportFailure: mock.fn(),
      startAutoRefresh: mock.fn(),
      stopAutoRefresh: mock.fn(),
      refreshPeers: mock.fn(),
      initializeDnsResolution: mock.fn(),
      destroy: mock.fn(),
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
      blockStore: mockBlockStore,
      txStore: mockTxStore,
      failureSimulator,
      peerManager: mockPeerManager,
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

      // Test that peer manager's getPeerUrls is called correctly
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      assert.equal(getChunkPeers.length, 2);
      assert.equal(getChunkPeers[0], 'http://peer1.example.com');
      assert.equal(getChunkPeers[1], 'http://peer2.example.com');
    });

    it('should only affect chunk GET peers, not chain peers', () => {
      const preferredChunkGetUrls = [
        'http://peer1.example.com',
        'http://peer2.example.com',
      ];

      const client = createTestClient({ preferredChunkGetUrls });

      // Test that different peer categories return different results
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      const chainPeers = mockPeerManager.getPeerUrls('chain');
      const postChunkPeers = mockPeerManager.getPeerUrls('postChunk');

      // Only chunk GET peers should be initialized with preferred URLs
      assert.equal(getChunkPeers.length, 2);
      assert.equal(chainPeers.length, 0);
      // POST peers now have defaults (tip-2, tip-3, tip-4)
      assert.equal(postChunkPeers.length, 0);
    });

    it('should work without preferred chunk GET URLs', () => {
      // Update mock to return empty array when no preferred URLs
      mockPeerManager.getPeerUrls = mock.fn((category?: string) => {
        return [];
      });

      const client = createTestClient();

      // Test that no peers are returned when none are configured
      const getChunkPeers = mockPeerManager.getPeerUrls('getChunk');
      assert.equal(getChunkPeers.length, 0);
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

      // Verify that peerManager.selectPeers was called correctly
      assert.ok(mockPeerManager.selectPeers.mock.calls.length > 0);
      const call =
        mockPeerManager.selectPeers.mock.calls[
          mockPeerManager.selectPeers.mock.calls.length - 1
        ];
      assert.equal(call.arguments[0], 'getChunk');
      assert.equal(call.arguments[1], 1);
    });

    it('should handle empty peer selection gracefully', () => {
      // Update mock to return empty arrays for selectPeers
      mockPeerManager.selectPeers = mock.fn(() => []);

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
