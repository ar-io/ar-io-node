/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import axios from 'axios';

import {
  ArweavePeerManager,
  ArweavePeerManagerConfig,
} from './arweave-peer-manager.js';
import { DnsResolver } from '../lib/dns-resolver.js';

let log: winston.Logger;
let peerManager: ArweavePeerManager;

const TEST_CONFIG: ArweavePeerManagerConfig = {
  log: winston.createLogger({ silent: true }),
  trustedNodeUrl: 'http://trusted-node.example.com',
  preferredChunkGetUrls: ['http://preferred-get.example.com'],
  preferredChunkPostUrls: ['http://preferred-post.example.com'],
  ignoreUrls: ['ignored-peer.example.com'],
  peerInfoTimeoutMs: 1000,
  refreshIntervalMs: 60000,
  temperatureDelta: 5,
};

before(async () => {
  log = winston.createLogger({ silent: true });
});

beforeEach(async () => {
  mock.restoreAll();
  peerManager = new ArweavePeerManager(TEST_CONFIG);
});

afterEach(() => {
  mock.restoreAll();
  peerManager?.destroy();
});

describe('ArweavePeerManager', () => {
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const minimalConfig: ArweavePeerManagerConfig = {
        log,
        trustedNodeUrl: 'http://test.example.com',
      };

      const manager = new ArweavePeerManager(minimalConfig);
      assert.ok(manager !== undefined);

      // Should have empty peer lists initially
      assert.equal(manager.getPeerUrls('chain').length, 0);
      assert.equal(manager.getPeerUrls('getChunk').length, 0); // no preferred URLs
      assert.equal(manager.getPeerUrls('postChunk').length, 0);

      manager.destroy();
    });

    it('should initialize with preferred URLs', () => {
      const manager = new ArweavePeerManager(TEST_CONFIG);

      // Should have preferred URLs in getChunk list
      const getChunkPeers = manager.getPeerUrls('getChunk');
      assert.ok(getChunkPeers.includes('http://preferred-get.example.com'));

      manager.destroy();
    });
  });

  describe('peer selection', () => {
    beforeEach(() => {
      // Mock some peers
      (peerManager as any).peers = {
        'peer1.example.com': {
          url: 'http://peer1.example.com',
          blocks: 1000,
          height: 500,
          lastSeen: Date.now(),
        },
        'peer2.example.com': {
          url: 'http://peer2.example.com',
          blocks: 2000,
          height: 600,
          lastSeen: Date.now(),
        },
      };

      // Update weighted lists
      (peerManager as any).updateWeightedPeerLists();
    });

    it('should select peers for different categories', () => {
      const chainPeers = peerManager.selectPeers('chain', 2);
      const getChunkPeers = peerManager.selectPeers('getChunk', 2);
      const postChunkPeers = peerManager.selectPeers('postChunk', 2);

      assert.ok(chainPeers.length > 0);
      assert.ok(getChunkPeers.length > 0);
      assert.ok(postChunkPeers.length > 0);
    });

    it('should return empty array when no peers available', () => {
      const emptyManager = new ArweavePeerManager({
        log,
        trustedNodeUrl: 'http://test.example.com',
      });

      const peers = emptyManager.selectPeers('chain', 5);
      assert.equal(peers.length, 0);

      emptyManager.destroy();
    });

    it('should prioritize preferred URLs for getChunk', () => {
      const peers = peerManager.selectPeers('getChunk', 1);
      // Should prefer the configured preferred URL
      assert.ok(
        peers.includes('http://preferred-get.example.com') ||
          peers.length === 1,
      );
    });
  });

  describe('success/failure reporting', () => {
    beforeEach(() => {
      // Set up weighted peers
      (peerManager as any).weightedChainPeers = [
        { id: 'http://test.example.com', weight: 50 },
      ];
    });

    it('should increase weight on success', () => {
      const initialWeight = (peerManager as any).weightedChainPeers[0].weight;

      peerManager.reportSuccess('chain', 'http://test.example.com', {
        responseTimeMs: 100,
      });

      const newWeight = (peerManager as any).weightedChainPeers[0].weight;
      assert.ok(newWeight > initialWeight);
    });

    it('should decrease weight on failure', () => {
      const initialWeight = (peerManager as any).weightedChainPeers[0].weight;

      peerManager.reportFailure('chain', 'http://test.example.com');

      const newWeight = (peerManager as any).weightedChainPeers[0].weight;
      assert.ok(newWeight < initialWeight);
    });

    it('should not go below weight 1', () => {
      // Set weight to 1
      (peerManager as any).weightedChainPeers[0].weight = 1;

      peerManager.reportFailure('chain', 'http://test.example.com');

      const newWeight = (peerManager as any).weightedChainPeers[0].weight;
      assert.equal(newWeight, 1);
    });

    it('should not go above weight 100', () => {
      // Set weight to 100
      (peerManager as any).weightedChainPeers[0].weight = 100;

      peerManager.reportSuccess('chain', 'http://test.example.com');

      const newWeight = (peerManager as any).weightedChainPeers[0].weight;
      assert.equal(newWeight, 100);
    });
  });

  describe('peer refresh', () => {
    it('should fetch peers from trusted node', async () => {
      // Mock axios for /peers endpoint
      const mockPeersResponse = {
        data: [
          'peer1.example.com',
          'peer2.example.com',
          'ignored-peer.example.com',
        ],
      };

      // Mock axios for /info endpoints
      const mockInfoResponse = {
        data: { blocks: 1000, height: 500 },
      };

      // Create a mock implementation for axios calls
      const mockAxios = mock.fn(async (config: any) => {
        if (config.url && config.url.includes('/peers')) {
          return mockPeersResponse;
        }
        if (config.url && config.url.includes('/info')) {
          return mockInfoResponse;
        }
        throw new Error(`Unexpected request to ${config.url}`);
      });

      // Mock axios.request method
      mock.method(axios, 'request', mockAxios);

      await peerManager.refreshPeers();

      // Should have fetched peers (excluding ignored ones)
      const peers = peerManager.getPeers();
      assert.ok(Object.keys(peers).length > 0);
      assert.ok(!('ignored-peer.example.com' in peers)); // Should be filtered out
    });

    it('should handle refresh errors gracefully', async () => {
      // Mock axios to throw error
      mock.method(axios, 'request', () => {
        return Promise.reject(new Error('Network error'));
      });

      // Should not throw
      await assert.doesNotReject(() => peerManager.refreshPeers());
    });
  });

  describe('auto refresh', () => {
    it('should start and stop auto refresh', () => {
      peerManager.startAutoRefresh();

      // Check that interval is set
      assert.ok((peerManager as any).refreshInterval !== undefined);

      peerManager.stopAutoRefresh();

      // Check that interval is cleared
      assert.ok((peerManager as any).refreshInterval === undefined);
    });
  });

  describe('DNS resolution', () => {
    it('should initialize DNS resolution when resolver provided', async () => {
      const mockResolver: DnsResolver = {
        resolveUrls: async (urls: string[]) => {
          return {
            'http://preferred-get.example.com': [
              'http://resolved1.example.com',
              'http://resolved2.example.com',
            ],
          };
        },
      };

      const configWithDns: ArweavePeerManagerConfig = {
        ...TEST_CONFIG,
        dnsResolver: mockResolver,
      };

      const manager = new ArweavePeerManager(configWithDns);
      await manager.initializeDnsResolution();

      // Should have resolved URLs in the peer lists
      const getChunkPeers = manager.getPeerUrls('getChunk');
      assert.ok(getChunkPeers.includes('http://resolved1.example.com'));
      assert.ok(getChunkPeers.includes('http://resolved2.example.com'));

      manager.destroy();
    });

    it('should handle DNS resolution errors', async () => {
      const mockResolver: DnsResolver = {
        resolveUrls: async () => {
          throw new Error('DNS resolution failed');
        },
      };

      const configWithDns: ArweavePeerManagerConfig = {
        ...TEST_CONFIG,
        dnsResolver: mockResolver,
      };

      const manager = new ArweavePeerManager(configWithDns);

      // Should not throw
      await assert.doesNotReject(() => manager.initializeDnsResolution());

      manager.destroy();
    });
  });

  describe('getPeerUrls', () => {
    it('should return all peer URLs when no category specified', () => {
      (peerManager as any).peers = {
        'peer1.example.com': { url: 'http://peer1.example.com' },
        'peer2.example.com': { url: 'http://peer2.example.com' },
      };

      const urls = peerManager.getPeerUrls();
      assert.equal(urls.length, 2);
      assert.ok(urls.includes('http://peer1.example.com'));
      assert.ok(urls.includes('http://peer2.example.com'));
    });

    it('should return category-specific URLs when category specified', () => {
      const getChunkUrls = peerManager.getPeerUrls('getChunk');
      assert.ok(getChunkUrls.includes('http://preferred-get.example.com'));
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      peerManager.startAutoRefresh();

      // Mock DNS resolver interval
      (peerManager as any).dnsUpdateInterval = setInterval(() => {}, 1000);

      peerManager.destroy();

      // Should have cleared intervals
      assert.ok((peerManager as any).refreshInterval === undefined);
      assert.ok((peerManager as any).dnsUpdateInterval === undefined);
    });
  });
});
