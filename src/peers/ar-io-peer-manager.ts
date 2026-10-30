/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { ARIORead } from '@ar.io/sdk';
import CircuitBreaker from 'opossum';
import memoize from 'memoizee';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { WithFormattedPeers } from '../types.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import { shuffleArray } from '../lib/random.js';
import { PeerHashRing } from '../data/peer-hash-ring.js';
import {
  PeerListSnapshot,
  PeerRegistryRecord,
  readPeerListSnapshot,
  removeStalePeerListTempFiles,
  writePeerListSnapshot,
} from './peer-list-cache.js';

const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_WEIGHT = 50; // Neutral starting weight
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 100;
const DEFAULT_SELECTION_CACHE_TTL_MS = 5000; // 5 seconds
// How often weights decay toward their category default.
const DECAY_INTERVAL_MS = 60_000;
// A busy peer (429, 503) loses this fraction of a full failure's weight: it
// has the data, or may, and will again have the capacity, unlike a peer that
// lacks it or is broken.
const BUSY_PENALTY_FRACTION = 0.2;

/**
 * Why a peer request failed, for weighting. `busy`: the peer said it is out
 * of capacity (429, 503), which passes. `failed`: anything else, including
 * not having the data.
 */
export type PeerFailureKind = 'failed' | 'busy';

/** The failure kind an HTTP status from a peer stands for. */
export function peerFailureKindForStatus(
  status: number | undefined,
): PeerFailureKind {
  return status === 429 || status === 503 ? 'busy' : 'failed';
}
// While the peer list is empty, a failed registry read is retried after this
// delay, doubling up to the maximum, instead of waiting for the hourly refresh.
const DEFAULT_EMPTY_LIST_RETRY_INITIAL_MS = 10_000;
const DEFAULT_EMPTY_LIST_RETRY_MAX_MS = 300_000;
// A cached peer list older than this is still used, with a warning.
const PEER_LIST_CACHE_STALE_WARN_MS = 24 * 60 * 60 * 1000;

export interface ArIOPeer {
  address: string;
  url: string;
}

export interface PeerSuccessMetrics {
  responseTimeMs?: number;
  kbps?: number;
  ttfb?: number;
}

export type WeightCategory = 'data' | 'chunk' | string;

export type { PeerRegistryRecord };

export interface FormattedPeer extends Partial<PeerRegistryRecord> {
  url: string;
  weights: Record<WeightCategory, number>;
}

interface WeightCategoryConfig {
  defaultWeight?: number;
  temperatureDelta?: number;
  cacheTtlMs?: number;
}

export class ArIOPeerManager implements WithFormattedPeers {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private updatePeersRefreshIntervalMs: number;
  private networkProcess: ARIORead;
  private peers: Record<string, string> = {};
  /** Registry fields for each peer, by wallet; replaced with `peers`. */
  private records: Record<string, PeerRegistryRecord> = {};
  /**
   * This node's own registry entry. It is never a peer, but a fleet node
   * that subscribes to its own fleet's index publication resolves the
   * publisher, its own wallet, through the peer list's `self`.
   */
  private self: (PeerRegistryRecord & { url: string }) | undefined;
  private intervalId?: NodeJS.Timeout;
  private decayIntervalId?: NodeJS.Timeout;
  /** Where the last fetched peer list is kept; undefined disables it. */
  private peerListCachePath: string | undefined;
  private emptyListRetryInitialMs: number;
  private emptyListRetryMaxMs: number;
  private nextEmptyListRetryMs: number;
  private emptyListRetryTimeout?: NodeJS.Timeout;
  private inFlightRead?: Promise<void>;
  /** Set by stopUpdatingPeers: a read still in flight must not reschedule. */
  private updatesStopped = false;

  // Weight management per category
  private peerWeights: Map<WeightCategory, Map<string, number>> = new Map();
  private categoryConfigs: Map<WeightCategory, WeightCategoryConfig> =
    new Map();

