/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import { AoARIORead } from '@ar.io/sdk';
import { ArIOPeerManager } from './ar-io-peer-manager.js';

let log: winston.Logger;
let peerManager: ArIOPeerManager;
let mockedArIOInstance: AoARIORead;

const INITIAL_PEERS = {
  peer1: 'http://peer1.com',
  peer2: 'https://peer2.com',
  peer3: 'http://peer3.com',
};

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mock.restoreAll();

  // Mock AR.IO SDK instance
  mockedArIOInstance = {
    getGateways: async () => ({
      items: [
        {
          gatewayAddress: 'peer1',
          settings: { protocol: 'http', fqdn: 'peer1.com' },
        },
        {
          gatewayAddress: 'peer2',
          settings: { protocol: 'https', fqdn: 'peer2.com' },
        },
        {
          gatewayAddress: 'peer3',
          settings: { protocol: 'http', fqdn: 'peer3.com' },
        },
      ],
      hasMore: false,
      nextCursor: undefined,
    }),
  } as AoARIORead;

  // Create peer manager with initial peers to avoid network calls
  peerManager = new ArIOPeerManager({
    log,
    networkProcess: mockedArIOInstance,
    nodeWallet: 'localNode',
    initialPeers: INITIAL_PEERS,
    initialCategories: ['test'],
    updatePeersRefreshIntervalMs: 3600000, // 1 hour
  });
});

afterEach(() => {
  mock.restoreAll();
  peerManager.stopUpdatingPeers();
});

