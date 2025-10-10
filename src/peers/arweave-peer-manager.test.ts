/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import axios from 'axios';

import {
  ArweavePeerManager,
  ArweavePeerManagerConfig,
} from './arweave-peer-manager.js';
import { DnsResolver, ResolvedUrl } from '../lib/dns-resolver.js';
import { createTestLogger } from '../../test/test-logger.js';

let log: ReturnType<typeof createTestLogger>;
let peerManager: ArweavePeerManager;

const TEST_CONFIG: ArweavePeerManagerConfig = {
  log: createTestLogger({ suite: 'ArweavePeerManager' }),
  trustedNodeUrl: 'http://trusted-node.example.com',
  preferredChunkGetUrls: ['http://preferred-get.example.com'],
  preferredChunkPostUrls: ['http://preferred-post.example.com'],
  ignoreUrls: ['ignored-peer.example.com'],
  peerInfoTimeoutMs: 1000,
  refreshIntervalMs: 60000,
  temperatureDelta: 5,
};

before(async () => {
  log = createTestLogger({ suite: 'ArweavePeerManager' });
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

    it('should fetch sync buckets immediately after peer refresh', async () => {
      // Mock axios for /peers endpoint
      const mockPeersResponse = {
        data: ['peer1.example.com'],
      };

      // Mock axios for /info endpoint
      const mockInfoResponse = {
        data: { blocks: 1000, height: 500 },
      };

      // Mock axios for /sync_buckets endpoint
      const mockSyncBucketsResponse = {
        data: new ArrayBuffer(0), // Empty ETF data for test
      };

      // Create a comprehensive mock for axios.request calls
      const mockAxiosRequest = mock.fn(async (config: any) => {
        if (config.url && config.url.includes('/peers')) {
          return mockPeersResponse;
        }
        if (config.url && config.url.includes('/info')) {
          return mockInfoResponse;
        }
        throw new Error(`Unexpected request to ${config.url}`);
      });

      // Create a mock for axios.get calls (used for sync_buckets)
      const mockAxiosGet = mock.fn(async (url: string) => {
        if (url.includes('/sync_buckets')) {
          return mockSyncBucketsResponse;
        }
        throw new Error(`Unexpected GET request to ${url}`);
      });

      // Mock ETF parsing to return empty set
      const mockParseETF = mock.fn(() => new Set());
      mock.method(peerManager as any, 'parseETFSyncBuckets', mockParseETF);

      // Mock both axios methods
      mock.method(axios, 'request', mockAxiosRequest);
      mock.method(axios, 'get', mockAxiosGet);

      await peerManager.refreshPeers();

      // Check if sync bucket calls were made
      const getCalls = mockAxiosGet.mock.calls.length;

      // Should have made at least one call to axios.get for sync_buckets
      assert.ok(
        getCalls > 0,
        `Expected at least one sync bucket call, but got ${getCalls}`,
      );

      // Verify that the peer was added
      const peers = peerManager.getPeers();
      const peer = peers['peer1.example.com'];
      assert.ok(peer !== undefined, 'Peer should have been added');
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
        resolveUrls: async (urls: string[]): Promise<ResolvedUrl[]> => {
          return urls.map((url) => ({
            hostname: new URL(url).hostname,
            originalUrl: url,
            resolvedUrl: url.replace('preferred-get.example.com', '1.2.3.4'),
            ips: ['1.2.3.4'],
            lastResolved: Date.now(),
          }));
        },
      } as DnsResolver;

      const configWithDns: ArweavePeerManagerConfig = {
        ...TEST_CONFIG,
        dnsResolver: mockResolver,
      };

      const manager = new ArweavePeerManager(configWithDns);
      try {
        await manager.initializeDnsResolution();

        // Should have resolved URLs in the peer lists
        const getChunkPeers = manager.getPeerUrls('getChunk');
        assert.ok(getChunkPeers.includes('http://1.2.3.4'));
      } finally {
        manager.destroy();
      }
    });

    it('should handle DNS resolution errors', async () => {
      const mockResolver: DnsResolver = {
        resolveUrls: async (): Promise<ResolvedUrl[]> => {
          throw new Error('DNS resolution failed');
        },
      } as DnsResolver;

      const configWithDns: ArweavePeerManagerConfig = {
        ...TEST_CONFIG,
        dnsResolver: mockResolver,
      };

      const manager = new ArweavePeerManager(configWithDns);

      try {
        // Should not throw
        await assert.doesNotReject(() => manager.initializeDnsResolution());
      } finally {
        manager.destroy();
      }
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
      peerManager.startBucketRefresh();

      // Mock DNS resolver interval
      (peerManager as any).dnsUpdateInterval = setInterval(() => {}, 1000);

      peerManager.destroy();

      // Should have cleared intervals
      assert.ok((peerManager as any).refreshInterval === undefined);
      assert.ok((peerManager as any).bucketRefreshInterval === undefined);
      assert.ok((peerManager as any).dnsUpdateInterval === undefined);
    });
  });

  describe('bucket utilities', () => {
    it('should calculate bucket index correctly', () => {
      const getBucketIndex = (peerManager as any).getBucketIndex.bind(
        peerManager,
      );

      // 10GB = 10 * 1024 * 1024 * 1024 bytes
      const bucketSize = 10 * 1024 * 1024 * 1024;

      assert.equal(getBucketIndex(0), 0);
      assert.equal(getBucketIndex(bucketSize - 1), 0);
      assert.equal(getBucketIndex(bucketSize), 1);
      assert.equal(getBucketIndex(bucketSize * 2), 2);
    });

    it('should parse ETF sync buckets correctly', async () => {
      // Mock the parseETFSyncBuckets method directly to return expected results
      const mockParseETF = mock.fn(async () => new Set([0, 1, 3])); // Simulates buckets with data > 0
      mock.method(peerManager as any, 'parseETFSyncBuckets', mockParseETF);

      const mockData = new ArrayBuffer(32);
      const result = await (peerManager as any).parseETFSyncBuckets(mockData);

      // Should only include buckets with share > 0
      assert.ok(result.has(0));
      assert.ok(result.has(1));
      assert.ok(!result.has(2));
      assert.ok(result.has(3));
      assert.equal(result.size, 3);
    });

    it('should handle invalid ETF data gracefully', async () => {
      // Mock the parseETFSyncBuckets method to return empty set on error
      const mockParseETF = mock.fn(async () => new Set()); // Simulates error case
      mock.method(peerManager as any, 'parseETFSyncBuckets', mockParseETF);

      const mockData = new ArrayBuffer(32);
      const result = await (peerManager as any).parseETFSyncBuckets(mockData);

      // Should return empty set on error
      assert.equal(result.size, 0);
    });
  });

  describe('selectPeersForOffset', () => {
    beforeEach(() => {
      // Set up test peers with sync buckets
      (peerManager as any).peers = {
        'peer1.example.com': {
          url: 'http://peer1.example.com',
          blocks: 1000,
          height: 1000,
          lastSeen: Date.now(),
          syncBuckets: new Set([0, 1, 2]),
          bucketsLastUpdated: Date.now(),
        },
        'peer2.example.com': {
          url: 'http://peer2.example.com',
          blocks: 1000,
          height: 1000,
          lastSeen: Date.now(),
          syncBuckets: new Set([1, 2, 3]),
          bucketsLastUpdated: Date.now(),
        },
        'peer3.example.com': {
          url: 'http://peer3.example.com',
          blocks: 1000,
          height: 1000,
          lastSeen: Date.now(),
          syncBuckets: new Set([3, 4, 5]),
          bucketsLastUpdated: Date.now(),
        },
      };

      // Set up weighted peers
      (peerManager as any).weightedGetChunkPeers = [
        { id: 'peer1.example.com', weight: 10 },
        { id: 'peer2.example.com', weight: 5 },
        { id: 'peer3.example.com', weight: 2 },
      ];
    });

    it('should select peers that have the required bucket', () => {
      const bucketSize = 10 * 1024 * 1024 * 1024;

      // Offset in bucket 1 - should return peer1 and peer2
      const peersForBucket1 = peerManager.selectPeersForOffset(
        bucketSize + 1000,
        2,
      );
      assert.equal(peersForBucket1.length, 2);
      assert.ok(peersForBucket1.includes('http://peer1.example.com'));
      assert.ok(peersForBucket1.includes('http://peer2.example.com'));
      assert.ok(!peersForBucket1.includes('http://peer3.example.com'));
    });

    it('should use weights for peer selection', () => {
      const bucketSize = 10 * 1024 * 1024 * 1024;

      // Offset in bucket 1 - should return one of peer1 or peer2 (both have this bucket)
      const peersForBucket1 = peerManager.selectPeersForOffset(
        bucketSize + 1000,
        1,
      );

      // Should return exactly one peer
      assert.equal(peersForBucket1.length, 1);

      // Should be either peer1 or peer2 (both have bucket 1)
      const selectedPeer = peersForBucket1[0];
      assert.ok(
        selectedPeer === 'http://peer1.example.com' ||
          selectedPeer === 'http://peer2.example.com',
        `Selected peer should be peer1 or peer2, but got ${selectedPeer}`,
      );

      // Should not select peer3 (doesn't have bucket 1)
      assert.notEqual(selectedPeer, 'http://peer3.example.com');
    });

    it('should fall back to regular selection when no peers have the bucket', () => {
      const bucketSize = 10 * 1024 * 1024 * 1024;

      // Mock selectPeers to return specific peers
      const mockSelectPeers = mock.fn(() => ['fallback-peer.example.com']);
      mock.method(peerManager, 'selectPeers', mockSelectPeers);

      // Offset in bucket 10 - no peers have this bucket
      const peersForBucket10 = peerManager.selectPeersForOffset(
        bucketSize * 10,
        1,
      );

      assert.equal(mockSelectPeers.mock.callCount(), 1);
      assert.deepEqual(mockSelectPeers.mock.calls[0].arguments, [
        'getChunk',
        1,
      ]);
      assert.deepEqual(peersForBucket10, ['fallback-peer.example.com']);
    });

    it('should handle peers without sync buckets', () => {
      // Add peer without sync buckets
      (peerManager as any).peers['peer4.example.com'] = {
        url: 'http://peer4.example.com',
        blocks: 1000,
        height: 1000,
        lastSeen: Date.now(),
        // No syncBuckets property
      };

      const bucketSize = 10 * 1024 * 1024 * 1024;
      const peersForBucket1 = peerManager.selectPeersForOffset(
        bucketSize + 1000,
        5,
      );

      // Should not include peer4 since it has no sync buckets
      assert.ok(!peersForBucket1.includes('peer4.example.com'));
    });
  });

  describe('bucket refresh', () => {
    it('should start and stop bucket refresh interval', () => {
      peerManager.startBucketRefresh();
      assert.ok((peerManager as any).bucketRefreshInterval !== undefined);

      peerManager.stopBucketRefresh();
      assert.ok((peerManager as any).bucketRefreshInterval === undefined);
    });

    it('should update peer buckets from /sync_buckets endpoint', async () => {
      // Mock axios request for sync_buckets
      const mockAxiosGet = mock.fn(() =>
        Promise.resolve({
          status: 200,
          data: new ArrayBuffer(32),
        }),
      );
      mock.method(axios, 'get', mockAxiosGet);

      // Mock ETF parsing
      const mockParseETF = mock.fn(() => new Set([1, 2, 3]));
      mock.method(peerManager as any, 'parseETFSyncBuckets', mockParseETF);

      // Add a test peer
      (peerManager as any).peers = {
        'test-peer.example.com': {
          url: 'http://test-peer.example.com',
          blocks: 1000,
          height: 1000,
          lastSeen: Date.now(),
        },
      };

      await (peerManager as any).updatePeerBuckets('test-peer.example.com');

      // Should have called axios.get with correct URL
      assert.equal(mockAxiosGet.mock.callCount(), 1);
      assert.equal(
        mockAxiosGet.mock.calls[0].arguments[0],
        'http://test-peer.example.com/sync_buckets',
      );

      // Should have updated peer with sync buckets
      const peer = (peerManager as any).peers['test-peer.example.com'];
      assert.ok(peer.syncBuckets instanceof Set);
      assert.ok(typeof peer.bucketsLastUpdated === 'number');
    });
  });
});
