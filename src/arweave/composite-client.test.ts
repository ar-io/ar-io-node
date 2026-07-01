/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { default as Arweave } from 'arweave';

import {
  ArweaveCompositeClient,
  chunkPostPeersCacheKey,
  chunkPostPeerDomain,
  evaluateChunkBroadcastVerdict,
  type ChunkBroadcastVerdictInput,
} from './composite-client.js';
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

  describe('AbortSignal threading', () => {
    // Note: setInterval is mocked in beforeEach so the rate-limit bucket
    // filler never runs. trustedNodeRequestBucket therefore starts at 0,
    // which lets us deterministically exercise the bucket-wait code path.

    it('rejects with AbortError when caller aborts while bucket is empty (the pivotal regression case)', async () => {
      const client = createTestClient();

      // Replace trustedNodeAxios with a mock so we can detect whether it was
      // ever called. Under the bug, an aborted caller would still wait for
      // bucket tokens and eventually issue the HTTP request.
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      // Bucket is empty — confirm.
      assert.equal((client as any).trustedNodeRequestBucket, 0);

      const controller = new AbortController();

      // Fire the request, then abort almost immediately. The bucket will
      // never have tokens (filler is mocked off), so the only way for the
      // request to terminate is by honoring the abort signal.
      const requestPromise = client.getTxOffset(
        'test-tx-id',
        controller.signal,
      );

      // Give the worker a tick to enter the bucket-wait loop, then abort.
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await assert.rejects(requestPromise, (error: any) => {
        return (
          error.name === 'AbortError' ||
          error.message?.includes('aborted') ||
          error.message?.includes('Aborted')
        );
      });

      // The HTTP call must NOT have been made — we aborted before any
      // tokens were available.
      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'trustedNodeAxios should not have been called for an aborted request',
      );
    });

    it('rejects immediately when signal is already aborted at call time', async () => {
      const client = createTestClient();
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        client.getTxOffset('test-tx-id', controller.signal),
        (error: any) => error.name === 'AbortError',
      );
      await assert.rejects(
        client.getTxField('test-tx-id', 'data_root', controller.signal),
        (error: any) => error.name === 'AbortError',
      );

      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'No HTTP call should be made for a pre-aborted request',
      );
    });

    it('passes signal through to axios so the HTTP request itself is cancellable', async () => {
      const client = createTestClient();
      // Manually pre-fill the bucket so the request can proceed past the
      // rate-limit gate without waiting on the (mocked) filler.
      (client as any).trustedNodeRequestBucket = 10;

      const receivedConfigs: any[] = [];
      (client as any).trustedNodeAxios = mock.fn((cfg: any) => {
        receivedConfigs.push(cfg);
        return Promise.resolve({ data: { offset: '1', size: '2' } });
      });

      const controller = new AbortController();
      await client.getTxOffset('test-tx-id', controller.signal);

      assert.equal(receivedConfigs.length, 1);
      assert.ok(
        receivedConfigs[0].signal instanceof AbortSignal,
        'axios call should receive an AbortSignal in its config',
      );
      assert.equal(receivedConfigs[0].signal, controller.signal);
    });

    it('one caller aborting getChunkByAny does not abort the shared cached fetch', async () => {
      const client = createTestClient();

      // Replace peerGetChunk with a slow mock so the cache promise stays
      // pending long enough for both callers to share it.
      let resolveChunk!: (chunk: any) => void;
      const sharedChunk = {
        tx_path: Buffer.from(''),
        data_root: Buffer.from(''),
        data_size: 1000,
        data_path: Buffer.from(''),
        offset: 0,
        hash: Buffer.from(''),
        chunk: Buffer.from('payload'),
      };
      let peerGetChunkCalls = 0;
      (client as any).peerGetChunk = mock.fn(() => {
        peerGetChunkCalls++;
        return new Promise((resolve) => {
          resolveChunk = resolve;
        });
      });

      const params = {
        txSize: 1000,
        absoluteOffset: 0,
        dataRoot: 'test-root',
        relativeOffset: 0,
      };

      const aborterA = new AbortController();
      const aborterB = new AbortController();

      // Two concurrent callers — they should share the same underlying
      // cached promise (peerGetChunk should only be invoked once).
      const promiseA = client.getChunkByAny(params, aborterA.signal);
      const promiseB = client.getChunkByAny(params, aborterB.signal);

      // Yield so promise initialization runs.
      await new Promise((resolve) => setImmediate(resolve));

      // Caller A bails out — caller B should still be able to receive the
      // chunk once the underlying fetch completes.
      aborterA.abort();

      await assert.rejects(
        promiseA,
        (error: any) => error.name === 'AbortError',
      );

      // Now resolve the underlying fetch. Caller B should still get the chunk.
      resolveChunk(sharedChunk);

      const result = await promiseB;
      assert.equal(result.chunk.toString(), 'payload');

      // The underlying fetch ran exactly once thanks to dedup.
      assert.equal(peerGetChunkCalls, 1);
    });

    it('honors abort during the bucket-wait loop even after the bucket later refills', async () => {
      const client = createTestClient();
      const axiosMock = mock.fn(() => Promise.resolve({ data: 'unused' }));
      (client as any).trustedNodeAxios = axiosMock;

      // Bucket is empty — request will spin in the bucket-wait loop.
      assert.equal((client as any).trustedNodeRequestBucket, 0);

      const controller = new AbortController();
      const requestPromise = client.getTxField(
        'test-tx-id',
        'data_root',
        controller.signal,
      );

      // Let the worker enter the wait loop.
      await new Promise((resolve) => setImmediate(resolve));

      // Abort first, then refill the bucket. The worker must still bail
      // out because the abort signal was raised before/during its wait,
      // not silently consume a token and proceed with HTTP.
      controller.abort();
      (client as any).trustedNodeRequestBucket = 100;

      await assert.rejects(requestPromise, (error: any) => {
        return error.name === 'AbortError';
      });
      assert.equal(
        axiosMock.mock.callCount(),
        0,
        'trustedNodeAxios should not run when the request was aborted in the bucket-wait loop',
      );
    });
  });

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

      const selectedPeers = client.peerManager.selectPeers('getChunk', 1);

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

      const selectedPeers = client.peerManager.selectPeers('getChunk', 5);

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

  describe('chunkPostPeersCacheKey', () => {
    it('distinguishes different peer sets of equal length', () => {
      // The bug this fixes: a length-only key collided these onto one cached
      // ordering for the full cache window, narrowing seeding diversity.
      const a = ['http://a:1984', 'http://b:1984', 'http://c:1984'];
      const b = ['http://x:1984', 'http://y:1984', 'http://z:1984'];
      assert.equal(a.length, b.length);
      assert.notEqual(chunkPostPeersCacheKey(a), chunkPostPeersCacheKey(b));
    });

    it('is order-independent for the same set (set identity)', () => {
      const ordered = ['http://a:1984', 'http://b:1984', 'http://c:1984'];
      const shuffled = ['http://c:1984', 'http://a:1984', 'http://b:1984'];
      assert.equal(
        chunkPostPeersCacheKey(ordered),
        chunkPostPeersCacheKey(shuffled),
      );
    });

    it('does not mutate the input array', () => {
      const peers = ['http://c:1984', 'http://a:1984', 'http://b:1984'];
      const snapshot = [...peers];
      chunkPostPeersCacheKey(peers);
      assert.deepEqual(peers, snapshot);
    });

    it('handles the empty set', () => {
      assert.equal(chunkPostPeersCacheKey([]), '');
    });
  });
});

