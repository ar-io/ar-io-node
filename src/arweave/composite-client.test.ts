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

  describe('Preferred Chunk POST Peer Weight Management', () => {
    it('should identify preferred peers correctly', () => {
      const client = createTestClient();

      // Set up preferred chunk POST URLs through the private property
      (client as any).preferredChunkPostUrls = [
        'http://preferred1.example.com',
        'http://preferred2.example.com',
      ];

      assert.equal(
        (client as any).isPreferredPeer('http://preferred1.example.com'),
        true,
      );
      assert.equal(
        (client as any).isPreferredPeer('http://preferred2.example.com'),
        true,
      );
      assert.equal(
        (client as any).isPreferredPeer('http://regular.example.com'),
        false,
      );
    });

    it('should not decrease weight for preferred peers on failure', () => {
      const client = createTestClient();

      // Set up preferred chunk POST URLs and peers
      (client as any).preferredChunkPostUrls = ['http://preferred.example.com'];
      (client as any).weightedPostChunkPeers = [
        { id: 'http://preferred.example.com', weight: 100 },
        { id: 'http://regular.example.com', weight: 50 },
      ];

      // Simulate failure for preferred peer
      (client as any).updateChunkPostPeerWeight(
        'http://preferred.example.com',
        false,
      );

      // Weight should remain unchanged for preferred peer
      const preferredPeer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://preferred.example.com',
      );
      assert.equal(preferredPeer.weight, 100);

      // Simulate failure for regular peer
      (client as any).updateChunkPostPeerWeight(
        'http://regular.example.com',
        false,
      );

      // Weight should decrease for regular peer
      const regularPeer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://regular.example.com',
      );
      assert.ok(regularPeer.weight < 50);
    });

    it('should increase weight for preferred peers on success', () => {
      const client = createTestClient();

      // Set up preferred chunk POST URLs and peers
      (client as any).preferredChunkPostUrls = ['http://preferred.example.com'];
      (client as any).weightedPostChunkPeers = [
        { id: 'http://preferred.example.com', weight: 90 },
      ];

      // Simulate success for preferred peer
      (client as any).updateChunkPostPeerWeight(
        'http://preferred.example.com',
        true,
      );

      // Weight should increase for preferred peer
      const preferredPeer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://preferred.example.com',
      );
      assert.ok(preferredPeer.weight > 90);
    });

    it('should maintain high weight for preferred peers over multiple failures', () => {
      const client = createTestClient();

      // Set up preferred chunk POST URLs and peers
      (client as any).preferredChunkPostUrls = ['http://preferred.example.com'];
      (client as any).weightedPostChunkPeers = [
        { id: 'http://preferred.example.com', weight: 100 },
      ];

      const initialWeight = 100;

      // Simulate multiple failures
      for (let i = 0; i < 10; i++) {
        (client as any).updateChunkPostPeerWeight(
          'http://preferred.example.com',
          false,
        );
      }

      // Weight should remain unchanged despite failures
      const preferredPeer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://preferred.example.com',
      );
      assert.equal(preferredPeer.weight, initialWeight);
    });

    it('should correctly handle mixed success and failure for regular peers', () => {
      const client = createTestClient();

      // Set up only regular peers (no preferred)
      (client as any).preferredChunkPostUrls = [];
      (client as any).weightedPostChunkPeers = [
        { id: 'http://regular.example.com', weight: 50 },
      ];

      const initialWeight = 50;

      // Simulate failure
      (client as any).updateChunkPostPeerWeight(
        'http://regular.example.com',
        false,
      );
      let peer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://regular.example.com',
      );
      assert.ok(peer.weight < initialWeight);

      const afterFailureWeight = peer.weight;

      // Simulate success
      (client as any).updateChunkPostPeerWeight(
        'http://regular.example.com',
        true,
      );
      peer = (client as any).weightedPostChunkPeers.find(
        (p: any) => p.id === 'http://regular.example.com',
      );
      assert.ok(peer.weight > afterFailureWeight);
    });

    it('should always sort preferred peers first regardless of weight', () => {
      const client = createTestClient();

      // Set up preferred and regular peers with various weights
      (client as any).preferredChunkPostUrls = [
        'http://preferred1.example.com',
        'http://preferred2.example.com',
      ];
      (client as any).weightedPostChunkPeers = [
        { id: 'http://regular1.example.com', weight: 100 }, // High weight regular
        { id: 'http://preferred1.example.com', weight: 10 }, // Low weight preferred
        { id: 'http://regular2.example.com', weight: 80 },
        { id: 'http://preferred2.example.com', weight: 50 }, // Medium weight preferred
        { id: 'http://regular3.example.com', weight: 90 },
      ];

      // Get eligible peers (all of them)
      const eligiblePeers = [
        'http://regular1.example.com',
        'http://preferred1.example.com',
        'http://regular2.example.com',
        'http://preferred2.example.com',
        'http://regular3.example.com',
      ];

      // Call the sorting function
      const sortedPeers = (client as any).getSortedChunkPostPeers(
        eligiblePeers,
      );

      // Verify preferred peers come first
      assert.equal(sortedPeers[0], 'http://preferred2.example.com'); // Higher weight preferred
      assert.equal(sortedPeers[1], 'http://preferred1.example.com'); // Lower weight preferred

      // Verify regular peers come after, sorted by weight
      assert.equal(sortedPeers[2], 'http://regular1.example.com'); // Weight 100
      assert.equal(sortedPeers[3], 'http://regular3.example.com'); // Weight 90
      assert.equal(sortedPeers[4], 'http://regular2.example.com'); // Weight 80

      // Verify all preferred peers are before all regular peers
      const firstRegularIndex = sortedPeers.findIndex(
        (peer: string) => !(client as any).isPreferredPeer(peer),
      );
      const lastPreferredIndex = sortedPeers
        .map((peer: string, index: number) => ({
          peer,
          index,
          isPreferred: (client as any).isPreferredPeer(peer),
        }))
        .filter((item: any) => item.isPreferred)
        .pop()?.index;

      assert.ok(
        lastPreferredIndex < firstRegularIndex,
        'All preferred peers should come before regular peers',
      );
    });
  });
});
