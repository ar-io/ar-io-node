/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { AoARIORead } from '@ar.io/sdk';
import CircuitBreaker from 'opossum';
import memoize from 'memoizee';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import { shuffleArray } from '../lib/random.js';

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

interface WeightCategoryConfig {
  defaultWeight?: number;
  temperatureDelta?: number;
  cacheTtlMs?: number;
}

export class ArIOPeerManager {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private updatePeersRefreshIntervalMs: number;
  private networkProcess: AoARIORead;
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

  // Cached peer selections per category
  private selectPeersCache: ReturnType<typeof memoize>;

  // circuit breaker for getGateways
  private arioGatewaysCircuitBreaker: CircuitBreaker<
    Parameters<AoARIORead['getGateways']>,
    Awaited<ReturnType<AoARIORead['getGateways']>>
  >;

  constructor({
    log,
    networkProcess,
    nodeWallet,
    initialPeers,
    initialCategories,
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
    networkProcess: AoARIORead;
    nodeWallet?: string;
    initialPeers?: Record<string, string>;
    initialCategories?: WeightCategory[];
    updatePeersRefreshIntervalMs?: number;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
    this.networkProcess = networkProcess;

    this.arioGatewaysCircuitBreaker = new CircuitBreaker(
      this.networkProcess.getGateways.bind(this.networkProcess),
      {
        ...circuitBreakerOptions,
        capacity: 1, // only allow one request at a time
        name: 'getGateways',
      },
    );

    // TODO: more efficient normalizer

    // Initialize memoized peer selection cache
    this.selectPeersCache = memoize(this._selectPeersUncached.bind(this), {
      primitive: true,
      maxAge: DEFAULT_SELECTION_CACHE_TTL_MS,
      normalizer: (args) => {
        // Cache key is: category:count:weightsHash
        const [category, count] = args;
        const weights = this.peerWeights.get(category);
        if (!weights) return `${category}:${count}:empty`;

        // Create a simple hash of weights for cache invalidation
        const weightsHash = Array.from(weights.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, w]) => `${id}:${w}`)
          .join(',');

        return `${category}:${count}:${weightsHash}`;
      },
    });

    // Initialize with provided peers or start fetching from network
    if (initialPeers) {
      this.peers = initialPeers;
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
   * Stop updating the peer list
   */
  stopUpdatingPeers(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Force an immediate update of the peer list
   */
  async refreshPeers(): Promise<void> {
    await this.updatePeerList();
  }

  private async updatePeerList(): Promise<void> {
    const log = this.log.child({ method: 'updatePeerList' });
    log.info('Fetching AR.IO network peer list');

    const peers: Record<string, string> = {};
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
    });

    const oldPeers = this.peers;
    this.peers = peers;

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
