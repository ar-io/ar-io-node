/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { ARIORead } from '@ar.io/sdk';
import {
  ArIOPeerManager,
  peerFailureKindForStatus,
} from './ar-io-peer-manager.js';
import { createTestLogger } from '../../test/test-logger.js';
import { writePeerListSnapshot } from './peer-list-cache.js';

let log: ReturnType<typeof createTestLogger>;
let peerManager: ArIOPeerManager;
let mockedArIOInstance: ARIORead;

const INITIAL_PEERS = {
  peer1: 'http://peer1.com',
  peer2: 'https://peer2.com',
  peer3: 'http://peer3.com',
};

before(async () => {
  log = createTestLogger({ suite: 'ArIOPeerManager' });
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
  } as ARIORead;

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
  peerManager.shutdown();
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
      newPeerManager.shutdown();
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

      emptyPeerManager.shutdown();
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

      // Second call with same parameters should use cache
      const peers2 = peerManager.selectPeers('test', 2);

      // An uncached selection builds a new array, so getting the very same
      // array back shows the second call was served from the cache.
      assert.strictEqual(peers2, peers1);

      // A different count is a different cache entry
      const peers3 = peerManager.selectPeers('test', 1);
      assert.notStrictEqual(peers3, peers1);
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

    it('decays weights halfway back to the default per half-life (#1119)', () => {
      const [low, high, other] = Object.values(INITIAL_PEERS);
      const weights = peerManager.getWeights('test')!;
      weights.set(low, 10);
      weights.set(high, 90);
      weights.set(other, 50);

      peerManager.decayWeights(0.5);

      assert.equal(weights.get(low), 30);
      assert.equal(weights.get(high), 70);
      assert.equal(weights.get(other), 50, 'a peer at the default stays');
    });

    it('lets a decayed peer back to the front of the home set (#1119)', () => {
      const [cooled, a, b] = Object.values(INITIAL_PEERS);
      const m = new ArIOPeerManager({
        log,
        networkProcess: mockedArIOInstance,
        initialPeers: INITIAL_PEERS,
        initialCategories: ['test'],
        hashRingHomeSetSize: 3,
        weightDecayHalfLifeMs: 0,
      });
      const weights = m.getWeights('test')!;
      weights.set(cooled, 1); // cooled to the floor during an outage
      weights.set(a, 80); // healthy, boosted by successes
      weights.set(b, 80);
      const firstShare = () => {
        let first = 0;
        for (let i = 0; i < 4000; i++) {
          if (m.selectPeersForKey('test', `key-${i}`, 3)[0] === cooled) {
            first++;
          }
        }
        return first / 4000;
      };
      assert.ok(firstShare() < 0.03, 'a cooled peer is rarely tried first');
      // Three half-lives later, with no success reported in between.
      m.decayWeights(0.125);
      weights.set(a, 80);
      weights.set(b, 80);
      assert.ok(
        firstShare() > 0.15, // 43.9 of 203.9 total weight: ~21.5%
        'a peer decayed back toward the default gets first attempts again',
      );
      m.shutdown();
    });

    it('decays by itself on a timer, and stops on shutdown', async (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const m = new ArIOPeerManager({
        log,
        networkProcess: mockedArIOInstance,
        initialPeers: INITIAL_PEERS,
        initialCategories: ['test'],
        weightDecayHalfLifeMs: 60_000,
      });
      const peer = Object.values(INITIAL_PEERS)[0];
      m.getWeights('test')!.set(peer, 10);
      t.mock.timers.tick(60_000);
      assert.equal(m.getWeights('test')!.get(peer), 30);
      m.shutdown();
      t.mock.timers.tick(60_000);
      assert.equal(m.getWeights('test')!.get(peer), 30);
    });

    it('does not decay with a half-life of 0', (t) => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const m = new ArIOPeerManager({
        log,
        networkProcess: mockedArIOInstance,
        initialPeers: INITIAL_PEERS,
        initialCategories: ['test'],
        weightDecayHalfLifeMs: 0,
      });
      const peer = Object.values(INITIAL_PEERS)[0];
      m.getWeights('test')!.set(peer, 10);
      t.mock.timers.tick(10 * 60_000);
      assert.equal(m.getWeights('test')!.get(peer), 10);
      m.shutdown();
    });

    it('cools a busy peer by a fifth of a failure', () => {
      const [failing, busy] = Object.values(INITIAL_PEERS);
      const before = peerManager.getWeights('test')!;
      const failingBefore = before.get(failing)!;
      const busyBefore = before.get(busy)!;

      peerManager.reportFailure('test', failing);
      peerManager.reportFailure('test', busy, 'busy');

      const after = peerManager.getWeights('test')!;
      const failedBy = failingBefore - after.get(failing)!;
      const busiedBy = busyBefore - after.get(busy)!;
      assert.ok(busiedBy > 0, 'a busy peer still loses some weight');
      assert.ok(
        Math.abs(busiedBy - failedBy * 0.2) < 1e-9,
        `${busiedBy} is a fifth of ${failedBy}`,
      );
    });

    it('starts a new busy peer just below the default, not at the minimum', () => {
      const newPeer = 'http://busy-newpeer.com';
      peerManager.reportFailure('test', newPeer, 'busy');
      const weight = peerManager.getWeights('test')!.get(newPeer)!;
      assert.ok(weight > 1 && weight < 50, `${weight}`);
    });

    it('maps 429 and 503 to busy and everything else to failed', () => {
      assert.equal(peerFailureKindForStatus(429), 'busy');
      assert.equal(peerFailureKindForStatus(503), 'busy');
      for (const status of [404, 500, 502, 504, 401, undefined]) {
        assert.equal(peerFailureKindForStatus(status), 'failed');
      }
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

  describe('leaving-gateway filtering', () => {
    // Registry fixture mixing every status case, including the two that must
    // NOT be excluded: absent status, and an unrecognised value.
    /**
     * Build a manager whose registry returns `items` as a single page.
     *
     * The fixtures deliberately include gateways with no `status` and with an
     * unrecognised one, so the fail-open behaviour is exercised rather than
     * assumed.
     */
    function managerWith(items: any[]) {
      return new ArIOPeerManager({
        log,
        networkProcess: {
          getGateways: async () => ({
            items,
            hasMore: false,
            nextCursor: undefined,
          }),
        } as unknown as ARIORead,
        nodeWallet: 'localNode',
        initialCategories: ['test'],
        updatePeersRefreshIntervalMs: 3600000,
      });
    }

    const MIXED = [
      {
        gatewayAddress: 'joined1',
        status: 'joined',
        settings: { protocol: 'https', fqdn: 'joined1.com' },
      },
      {
        gatewayAddress: 'leaving1',
        status: 'leaving',
        settings: { protocol: 'https', fqdn: 'leaving1.com' },
      },
      {
        gatewayAddress: 'leaving2',
        status: 'leaving',
        settings: { protocol: 'http', fqdn: 'leaving2.com' },
      },
      {
        gatewayAddress: 'nostatus',
        settings: { protocol: 'https', fqdn: 'nostatus.com' },
      },
      {
        gatewayAddress: 'weird',
        status: 'someFutureStatus',
        settings: { protocol: 'https', fqdn: 'weird.com' },
      },
    ];

    it('excludes gateways the registry reports as leaving', async () => {
      const m = managerWith(MIXED);
      await m.refreshPeers();
      const urls = m.getPeerUrls();
      assert.ok(
        !urls.includes('https://leaving1.com'),
        'leaving1 must be excluded',
      );
      assert.ok(
        !urls.includes('http://leaving2.com'),
        'leaving2 must be excluded',
      );
      assert.ok(urls.includes('https://joined1.com'), 'joined must be kept');
      m.stopUpdatingPeers?.();
    });

    it('keeps gateways whose status is absent or unrecognised (fail open)', async () => {
      // The guard that matters: a registry or SDK that stops reporting status
      // must degrade to the old behaviour, never to an empty peer list.
      const m = managerWith(MIXED);
      await m.refreshPeers();
      const urls = m.getPeerUrls();
      assert.ok(
        urls.includes('https://nostatus.com'),
        'absent status must be kept',
      );
      assert.ok(
        urls.includes('https://weird.com'),
        'unknown status must be kept',
      );
      m.stopUpdatingPeers?.();
    });

    it('does not empty the peer list when no gateway reports a status', async () => {
      const m = managerWith([
        { gatewayAddress: 'a', settings: { protocol: 'https', fqdn: 'a.com' } },
        { gatewayAddress: 'b', settings: { protocol: 'https', fqdn: 'b.com' } },
      ]);
      await m.refreshPeers();
      assert.equal(m.getPeerUrls().length, 2);
      m.stopUpdatingPeers?.();
    });

    it('still excludes our own wallet regardless of status', async () => {
      const m = managerWith([
        {
          gatewayAddress: 'localNode',
          status: 'joined',
          settings: { protocol: 'https', fqdn: 'self.com' },
        },
        {
          gatewayAddress: 'other',
          status: 'joined',
          settings: { protocol: 'https', fqdn: 'other.com' },
        },
      ]);
      await m.refreshPeers();
      const urls = m.getPeerUrls();
      assert.ok(
        !urls.includes('https://self.com'),
        'own wallet must stay excluded',
      );
      assert.ok(urls.includes('https://other.com'));
      m.stopUpdatingPeers?.();
    });

    it('keeps our own registry entry apart, for the peer list to report as self', async () => {
      const m = managerWith([
        {
          gatewayAddress: 'localNode',
          observerAddress: 'localObserver',
          operatorStake: 20000,
          status: 'joined',
          settings: { protocol: 'https', fqdn: 'self.com' },
        },
        {
          gatewayAddress: 'other',
          status: 'joined',
          settings: { protocol: 'https', fqdn: 'other.com' },
        },
      ]);
      await m.refreshPeers();
      assert.deepEqual(m.getSelfRecord(), {
        url: 'https://self.com',
        wallet: 'localNode',
        observerAddress: 'localObserver',
        operatorStake: 20000,
        status: 'joined',
      });
      assert.ok(!m.getPeerUrls().includes('https://self.com'));
      m.stopUpdatingPeers?.();
    });

    it('has no own entry when its wallet is not registered', async () => {
      const m = managerWith([
        {
          gatewayAddress: 'other',
          status: 'joined',
          settings: { protocol: 'https', fqdn: 'other.com' },
        },
      ]);
      await m.refreshPeers();
      assert.equal(m.getSelfRecord(), undefined);
      m.stopUpdatingPeers?.();
    });
  });

  describe('a registry read that fails', () => {
    it('keeps the peer list it had rather than emptying it', async () => {
      let fail = false;
      const m = new ArIOPeerManager({
        log,
        networkProcess: {
          getGateways: async () => {
            if (fail) throw new Error('RPC unavailable');
            return {
              items: [
                {
                  gatewayAddress: 'a',
                  status: 'joined',
                  settings: { protocol: 'https', fqdn: 'a.com' },
                },
                {
                  gatewayAddress: 'b',
                  status: 'joined',
                  settings: { protocol: 'https', fqdn: 'b.com' },
                },
              ],
              hasMore: false,
              nextCursor: undefined,
            };
          },
        } as unknown as ARIORead,
        nodeWallet: 'localNode',
        initialCategories: ['test'],
        updatePeersRefreshIntervalMs: 3600000,
      });
      await m.refreshPeers();
      assert.equal(m.getPeerUrls().length, 2);

      const fields = (formatted: ReturnType<typeof m.getFormattedPeers>) =>
        Object.values(formatted)
          .map((p) => ({ url: p.url, wallet: p.wallet, status: p.status }))
          .sort((x, y) => x.url.localeCompare(y.url));
      const before = fields(m.getFormattedPeers(['test']));
      assert.equal(before.length, 2);
      assert.ok(before.every((p) => p.wallet !== undefined));

      fail = true;
      await m.refreshPeers();
      assert.equal(
        m.getPeerUrls().length,
        2,
        'a failed refresh must not replace the peers with nothing',
      );
      assert.deepEqual(
        fields(m.getFormattedPeers(['test'])),
        before,
        'nor the registry fields served alongside them',
      );
      m.stopUpdatingPeers?.();
    });
  });

  describe('registry fields', () => {
    it('carries each peer’s wallet, observer, stake and status from the same read', async () => {
      const m = new ArIOPeerManager({
        log,
        networkProcess: {
          getGateways: async () => ({
            items: [
              {
                gatewayAddress: 'wallet-a',
                observerAddress: 'observer-a',
                operatorStake: 50_000_000_000,
                status: 'joined',
                settings: { protocol: 'https', fqdn: 'a.com' },
              },
              {
                gatewayAddress: 'wallet-b',
                settings: { protocol: 'https', fqdn: 'b.com' },
              },
            ],
            hasMore: false,
            nextCursor: undefined,
          }),
        } as unknown as ARIORead,
        nodeWallet: 'localNode',
        initialCategories: ['data'],
        updatePeersRefreshIntervalMs: 3600000,
      });
      await m.refreshPeers();
      const peers = m.getFormattedPeers(['data']);
      assert.deepEqual(
        { ...peers['a.com:443'], weights: undefined },
        {
          wallet: 'wallet-a',
          observerAddress: 'observer-a',
          operatorStake: 50_000_000_000,
          status: 'joined',
          url: 'https://a.com',
          weights: undefined,
        },
      );
      // A registry that omits fields yields a peer without them, not a broken one.
      assert.equal(peers['b.com:443'].wallet, 'wallet-b');
      assert.equal(peers['b.com:443'].observerAddress, undefined);
      m.stopUpdatingPeers?.();
    });
  });

  describe('peer list cache and empty-list retry', () => {
    let dir: string;
    let cachePath: string;
    const managers: ArIOPeerManager[] = [];

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-io-peer-manager-'));
      cachePath = path.join(dir, 'peers', 'ar-io-peers.json');
    });

    afterEach(() => {
      for (const m of managers.splice(0)) m.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const gateway = (wallet: string, fqdn: string, status?: string) => ({
      gatewayAddress: wallet,
      ...(status !== undefined ? { status } : {}),
      settings: { protocol: 'https', fqdn },
    });

    /** A registry whose reads fail until `up` is set, then return `items`. */
    function registry(items: any[]) {
      const state = { up: false, calls: 0 };
      const networkProcess = {
        getGateways: async () => {
          state.calls++;
          if (!state.up) throw new Error('registry unreachable');
          return { items, hasMore: false, nextCursor: undefined };
        },
      } as unknown as ARIORead;
      return { state, networkProcess };
    }

    function manager(
      networkProcess: ARIORead,
      extra: Record<string, unknown> = {},
    ) {
      const m = new ArIOPeerManager({
        log,
        networkProcess,
        nodeWallet: 'localNode',
        peerListCachePath: cachePath,
        updatePeersRefreshIntervalMs: 3600000,
        // Keep the breaker out of the way: these tests are about the list.
        circuitBreakerOptions: {
          timeout: false,
          errorThresholdPercentage: 100,
        },
        ...extra,
      });
      managers.push(m);
      return m;
    }

    async function waitFor(condition: () => boolean, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    it('saves a successful read and restores it when the registry is down at the next start', async () => {
      const up = registry([
        gateway('w1', 'one.com', 'joined'),
        gateway('w2', 'two.com'),
        gateway('localNode', 'me.com', 'joined'),
      ]);
      up.state.up = true;
      const first = manager(up.networkProcess);
      await first.refreshPeers();
      await waitFor(() => fs.existsSync(cachePath));

      const down = registry([]);
      const second = manager(down.networkProcess);
      assert.deepEqual(second.getPeerUrls().sort(), [
        'https://one.com',
        'https://two.com',
      ]);
      assert.equal(second.getSelfRecord()?.url, 'https://me.com');
      assert.equal(
        second.getFormattedPeers(['data'])['one.com:443'].status,
        'joined',
      );
      await second.refreshPeers();
      assert.ok(down.state.calls > 0);
      assert.equal(
        second.getPeerUrls().length,
        2,
        'the failed read keeps the restored list',
      );
    });

    it('re-filters a saved list: own wallet, a self for another wallet, leaving gateways', async () => {
      await writePeerListSnapshot(cachePath, {
        writtenAt: Date.now(),
        peers: {
          w1: 'https://one.com',
          localNode: 'https://me.com',
          gone: 'https://gone.com',
        },
        records: {
          w1: { wallet: 'w1' },
          gone: { wallet: 'gone', status: 'leaving' },
        },
        self: { wallet: 'previousWallet', url: 'https://old-me.com' },
      });
      const m = manager(registry([]).networkProcess);
      assert.deepEqual(m.getPeerUrls(), ['https://one.com']);
      assert.equal(m.getSelfRecord(), undefined);
    });

    it('retries quickly while the list is empty, then stops once a read succeeds', async () => {
      const r = registry([gateway('w1', 'one.com')]);
      const m = manager(r.networkProcess, {
        emptyListRetryInitialMs: 10,
        emptyListRetryMaxMs: 40,
      });
      await waitFor(() => r.state.calls >= 3);
      assert.equal(m.getPeerUrls().length, 0);

      r.state.up = true;
      await waitFor(() => m.getPeerUrls().length === 1);
      const calls = r.state.calls;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(r.state.calls, calls, 'no retries once peers are known');
      await waitFor(() => fs.existsSync(cachePath));
    });

    it('does not retry when a failed read leaves a restored list in place', async () => {
      await writePeerListSnapshot(cachePath, {
        writtenAt: Date.now() - 48 * 60 * 60 * 1000,
        peers: { w1: 'https://one.com' },
        records: {},
      });
      const r = registry([]);
      const m = manager(r.networkProcess, { emptyListRetryInitialMs: 10 });
      await waitFor(() => r.state.calls > 0);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(r.state.calls, 1);
      assert.deepEqual(
        m.getPeerUrls(),
        ['https://one.com'],
        'a stale list is still used',
      );
    });

    it('treats a registry read with no gateways like a failure', async () => {
      await writePeerListSnapshot(cachePath, {
        writtenAt: 1,
        peers: { w1: 'https://one.com' },
        records: {},
      });
      const before = fs.readFileSync(cachePath, 'utf8');
      const r = registry([]);
      r.state.up = true;
      const m = manager(r.networkProcess, { emptyListRetryInitialMs: 10 });
      await m.refreshPeers();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(m.getPeerUrls(), ['https://one.com'], 'list kept');
      assert.equal(fs.readFileSync(cachePath, 'utf8'), before, 'file kept');
      // refreshPeers joined the constructor's read, and nothing retried it.
      assert.equal(r.state.calls, 1, 'no retry while a list is in place');
    });

    it('retries an empty registry read when it has no list', async () => {
      const r = registry([]);
      r.state.up = true;
      manager(r.networkProcess, {
        emptyListRetryInitialMs: 10,
        emptyListRetryMaxMs: 10,
      });
      await waitFor(() => r.state.calls >= 3);
    });

    it('applies a read whose gateways were all filtered out', async () => {
      const r = registry([
        gateway('gone', 'gone.com', 'leaving'),
        gateway('localNode', 'me.com'),
      ]);
      r.state.up = true;
      await writePeerListSnapshot(cachePath, {
        writtenAt: 1,
        peers: { gone: 'https://gone.com' },
        records: {},
      });
      const m = manager(r.networkProcess);
      await m.refreshPeers();
      assert.deepEqual(m.getPeerUrls(), []);
      assert.equal(m.getSelfRecord()?.url, 'https://me.com');
    });

    it('shares one registry read between overlapping callers', async () => {
      let release: () => void = () => undefined;
      let calls = 0;
      const m = manager({
        getGateways: async () => {
          calls++;
          await new Promise<void>((resolve) => (release = resolve));
          return {
            items: [gateway('w1', 'one.com')],
            hasMore: false,
            nextCursor: undefined,
          };
        },
      } as unknown as ARIORead);
      // The constructor's read is in flight; these join it.
      const a = m.refreshPeers();
      const b = m.refreshPeers();
      release();
      await Promise.all([a, b]);
      assert.equal(calls, 1);
      assert.deepEqual(m.getPeerUrls(), ['https://one.com']);
    });

    it('removes temporary files a crash left behind', async () => {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const leftover = `${cachePath}.123.456.tmp`;
      const unrelated = path.join(path.dirname(cachePath), 'other.tmp');
      fs.writeFileSync(leftover, '{');
      fs.writeFileSync(unrelated, 'x');
      manager(registry([]).networkProcess);
      assert.equal(fs.existsSync(leftover), false);
      assert.equal(fs.existsSync(unrelated), true);
    });

    it('does not schedule a retry when a read in flight at shutdown fails', async () => {
      let fail: (error: Error) => void = () => undefined;
      let calls = 0;
      const m = manager(
        {
          getGateways: () => {
            calls++;
            return new Promise((_resolve, reject) => (fail = reject));
          },
        } as unknown as ARIORead,
        { emptyListRetryInitialMs: 10 },
      );
      // The stop system.ts makes. Not shutdown(): that also closes the
      // breaker, which would refuse a retry's call before it reached the
      // registry and hide one being scheduled.
      m.stopUpdatingPeers();
      fail(new Error('registry unreachable'));
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(calls, 1);
    });

    it('stops a pending retry on shutdown', async () => {
      const r = registry([]);
      const m = manager(r.networkProcess, { emptyListRetryInitialMs: 30 });
      await waitFor(() => r.state.calls === 1);
      m.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(r.state.calls, 1);
    });
  });
});