describe('chunkPostPeerDomain', () => {
  it('buckets IP-literal peers by /24', () => {
    assert.equal(
      chunkPostPeerDomain('http://38.29.227.74:1984'),
      '38.29.227.0/24',
    );
  });

  it('collapses the resolved tip nodes into one domain', () => {
    const tips = [
      'http://38.29.227.74:1984',
      'http://38.29.227.75:1984',
      'http://38.29.227.70:1984',
    ];
    assert.equal(new Set(tips.map(chunkPostPeerDomain)).size, 1);
  });

  it('handles bracketed IPv6 hosts', () => {
    assert.equal(
      chunkPostPeerDomain('http://[2001:db8:abcd:1234::1]:1984'),
      '2001:0db8:abcd::/48',
    );
  });

  it('falls back to the peer string for unparseable input', () => {
    assert.equal(chunkPostPeerDomain('not a url'), 'not a url');
  });
});

describe('evaluateChunkBroadcastVerdict', () => {
  const base: ChunkBroadcastVerdictInput = {
    successCount: 0,
    preferredSuccessCount: 0,
    distinctDomainCount: 0,
    preferredEligibleCount: 5,
    domainsAvailable: 5,
    minSuccessCount: 3,
    minPreferredSuccessCount: 2,
    minDistinctDomains: 0,
    preferredSoftFallback: false,
  };

  describe('defaults reduce to legacy behavior', () => {
    it('succeeds exactly when success>=min AND preferred>=minPreferred', () => {
      // Meets both -> succeeded
      assert.equal(
        evaluateChunkBroadcastVerdict({
          ...base,
          successCount: 3,
          preferredSuccessCount: 2,
        }).succeeded,
        true,
      );
      // Preferred short -> fails (legacy hard requirement preserved)
      assert.equal(
        evaluateChunkBroadcastVerdict({
          ...base,
          successCount: 5,
          preferredSuccessCount: 1,
        }).succeeded,
        false,
      );
      // Success short -> fails
      assert.equal(
        evaluateChunkBroadcastVerdict({
          ...base,
          successCount: 2,
          preferredSuccessCount: 2,
        }).succeeded,
        false,
      );
    });

    it('does not apply the domain target when feature is off', () => {
      assert.equal(
        evaluateChunkBroadcastVerdict({
          ...base,
          successCount: 3,
          preferredSuccessCount: 2,
          distinctDomainCount: 1, // all one /24, but feature off -> fine
        }).succeeded,
        true,
      );
    });
  });

  describe('soft-preferred fallback', () => {
    it('rescues a tips-down POST via a strong distinct-domain quorum', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        preferredSoftFallback: true,
        preferredEligibleCount: 0, // tips unavailable
        successCount: 4,
        preferredSuccessCount: 0,
        distinctDomainCount: 3, // >= max(minPreferred=2, minDomains=0)
      });
      assert.equal(v.succeeded, true);
      assert.equal(v.preferredShortfall, 'tips_unavailable');
    });

    it('does NOT fire when tips were eligible but merely failed', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        preferredSoftFallback: true,
        preferredEligibleCount: 5, // tips were up, just didn't ack
        successCount: 4,
        preferredSuccessCount: 0,
        distinctDomainCount: 4,
      });
      assert.equal(v.succeeded, false);
      assert.equal(v.preferredShortfall, 'tips_failed');
    });

    it('requires a sufficiently diverse fallback quorum', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        preferredSoftFallback: true,
        preferredEligibleCount: 0,
        successCount: 4,
        preferredSuccessCount: 0,
        distinctDomainCount: 1, // one /24 -> not a real stand-in for the tips
      });
      assert.equal(v.succeeded, false);
    });

    it('stays off unless the flag is set', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        preferredSoftFallback: false,
        preferredEligibleCount: 0,
        successCount: 4,
        distinctDomainCount: 4,
      });
      assert.equal(v.succeeded, false);
    });
  });

  describe('distinct-domain target', () => {
    it('fails an otherwise-good POST that lacks domain diversity', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        minDistinctDomains: 3,
        domainsAvailable: 5,
        successCount: 3,
        preferredSuccessCount: 2,
        distinctDomainCount: 2, // below target, but achievable
      });
      assert.equal(v.succeeded, false);
      assert.equal(v.domainShortfall, 'unmet');
    });

    it('soft-degrades (succeeds) when the eligible set cannot supply the target', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        minDistinctDomains: 5,
        domainsAvailable: 2, // network only offers 2 domains
        successCount: 3,
        preferredSuccessCount: 2,
        distinctDomainCount: 2, // met what's available
      });
      assert.equal(v.succeeded, true);
      assert.equal(v.domainShortfall, 'degraded');
    });

    it('succeeds when the target is met', () => {
      const v = evaluateChunkBroadcastVerdict({
        ...base,
        minDistinctDomains: 3,
        domainsAvailable: 5,
        successCount: 4,
        preferredSuccessCount: 2,
        distinctDomainCount: 3,
      });
      assert.equal(v.succeeded, true);
      assert.equal(v.domainShortfall, 'none');
    });
  });
});