describe('ArIOPeerManager', () => {
  describe('constructor and initialization', () => {
    it('should initialize with provided peers and categories', () => {
      const peers = peerManager.getPeers();
      assert.deepEqual(peers, INITIAL_PEERS);

      const peerUrls = peerManager.getPeerUrls();
      assert.deepEqual(peerUrls, Object.values(INITIAL_PEERS));
    });

    it('should initialize weights for provided categories', () => {
      const weights = peerManager.getWeights('test');
      assert.ok(weights !== undefined);
      assert.equal(weights.size, 3);

      // All peers should have default weight (50)
      for (const [peerId, weight] of weights.entries()) {
        assert.ok(Object.values(INITIAL_PEERS).includes(peerId));
        assert.equal(weight, 50);
      }
    });

    it('should create a new peer manager without initial peers', () => {
      const newPeerManager = new ArIOPeerManager({
        log,
        networkProcess: mockedArIOInstance,
        nodeWallet: 'localNode',
      });

      assert.deepEqual(newPeerManager.getPeers(), {});
      newPeerManager.stopUpdatingPeers();
    });
  });

  describe('category registration and weight management', () => {
    it('should register new categories with default weights', () => {
      peerManager.registerCategory('newCategory');

      const weights = peerManager.getWeights('newCategory');
      assert.ok(weights !== undefined);
      assert.equal(weights.size, 3);

      for (const weight of weights.values()) {
        assert.equal(weight, 50); // DEFAULT_WEIGHT
      }
    });

    it('should register categories with custom configuration', () => {
      peerManager.registerCategory('customCategory', {
        defaultWeight: 75,
        temperatureDelta: 10,
        cacheTtlMs: 1000,
      });

      const weights = peerManager.getWeights('customCategory');
      assert.ok(weights !== undefined);

      for (const weight of weights.values()) {
        assert.equal(weight, 75);
      }
    });

    it('should not overwrite existing category configuration', () => {
      // First registration
      peerManager.registerCategory('existing', { defaultWeight: 25 });
      let weights = peerManager.getWeights('existing');
      assert.ok(weights !== undefined);

      for (const weight of weights.values()) {
        assert.equal(weight, 25);
      }

      // Second registration should not change weights
      peerManager.registerCategory('existing', { defaultWeight: 75 });
      weights = peerManager.getWeights('existing');
      assert.ok(weights !== undefined);

      for (const weight of weights.values()) {
        assert.equal(weight, 25); // Should remain unchanged
      }
    });
  });

  describe('peer selection and caching', () => {
    it('should select peers from a category', () => {
      const selectedPeers = peerManager.selectPeers('test', 2);
      assert.equal(selectedPeers.length, 2);

      // All selected peers should be from our peer list
      for (const peer of selectedPeers) {
        assert.ok(Object.values(INITIAL_PEERS).includes(peer));
      }
    });

    it('should handle selecting more peers than available', () => {
      const selectedPeers = peerManager.selectPeers('test', 10);
      // Should return all available peers (with potential duplicates from weighted selection)
      assert.ok(selectedPeers.length > 0);
      assert.ok(selectedPeers.length <= 10);
    });

    it('should throw error when no peers available for category', () => {
      const emptyPeerManager = new ArIOPeerManager({
        log,
        networkProcess: mockedArIOInstance,
        nodeWallet: 'localNode',
        initialPeers: {},
        initialCategories: ['empty'],
      });

      assert.throws(
        () => emptyPeerManager.selectPeers('empty', 1),
        /No weighted peers available for category: empty/,
      );

      emptyPeerManager.stopUpdatingPeers();
    });

    it('should auto-register category if not exists', () => {
      const selectedPeers = peerManager.selectPeers('newCategory', 1);
      assert.equal(selectedPeers.length, 1);

      // Category should now exist
      const weights = peerManager.getWeights('newCategory');
      assert.ok(weights !== undefined);
    });

    it('should cache peer selections', () => {
      // First call
      const peers1 = peerManager.selectPeers('test', 2);

      // Mock the internal method to verify caching
      const selectPeersUncached = peerManager['_selectPeersUncached'];
      const mockUncached = mock.fn(peerManager, '_selectPeersUncached');

      // Second call with same parameters should use cache
      const peers2 = peerManager.selectPeers('test', 2);

      // The uncached method should not have been called again
      assert.equal(mockUncached.mock.callCount(), 0);

      // Results should be identical (cached)
      assert.deepEqual(peers1, peers2);
    });
  });

  describe('success and failure reporting', () => {
    it('should increase weight on success report', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];
      const initialWeights = peerManager.getWeights('test');
      const initialWeight = initialWeights?.get(testPeer) ?? 0;

      peerManager.reportSuccess('test', testPeer, {
        responseTimeMs: 100,
      });

      const updatedWeights = peerManager.getWeights('test');
      const updatedWeight = updatedWeights?.get(testPeer) ?? 0;

      assert.ok(updatedWeight > initialWeight);
    });

    it('should decrease weight on failure report', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];
      const initialWeights = peerManager.getWeights('test');
      const initialWeight = initialWeights?.get(testPeer) ?? 0;

      peerManager.reportFailure('test', testPeer);

      const updatedWeights = peerManager.getWeights('test');
      const updatedWeight = updatedWeights?.get(testPeer) ?? 0;

      assert.ok(updatedWeight < initialWeight);
    });

    it('should handle success reporting for new peer', () => {
      const newPeer = 'http://newpeer.com';

      peerManager.reportSuccess('test', newPeer);

      const weights = peerManager.getWeights('test');
      assert.ok(weights?.has(newPeer));
      assert.ok((weights?.get(newPeer) ?? 0) >= 50); // At least default weight
    });

    it('should handle failure reporting for new peer', () => {
      const newPeer = 'http://newpeer.com';

      peerManager.reportFailure('test', newPeer);

      const weights = peerManager.getWeights('test');
      assert.ok(weights?.has(newPeer));
      assert.equal(weights?.get(newPeer), 1); // MIN_WEIGHT
    });

    it('should cap weights at maximum value', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];

      // Report many successes to try to exceed MAX_WEIGHT
      for (let i = 0; i < 10; i++) {
        peerManager.reportSuccess('test', testPeer, {
          responseTimeMs: 50, // Fast response
        });
      }

      const weights = peerManager.getWeights('test');
      const weight = weights?.get(testPeer) ?? 0;

      assert.ok(weight <= 100); // MAX_WEIGHT
    });

    it('should cap weights at minimum value', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];

      // Report many failures to try to go below MIN_WEIGHT
      for (let i = 0; i < 10; i++) {
        peerManager.reportFailure('test', testPeer);
      }

      const weights = peerManager.getWeights('test');
      const weight = weights?.get(testPeer) ?? 0;

      assert.ok(weight >= 1); // MIN_WEIGHT
    });

    it('should auto-register category for success reporting', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];

      peerManager.reportSuccess('autoCategory', testPeer);

      const weights = peerManager.getWeights('autoCategory');
      assert.ok(weights !== undefined);
      assert.ok(weights.has(testPeer));
    });

    it('should auto-register category for failure reporting', () => {
      const testPeer = Object.values(INITIAL_PEERS)[0];

      peerManager.reportFailure('autoCategory', testPeer);

      const weights = peerManager.getWeights('autoCategory');
      assert.ok(weights !== undefined);
      assert.ok(weights.has(testPeer));
    });
  });

  describe('peer list management', () => {
    it('should get current peers', () => {
      const peers = peerManager.getPeers();
      assert.equal(typeof peers, 'object');
      assert.ok(Object.keys(peers).length > 0);
    });

    it('should get peer URLs', () => {
      const peerUrls = peerManager.getPeerUrls();
      assert.ok(Array.isArray(peerUrls));
      assert.ok(peerUrls.length > 0);

      // All URLs should be valid HTTP(S) URLs
      for (const url of peerUrls) {
        assert.ok(url.startsWith('http://') || url.startsWith('https://'));
      }
    });

    it('should stop updating peers', () => {
      // This should not throw
      peerManager.stopUpdatingPeers();

      // Call again to ensure it handles being called multiple times
      peerManager.stopUpdatingPeers();
    });
  });

  describe('cache behavior', () => {
    it('should cache peer selections with same parameters', () => {
      // First call should work
      const peers1 = peerManager.selectPeers('test', 2);
      assert.equal(peers1.length, 2);

      // Second call with same parameters should return cached result
      const peers2 = peerManager.selectPeers('test', 2);
      assert.deepEqual(peers1, peers2);
    });

    it('should return different results for different categories', () => {
      peerManager.registerCategory('category1');
      peerManager.registerCategory('category2');

      const peers1 = peerManager.selectPeers('category1', 2);
      const peers2 = peerManager.selectPeers('category2', 2);

      // Results should be arrays of length 2
      assert.equal(peers1.length, 2);
      assert.equal(peers2.length, 2);
    });

    it('should handle different selection counts', () => {
      const peers1 = peerManager.selectPeers('test', 1);
      const peers2 = peerManager.selectPeers('test', 2);

      assert.equal(peers1.length, 1);
      assert.equal(peers2.length, 2);
    });
  });
});
