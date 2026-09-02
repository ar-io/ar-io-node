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

const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_WEIGHT = 50; // Neutral starting weight
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 100;
const DEFAULT_SELECTION_CACHE_TTL_MS = 5000; // 5 seconds

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

export interface FormattedPeer {
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
  private intervalId?: NodeJS.Timeout;

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
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
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
      this.updatePeerList();
      this.intervalId = setInterval(
        this.updatePeerList.bind(this),
        this.updatePeersRefreshIntervalMs,
      );
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

    // Sort home set by weight (highest first)
    const rankedHomeSet = homeSet.sort((a, b) => {
      const weightA = categoryWeights?.get(a) ?? DEFAULT_WEIGHT;
      const weightB = categoryWeights?.get(b) ?? DEFAULT_WEIGHT;
      return weightB - weightA;
    });

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
  reportFailure(category: WeightCategory, peerId: string): void {
    const categoryWeights = this.peerWeights.get(category);
    if (!categoryWeights) {
      this.registerCategory(category);
      return this.reportFailure(category, peerId);
    }

    const currentWeight = categoryWeights.get(peerId);
    if (currentWeight === undefined) {
      // Peer not in this category yet, initialize it with low weight
      categoryWeights.set(peerId, MIN_WEIGHT);
      return;
    }

    const categoryConfig = this.categoryConfigs.get(category) ?? {};
    const temperatureDelta =
      categoryConfig.temperatureDelta ??
      config.WEIGHTED_PEERS_TEMPERATURE_DELTA;

    // Cool down the failing peer
    categoryWeights.set(
      peerId,
      Math.max(currentWeight - temperatureDelta, MIN_WEIGHT),
    );
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

  /**
   * Get peers formatted as host:port keys with weights for specified categories
   * @param categories - Array of weight categories to include
   * @returns Record of host:port to peer info with weights
   */
  getFormattedPeers(
    categories: WeightCategory[],
  ): Record<string, FormattedPeer> {
    const peers: Record<string, FormattedPeer> = {};

    for (const [_walletAddress, url] of Object.entries(this.getPeers())) {
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
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
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
   * than emptying it.
   */
  private async updatePeerList(): Promise<void> {
    const log = this.log.child({ method: 'updatePeerList' });
    log.info('Fetching AR.IO network peer list');

    const peers: Record<string, string> = {};
    const skipLeaving = config.SKIP_LEAVING_GATEWAYS;
    let skippedLeaving = 0;
    let cursor: string | undefined;
    do {
      try {
        const { nextCursor, items } =
          await this.arioGatewaysCircuitBreaker.fire({
            cursor,
            limit: 1000,
          });

        for (const gateway of items) {
          // skip our own node wallet
          if (
            this.nodeWallet !== undefined &&
            this.nodeWallet === gateway.gatewayAddress
          ) {
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
        break;
      }
    } while (cursor !== undefined);

    log.info('Successfully fetched AR.IO network peer list', {
      count: Object.keys(peers).length,
      skippedLeaving,
      skipLeavingEnabled: skipLeaving,
    });
    metrics.arIOPeersSkippedLeavingTotal.inc(skippedLeaving);

    const oldPeers = this.peers;
    this.peers = peers;
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
}