  // Performance tracking per category
  private categoryMetrics: Map<
    WeightCategory,
    {
      previousResponseTimes: number[];
      previousKbps?: number[];
      previousTtfb?: number[];
    }
  > = new Map();

  // Consistent hash ring for cache-locality peer selection
  private hashRing: PeerHashRing;
  private hashRingHomeSetSize: number;

  // Cached peer selections per category
  private selectPeersCache: ReturnType<typeof memoize>;

  // circuit breaker for getGateways
  private arioGatewaysCircuitBreaker: CircuitBreaker<
    Parameters<ARIORead['getGateways']>,
    Awaited<ReturnType<ARIORead['getGateways']>>
  >;

  constructor({
    log,
    networkProcess,
    nodeWallet,
    initialPeers,
    initialCategories,
    hashRingVirtualNodes = config.PEER_HASH_RING_VIRTUAL_NODES,
    hashRingHomeSetSize = config.PEER_HASH_RING_HOME_SET_SIZE,
    updatePeersRefreshIntervalMs = DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS,
    weightDecayHalfLifeMs = config.PEER_WEIGHT_DECAY_HALF_LIFE_MS,
    peerListCachePath,
    emptyListRetryInitialMs = DEFAULT_EMPTY_LIST_RETRY_INITIAL_MS,
    emptyListRetryMaxMs = DEFAULT_EMPTY_LIST_RETRY_MAX_MS,
    circuitBreakerOptions = {
      timeout: config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    networkProcess: ARIORead;
    nodeWallet?: string;
    initialPeers?: Record<string, string>;
    initialCategories?: WeightCategory[];
    hashRingVirtualNodes?: number;
    hashRingHomeSetSize?: number;
    updatePeersRefreshIntervalMs?: number;
    /** Half-life of a weight's distance from its default; 0 disables. */
    weightDecayHalfLifeMs?: number;
    /**
     * File the peer list is saved to after each successful registry read and
     * loaded from at startup, so a restart while the registry is unreachable
     * keeps the previous peers. Undefined or empty disables it (the
     * AR_IO_PEER_LIST_CACHE_PATH setting always supplies a path).
     */
    peerListCachePath?: string;
    emptyListRetryInitialMs?: number;
    emptyListRetryMaxMs?: number;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
    this.peerListCachePath =
      peerListCachePath !== undefined && peerListCachePath !== ''
        ? peerListCachePath
        : undefined;
    this.emptyListRetryInitialMs = emptyListRetryInitialMs;
    this.emptyListRetryMaxMs = emptyListRetryMaxMs;
    this.nextEmptyListRetryMs = emptyListRetryInitialMs;
    this.networkProcess = networkProcess;
    this.hashRing = new PeerHashRing(hashRingVirtualNodes);
    this.hashRingHomeSetSize = hashRingHomeSetSize;

    this.arioGatewaysCircuitBreaker = new CircuitBreaker(
      this.networkProcess.getGateways.bind(this.networkProcess),
      {
        ...circuitBreakerOptions,
        capacity: 1, // only allow one request at a time
        name: 'getGateways',
      },
    );

    // Initialize memoized peer selection cache
    this.selectPeersCache = memoize(this._selectPeersUncached.bind(this), {
      primitive: true,
      maxAge: DEFAULT_SELECTION_CACHE_TTL_MS,
      normalizer: (args) => {
        // Cache key format: category:requestedCount:totalPeerCount
        // - requestedCount: number of peers to select
        // - totalPeerCount: total peers available in category (for cache invalidation)
        const [category, count] = args;
        const weights = this.peerWeights.get(category);
        const peerCount = weights?.size ?? 0;

        return `${category}:${count}:${peerCount}`;
      },
    });

    // Initialize with provided peers or start fetching from network
    if (initialPeers) {
      this.peers = initialPeers;
      this.hashRing.rebuild(Object.values(initialPeers));
      // Initialize provided categories with the provided peers
      if (initialCategories) {
        for (const category of initialCategories) {
          this.registerCategory(category);
        }
      }
    } else {
      // Start from the saved list, if any, so peers are available while the
      // first registry read runs, and still there if it fails.
      this.loadPeerListCache();
      this.updatePeerList();
      this.intervalId = setInterval(
        this.updatePeerList.bind(this),
        this.updatePeersRefreshIntervalMs,
      );
    }

    if (weightDecayHalfLifeMs > 0) {
      const factor = 0.5 ** (DECAY_INTERVAL_MS / weightDecayHalfLifeMs);
      this.decayIntervalId = setInterval(
        () => this.decayWeights(factor),
        DECAY_INTERVAL_MS,
      );
      this.decayIntervalId.unref();
    }

    // TODO: Remove deprecated circuit breaker metrics setup
    metrics.circuitBreakerMetrics.add(this.arioGatewaysCircuitBreaker);
    metrics.setUpCircuitBreakerListenerMetrics(
      'ar-io-peer-manager',
      this.arioGatewaysCircuitBreaker,
      this.log,
    );
  }

  /**
   * Register a new weight category with optional configuration
   */
  registerCategory(
    category: WeightCategory,
    configOverrides?: WeightCategoryConfig,
  ): void {
    if (!this.categoryConfigs.has(category)) {
      this.categoryConfigs.set(category, {
        defaultWeight: configOverrides?.defaultWeight ?? DEFAULT_WEIGHT,
        temperatureDelta:
          configOverrides?.temperatureDelta ??
          config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
        cacheTtlMs:
          configOverrides?.cacheTtlMs ?? DEFAULT_SELECTION_CACHE_TTL_MS,
      });
      this.initializeCategoryWeights(category);
    }
  }

  /**
   * Initialize weights for a category from current peer list
   */
  private initializeCategoryWeights(category: WeightCategory): void {
    const config = this.categoryConfigs.get(category) ?? {
      defaultWeight: DEFAULT_WEIGHT,
    };
    const categoryWeights = new Map<string, number>();

    for (const peerId of Object.values(this.peers)) {
      categoryWeights.set(peerId, config.defaultWeight ?? DEFAULT_WEIGHT);
    }

    this.peerWeights.set(category, categoryWeights);
  }

  /**
   * Select peers using category-specific weights
   */
  selectPeers(category: WeightCategory, count: number): string[] {
    // Ensure category exists
    if (!this.peerWeights.has(category)) {
      this.registerCategory(category);
    }

    // Use cached selection if available
    return this.selectPeersCache(category, count);
  }

  /**
   * Internal uncached peer selection
   */
  private _selectPeersUncached(
    category: WeightCategory,
    count: number,
  ): string[] {
    const log = this.log.child({ method: '_selectPeersUncached', category });

    const categoryWeights = this.peerWeights.get(category);
    if (!categoryWeights || categoryWeights.size === 0) {
      log.warn('No weighted peers available for category');
      throw new Error(`No weighted peers available for category: ${category}`);
    }

    const weightedPeersArray: WeightedElement<string>[] = Array.from(
      categoryWeights.entries(),
    ).map(([id, weight]) => ({ id, weight }));

    const selected = randomWeightedChoices<string>({
      table: weightedPeersArray,
      count,
    });

    return shuffleArray(selected);
  }

  /**
   * Select peers using hash ring home set + weighted fallback.
   * The home set provides cache locality; fallback fills remaining slots.
   */
  selectPeersForKey(
    category: WeightCategory,
    key: string,
    count: number,
  ): string[] {
    // Ensure category exists
    if (!this.peerWeights.has(category)) {
      this.registerCategory(category);
    }

    const categoryWeights = this.peerWeights.get(category);

    // Get home set from hash ring
    const homeSet = this.hashRing.getHomeSet(key, this.hashRingHomeSetSize);

    // Order the home set by a weighted draw without replacement
    // (Efraimidis-Spirakis: sort by random^(1/weight)), not strictly by
    // weight. Decay keeps weights in order as it pulls them to the default,
    // so under a strict sort a peer cooled during an outage stays behind its
    // healthy neighbours, and callers that try only the first few peers
    // (the chunk source) would never give it a first attempt. A drawn order
    // still favours heavier peers, rarely puts a peer near MIN_WEIGHT first,
    // and lets a peer that has decayed back toward the default win its share.
    const rankedHomeSet = homeSet
      .map((peer) => ({
        peer,
        key:
          Math.random() **
          (1 /
            Math.max(categoryWeights?.get(peer) ?? DEFAULT_WEIGHT, MIN_WEIGHT)),
      }))
      .sort((a, b) => b.key - a.key)
      .map(({ peer }) => peer);

    // Fill remaining slots with general weighted selection (exclude home set)
    const homeSetUrls = new Set(rankedHomeSet);
    const remaining = count - rankedHomeSet.length;

    if (remaining <= 0) {
      return rankedHomeSet.slice(0, count);
    }

    // Oversample to account for home set members that will be filtered out
    const fallback = this.selectPeers(
      category,
      remaining + homeSetUrls.size,
    ).filter((p) => !homeSetUrls.has(p));

    return [...rankedHomeSet, ...fallback].slice(0, count);
  }

  /**
   * Report successful peer interaction
   */
  reportSuccess(
    category: WeightCategory,
    peerId: string,
    metrics?: PeerSuccessMetrics,
  ): void {
    const categoryWeights = this.peerWeights.get(category);
    if (!categoryWeights) {
      this.registerCategory(category);
      return this.reportSuccess(category, peerId, metrics);
    }

    const currentWeight = categoryWeights.get(peerId);
    if (currentWeight === undefined) {
      // Peer not in this category yet, initialize it
      const config = this.categoryConfigs.get(category) ?? {
        defaultWeight: DEFAULT_WEIGHT,
      };
      categoryWeights.set(peerId, config.defaultWeight ?? DEFAULT_WEIGHT);
      return this.reportSuccess(category, peerId, metrics);
    }

    const categoryConfig = this.categoryConfigs.get(category) ?? {};
    const temperatureDelta =
      categoryConfig.temperatureDelta ??
      config.WEIGHTED_PEERS_TEMPERATURE_DELTA;

    // Calculate additional weight based on performance
    let additionalWeight = 0;

    if (metrics) {
      const categoryMetricsData = this.categoryMetrics.get(category) ?? {
        previousResponseTimes: [],
      };

      // Track response time if provided
      if (metrics.responseTimeMs !== undefined) {
        categoryMetricsData.previousResponseTimes.push(metrics.responseTimeMs);
        if (
          categoryMetricsData.previousResponseTimes.length >
          config.GATEWAY_PEERS_REQUEST_WINDOW_COUNT
        ) {
          categoryMetricsData.previousResponseTimes.shift();
        }

        const avgResponseTime =
          categoryMetricsData.previousResponseTimes.reduce((a, b) => a + b, 0) /
          categoryMetricsData.previousResponseTimes.length;

        if (metrics.responseTimeMs < avgResponseTime) {
          additionalWeight += temperatureDelta;
        }
      }

      // Track other metrics if provided
      if (metrics.kbps !== undefined) {
        if (!categoryMetricsData.previousKbps) {
          categoryMetricsData.previousKbps = [];
        }
        categoryMetricsData.previousKbps.push(metrics.kbps);
        if (
          categoryMetricsData.previousKbps.length >
          config.GATEWAY_PEERS_REQUEST_WINDOW_COUNT
        ) {
          categoryMetricsData.previousKbps.shift();
        }

        const avgKbps =
          categoryMetricsData.previousKbps.reduce((a, b) => a + b, 0) /
          categoryMetricsData.previousKbps.length;

        if (metrics.kbps > avgKbps) {
          additionalWeight += temperatureDelta;
        }
      }

      this.categoryMetrics.set(category, categoryMetricsData);
    }

    // Update weight
    categoryWeights.set(
      peerId,
      Math.min(currentWeight + temperatureDelta + additionalWeight, MAX_WEIGHT),
    );
  }

  /**
   * Report failed peer interaction
   */
  reportFailure(
    category: WeightCategory,
    peerId: string,
    kind: PeerFailureKind = 'failed',
  ): void {
    const categoryWeights = this.peerWeights.get(category);
    if (!categoryWeights) {
      this.registerCategory(category);
      return this.reportFailure(category, peerId, kind);
    }

    const categoryConfig = this.categoryConfigs.get(category) ?? {};
    const fullDelta =
      categoryConfig.temperatureDelta ??
      config.WEIGHTED_PEERS_TEMPERATURE_DELTA;
    // A busy peer is cooled by a fraction of a failure: one that is out of
    // capacity for a moment should not rank with one that lacks the data.
    const delta =
      kind === 'busy' ? fullDelta * BUSY_PENALTY_FRACTION : fullDelta;

    const currentWeight = categoryWeights.get(peerId);
    if (currentWeight === undefined) {
      // Peer not in this category yet: a failure starts it low, a busy
      // answer only a little below the category default.
      categoryWeights.set(
        peerId,
        kind === 'busy'
          ? Math.max(
              (categoryConfig.defaultWeight ?? DEFAULT_WEIGHT) - delta,
              MIN_WEIGHT,
            )
          : MIN_WEIGHT,
      );
      return;
    }

    // Cool down the failing peer
    categoryWeights.set(peerId, Math.max(currentWeight - delta, MIN_WEIGHT));
  }

  /**
   * Keeps `factor` of each weight's distance from its category default, so
   * weights drift back to the default with a half-life. A peer cooled during an outage regains its share of traffic
   * without first having to be picked and succeed, which its low weight made
   * unlikely; a good run fades the same way, so the weights track recent
   * behaviour rather than all of it.
   */
  decayWeights(factor: number): void {
    for (const [category, categoryWeights] of this.peerWeights) {
      const target =
        this.categoryConfigs.get(category)?.defaultWeight ?? DEFAULT_WEIGHT;
      for (const [peerId, weight] of categoryWeights) {
        categoryWeights.set(peerId, target + (weight - target) * factor);
      }
    }
  }

  /**
   * Get weights for a specific category
   */
  getWeights(category: WeightCategory): Map<string, number> | undefined {
    return this.peerWeights.get(category);
  }

  /**
   * Get the current list of peers
   * @returns Record of peer addresses to URLs
   */
  getPeers(): Record<string, string> {
    return { ...this.peers };
  }

  /**
   * Get a list of peer URLs
   * @returns Array of peer URLs
   */
  getPeerUrls(): string[] {
    return Object.values(this.peers);
  }

  /** This node's own registry entry, when its wallet is registered. */
  getSelfRecord(): (PeerRegistryRecord & { url: string }) | undefined {
    return this.self;
  }

  /**
   * Get peers formatted as host:port keys with weights for specified categories
   * @param categories - Array of weight categories to include
   * @returns Record of host:port to peer info with weights
   */
  getFormattedPeers(
    categories: WeightCategory[],
  ): Record<string, FormattedPeer> {
    const peers: Record<string, FormattedPeer> = {};

    for (const [walletAddress, url] of Object.entries(this.getPeers())) {
      try {
        const urlObj = new URL(url);
        const defaultPort = urlObj.protocol === 'https:' ? '443' : '80';
        const key =
          urlObj.hostname +
          (urlObj.port ? `:${urlObj.port}` : `:${defaultPort}`);

        const weights: Record<WeightCategory, number> = {};
        for (const category of categories) {
          const categoryWeights = this.peerWeights.get(category);
          weights[category] = categoryWeights?.get(url) ?? DEFAULT_WEIGHT;
        }

        peers[key] = {
          ...this.records[walletAddress],
          url: url,
          weights,
        };
      } catch (error) {
        // Skip if URL parsing fails
      }
    }

    return peers;
  }

  /**
   * Stop updating the peer list
   */
  stopUpdatingPeers(): void {
    this.updatesStopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.decayIntervalId) {
      clearInterval(this.decayIntervalId);
      this.decayIntervalId = undefined;
    }
    if (this.emptyListRetryTimeout) {
      clearTimeout(this.emptyListRetryTimeout);
      this.emptyListRetryTimeout = undefined;
    }
  }

  /**
   * Shutdown the peer manager and release all resources.
   * This stops peer updates and shuts down the circuit breaker.
   */
  shutdown(): void {
    this.stopUpdatingPeers();
    this.arioGatewaysCircuitBreaker.shutdown();
  }

  /**
   * Force an immediate update of the peer list
   */
  async refreshPeers(): Promise<void> {
    await this.updatePeerList();
  }

  /**
   * Read the registry, sharing a read already in flight. The circuit breaker
   * admits one read at a time and counts a rejected second one as a failure,
   * so overlapping callers (the interval, the empty-list retry, refreshPeers)
   * wait for the same read instead.
   */
  private updatePeerList(): Promise<void> {
    if (this.inFlightRead === undefined) {
      this.inFlightRead = this.readPeerList().finally(() => {
        this.inFlightRead = undefined;
      });
    }
    return this.inFlightRead;
  }

  /**
   * Refresh the peer pool from the AR.IO gateway registry.
   *
   * Pages through the registry, rebuilds the hash ring, and reconciles the
   * per-category weight maps so new peers start at the category default and
   * departed peers stop being selected.
   *
   * Two gateways are excluded: our own (by wallet), and any the registry
   * reports as `leaving`. A gateway leaves either because its operator
   * withdrew it or because the network marked it non-responsive for 30
   * consecutive epochs, so the status doubles as a consensus liveness signal.
   * Only an explicit `leaving` is filtered — see {@link
   * config.SKIP_LEAVING_GATEWAYS} for why unknown status is deliberately kept
   * — and exclusions are counted by `ar_io_peers_skipped_leaving_total`.
   *
   * A registry fetch failure leaves the previous peer list in place rather
   * than emptying it. If there is no previous list (a cold start with no
   * saved one), the read is retried with backoff instead of waiting for the
   * next hourly refresh. A successful read is saved to the peer list cache.
   */
  private async readPeerList(): Promise<void> {
    const log = this.log.child({ method: 'updatePeerList' });
    log.info('Fetching AR.IO network peer list');

    const peers: Record<string, string> = {};
    const records: Record<string, PeerRegistryRecord> = {};
    let self: (PeerRegistryRecord & { url: string }) | undefined;
    const skipLeaving = config.SKIP_LEAVING_GATEWAYS;
    let skippedLeaving = 0;
    let registryCount = 0;
    let cursor: string | undefined;
    let failed = false;
    do {
      try {
        const { nextCursor, items } =
          await this.arioGatewaysCircuitBreaker.fire({
            cursor,
            limit: 1000,
          });

        registryCount += items.length;
        for (const gateway of items) {
          // Our own node is never a peer, but its entry is kept apart.
          if (
            this.nodeWallet !== undefined &&
            this.nodeWallet === gateway.gatewayAddress
          ) {
            self = {
              url: `${gateway.settings.protocol}://${gateway.settings.fqdn}`,
              wallet: gateway.gatewayAddress,
              ...(typeof gateway.observerAddress === 'string'
                ? { observerAddress: gateway.observerAddress }
                : {}),
              ...(typeof gateway.operatorStake === 'number'
                ? { operatorStake: gateway.operatorStake }
                : {}),
              ...(typeof gateway.status === 'string'
                ? { status: gateway.status }
                : {}),
            };
            continue;
          }

          // Skip gateways the registry says are on their way out.
          //
          // A gateway leaves the network either because its operator withdrew
          // it or because the network marked it as non-responsive for 30
          // consecutive epochs. Either way it should no longer be receiving
          // requests, and the second case makes `leaving` a consensus signal
          // that the gateway is dead -- observed by the whole network rather
          // than rediscovered locally, one DNS timeout at a time.
          //
          // Measured on turbo-gateway gw1 (2026-08-28): 334 of 646 registered
          // gateways were `leaving`, and they accounted for the bulk of the
          // peer failures -- 40% of all peer errors were `ENOTFOUND` against
          // hostnames that no longer resolve.
          //
          // Deliberately excludes ONLY on an explicit 'leaving'. A gateway
          // whose status is absent or unrecognised is kept, so a registry or
          // SDK that does not report status degrades to the previous behaviour
          // rather than emptying the peer list.
          if (skipLeaving && gateway.status === 'leaving') {
            skippedLeaving++;
            continue;
          }

          peers[gateway.gatewayAddress] =
            `${gateway.settings.protocol}://${gateway.settings.fqdn}`;
          records[gateway.gatewayAddress] = {
            wallet: gateway.gatewayAddress,
            ...(typeof gateway.observerAddress === 'string'
              ? { observerAddress: gateway.observerAddress }
              : {}),
            ...(typeof gateway.operatorStake === 'number'
              ? { operatorStake: gateway.operatorStake }
              : {}),
            ...(typeof gateway.status === 'string'
              ? { status: gateway.status }
              : {}),
          };
        }
        cursor = nextCursor;
      } catch (error: any) {
        log.error(
          'Failed to fetch gateways from ARIO. Returning current peer list.',
          {
            message: error.message,
            stack: error.stack,
          },
        );
        failed = true;
        break;
      }
    } while (cursor !== undefined);

    // Keep what we had. Applying a failed read would replace the peer list
    // with the pages fetched before the error, which on a first-page failure
    // is nothing at all, and every peer-first retrieval would fail until the
    // next successful refresh.
    if (failed) {
      if (Object.keys(this.peers).length === 0) {
        this.scheduleEmptyListRetry();
      }
      return;
    }

    // A registry read that succeeds with no gateways at all is far more
    // likely a registry or SDK fault than an empty network, so it is treated
    // like a failure: keep what we have, and retry while that is nothing. (A
    // read whose gateways were all filtered out, ourselves or leaving, is
    // applied: that list really is empty.)
    if (registryCount === 0) {
      log.warn(
        'Gateway registry returned no gateways; keeping the current list',
        {
          currentCount: Object.keys(this.peers).length,
        },
      );
      if (Object.keys(this.peers).length === 0) {
        this.scheduleEmptyListRetry();
      }
      return;
    }
    this.nextEmptyListRetryMs = this.emptyListRetryInitialMs;

    log.info('Successfully fetched AR.IO network peer list', {
      count: Object.keys(peers).length,
      skippedLeaving,
      skipLeavingEnabled: skipLeaving,
    });
    metrics.arIOPeersSkippedLeavingTotal.inc(skippedLeaving);

    this.applyPeerList(peers, records, self);
    this.savePeerListCache({
      writtenAt: Date.now(),
      peers,
      records,
      ...(self !== undefined ? { self } : {}),
    });
  }

  /**
   * Replace the peer list: rebuild the hash ring and reconcile the
   * per-category weight maps, so new peers start at the category default and
   * departed peers stop being selected.
   */
  private applyPeerList(
    peers: Record<string, string>,
    records: Record<string, PeerRegistryRecord>,
    self: (PeerRegistryRecord & { url: string }) | undefined,
  ): void {
    const oldPeers = this.peers;
    this.peers = peers;
    this.records = records;
    this.self = self;
    this.hashRing.rebuild(Object.values(peers));

    // Update weights for all categories
    const newPeerUrls = new Set(Object.values(peers));
    const oldPeerUrls = new Set(Object.values(oldPeers));

    for (const [category, categoryWeights] of this.peerWeights) {
      const categoryConfig = this.categoryConfigs.get(category) ?? {
        defaultWeight: DEFAULT_WEIGHT,
      };

      // Remove peers that no longer exist
      for (const peerId of categoryWeights.keys()) {
        if (!newPeerUrls.has(peerId)) {
          categoryWeights.delete(peerId);
        }
      }

      // Add new peers with default weight
      for (const peerId of newPeerUrls) {
        if (!oldPeerUrls.has(peerId) && !categoryWeights.has(peerId)) {
          categoryWeights.set(
            peerId,
            categoryConfig.defaultWeight ?? DEFAULT_WEIGHT,
          );
        }
      }
    }
  }

  /**
   * Retry a failed registry read while the peer list is empty. One retry is
   * pending at a time; the delay doubles up to the maximum and resets on the
   * next successful read.
   */
  private scheduleEmptyListRetry(): void {
    if (this.updatesStopped || this.emptyListRetryTimeout !== undefined) {
      return;
    }
    const delayMs = this.nextEmptyListRetryMs;
    this.nextEmptyListRetryMs = Math.min(delayMs * 2, this.emptyListRetryMaxMs);
    this.log.warn('No AR.IO peers; retrying the registry read', { delayMs });
    this.emptyListRetryTimeout = setTimeout(() => {
      this.emptyListRetryTimeout = undefined;
      this.updatePeerList();
    }, delayMs);
    this.emptyListRetryTimeout.unref();
  }

  /**
   * Load the saved peer list, if there is one. It is re-filtered with the
   * current settings: our own wallet is never a peer (and a saved `self` for
   * a different wallet is dropped), and `leaving` gateways are skipped when
   * SKIP_LEAVING_GATEWAYS is on. A list of any age is used: stale peers mostly
   * still exist, and failures demote those that do not.
   */
  private loadPeerListCache(): void {
    if (this.peerListCachePath === undefined) return;
    const log = this.log.child({
      method: 'loadPeerListCache',
      path: this.peerListCachePath,
    });
    removeStalePeerListTempFiles(this.peerListCachePath);
    const snapshot = readPeerListSnapshot(this.peerListCachePath);
    if (snapshot === undefined) {
      log.info('No usable saved AR.IO peer list');
      return;
    }

    const skipLeaving = config.SKIP_LEAVING_GATEWAYS;
    const peers: Record<string, string> = {};
    const records: Record<string, PeerRegistryRecord> = {};
    for (const [wallet, url] of Object.entries(snapshot.peers)) {
      if (wallet === this.nodeWallet) continue;
      if (skipLeaving && snapshot.records[wallet]?.status === 'leaving') {
        continue;
      }
      peers[wallet] = url;
      if (snapshot.records[wallet] !== undefined) {
        records[wallet] = snapshot.records[wallet];
      }
    }
    const self =
      snapshot.self !== undefined && snapshot.self.wallet === this.nodeWallet
        ? snapshot.self
        : undefined;
    if (Object.keys(peers).length === 0 && self === undefined) {
      log.info('Saved AR.IO peer list is empty');
      return;
    }

    this.applyPeerList(peers, records, self);
    const ageMs = Date.now() - snapshot.writtenAt;
    const details = { count: Object.keys(peers).length, ageMs };
    if (ageMs > PEER_LIST_CACHE_STALE_WARN_MS) {
      log.warn('Loaded a stale saved AR.IO peer list', details);
    } else {
      log.info('Loaded saved AR.IO peer list', details);
    }
  }

  /** Save a fetched peer list. Failure is logged, never thrown. */
  private savePeerListCache(snapshot: PeerListSnapshot): void {
    if (this.peerListCachePath === undefined) return;
    const filePath = this.peerListCachePath;
    writePeerListSnapshot(filePath, snapshot).catch((error: any) => {
      this.log.warn('Failed to save AR.IO peer list', {
        method: 'savePeerListCache',
        path: filePath,
        message: error?.message,
      });
    });
  }
}
