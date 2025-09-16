/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import winston from 'winston';
import pLimit from 'p-limit';

import { DnsResolver } from '../lib/dns-resolver.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import * as metrics from '../metrics.js';
import * as config from '../config.js';

const DEFAULT_PEER_INFO_TIMEOUT_MS = 5000;
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TEMPERATURE_DELTA = 5;

/**
 * Represents an Arweave peer node with its metadata
 */
interface ArweavePeer {
  url: string; // Full URL of the peer (e.g., "http://peer1.example.com")
  blocks: number; // Number of blocks the peer has
  height: number; // Current height of the peer's chain
  lastSeen: number; // Timestamp of last successful contact
}

/**
 * Configuration options for ArweavePeerManager
 */
export interface ArweavePeerManagerConfig {
  log: winston.Logger;
  trustedNodeUrl: string; // URL to fetch peer list from
  preferredChunkGetUrls?: string[]; // Preferred peers for chunk GET operations
  preferredChunkPostUrls?: string[]; // Preferred peers for chunk POST operations
  ignoreUrls?: string[]; // Peers to ignore (from ARWEAVE_NODE_IGNORE_URLS)
  peerInfoTimeoutMs?: number; // Timeout for peer info requests
  refreshIntervalMs?: number; // How often to refresh peer list
  temperatureDelta?: number; // Weight adjustment on success/failure
  dnsResolver?: DnsResolver; // Optional DNS resolver for preferred URLs
}

/**
 * Categories of peer operations with different selection strategies
 */
export type ArweavePeerCategory = 'chain' | 'getChunk' | 'postChunk';

/**
 * Success metrics for a peer interaction
 */
export interface ArweavePeerSuccessMetrics {
  responseTimeMs?: number;
  kbps?: number; // For data transfer operations
  ttfb?: number; // Time to first byte
}

/**
 * Internal weighted element structure
 */
interface WeightedPeer {
  id: string; // Peer URL
  weight: number; // Weight for random selection (1-100)
}

type WeightedPeerListName =
  | 'weightedChainPeers'
  | 'weightedGetChunkPeers'
  | 'weightedPostChunkPeers';

export class ArweavePeerManager {
  private log: winston.Logger;
  private trustedNodeUrl: string;
  private peers: Record<string, ArweavePeer> = {};

  // Separate weighted lists for different operations
  private weightedChainPeers: WeightedElement<string>[] = [];
  private weightedGetChunkPeers: WeightedElement<string>[] = [];
  private weightedPostChunkPeers: WeightedElement<string>[] = [];

  // Preferred and resolved URLs
  private preferredChunkGetUrls: string[];
  private preferredChunkPostUrls: string[];
  private resolvedChunkGetUrls: string[] = [];
  private resolvedChunkPostUrls: string[] = [];

  // Configuration
  private ignoreUrls: string[];
  private peerInfoTimeoutMs: number;
  private refreshIntervalMs: number;
  private temperatureDelta: number;

  // Optional DNS resolver
  private dnsResolver?: DnsResolver;
  private dnsUpdateInterval?: NodeJS.Timeout;

  // Auto-refresh timer
  private refreshInterval?: NodeJS.Timeout;

  constructor(config: ArweavePeerManagerConfig) {
    this.log = config.log.child({ class: this.constructor.name });
    this.trustedNodeUrl = config.trustedNodeUrl;
    this.preferredChunkGetUrls = config.preferredChunkGetUrls || [];
    this.preferredChunkPostUrls = config.preferredChunkPostUrls || [];
    this.ignoreUrls = config.ignoreUrls || [];
    this.peerInfoTimeoutMs =
      config.peerInfoTimeoutMs ?? DEFAULT_PEER_INFO_TIMEOUT_MS;
    this.refreshIntervalMs =
      config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.temperatureDelta =
      config.temperatureDelta ?? DEFAULT_TEMPERATURE_DELTA;
    this.dnsResolver = config.dnsResolver;

    // Initialize preferred URLs
    this.initializePreferredUrls();
  }

  private initializePreferredUrls(): void {
    // Initialize GET chunk peers with resolved URLs
    if (this.dnsResolver && this.preferredChunkGetUrls.length > 0) {
      this.resolvedChunkGetUrls = [...this.preferredChunkGetUrls]; // Will be updated by DNS resolver
    } else {
      this.resolvedChunkGetUrls = [...this.preferredChunkGetUrls];
    }

    // Initialize POST chunk peers with resolved URLs
    if (this.dnsResolver && this.preferredChunkPostUrls.length > 0) {
      this.resolvedChunkPostUrls = [...this.preferredChunkPostUrls]; // Will be updated by DNS resolver
    } else {
      this.resolvedChunkPostUrls = [...this.preferredChunkPostUrls];
    }

    // Initialize weighted peer lists
    this.initializePreferredChunkGetUrls();
    this.initializePreferredChunkPostUrls();
  }

  private initializePreferredChunkGetUrls(): void {
    // Deduplicate and initialize weightedGetChunkPeers with resolved URLs at high weight
    const uniqueUrls = [...new Set(this.resolvedChunkGetUrls)];
    this.weightedGetChunkPeers = uniqueUrls.map((peerUrl) => ({
      id: peerUrl,
      weight: 100, // High weight for preferred chunk GET URLs
    }));

    // Log URL resolution for debugging
    if (this.dnsResolver && this.preferredChunkGetUrls.length > 0) {
      this.log.debug(
        'Initialized preferred chunk GET URLs with DNS resolution',
        {
          originalUrls: this.preferredChunkGetUrls.length,
          resolvedUrls: uniqueUrls.length,
          usingDefaults: this.preferredChunkGetUrls.some(
            (url) => url.includes('data-') && url.includes('.arweave.xyz'),
          ),
        },
      );
    }
  }

  private initializePreferredChunkPostUrls(): void {
    // Deduplicate and initialize weightedPostChunkPeers with resolved URLs at high weight
    const uniqueUrls = [...new Set(this.resolvedChunkPostUrls)];
    this.weightedPostChunkPeers = uniqueUrls.map((peerUrl) => ({
      id: peerUrl,
      weight: 100, // High weight for preferred chunk POST URLs
    }));

    // Log URL resolution for debugging
    if (this.dnsResolver && this.preferredChunkPostUrls.length > 0) {
      this.log.debug(
        'Initialized preferred chunk POST URLs with DNS resolution',
        {
          originalUrls: this.preferredChunkPostUrls.length,
          resolvedUrls: uniqueUrls.length,
          usingDefaults: this.preferredChunkPostUrls.some(
            (url) => url.includes('data-') && url.includes('.arweave.xyz'),
          ),
        },
      );
    }
  }

  /**
   * Initializes DNS resolution for preferred GET/POST URLs. Idempotent - safe to call multiple times.
   */
  async initializeDnsResolution(): Promise<void> {
    if (!this.dnsResolver) {
      return;
    }

    // Clear any existing timers to prevent orphaned intervals
    this.stopDnsResolution();

    const hasGetUrls = this.preferredChunkGetUrls.length > 0;
    const hasPostUrls = this.preferredChunkPostUrls.length > 0;

    if (!hasGetUrls && !hasPostUrls) {
      return;
    }

    const log = this.log.child({ method: 'initializeDnsResolution' });

    // Combine both GET and POST URLs for resolution
    const allUrls = [
      ...this.preferredChunkGetUrls,
      ...this.preferredChunkPostUrls,
    ];

    // Perform initial DNS resolution
    try {
      const resolvedUrls = await this.dnsResolver.resolveUrls(allUrls);
      this.updateResolvedUrls(resolvedUrls);

      log.debug('Initial DNS resolution completed', {
        originalCount: allUrls.length,
        resolvedCount: Object.keys(resolvedUrls).length,
      });
    } catch (error: any) {
      log.warn('Initial DNS resolution failed, using original URLs', {
        error: error.message,
      });
    }

    // Set up periodic DNS updates
    this.dnsUpdateInterval = setInterval(
      async () => {
        try {
          const resolvedUrls = await this.dnsResolver!.resolveUrls(allUrls);
          this.updateResolvedUrls(resolvedUrls);

          log.debug('Periodic DNS resolution completed', {
            originalCount: allUrls.length,
            resolvedCount: Object.keys(resolvedUrls).length,
          });
        } catch (error: any) {
          log.warn('Periodic DNS resolution failed', {
            error: error.message,
          });
        }
      },
      5 * 60 * 1000,
    ); // Update every 5 minutes
  }

  private updateResolvedUrls(resolvedUrls: Record<string, string[]>): void {
    // Update resolved GET URLs
    this.resolvedChunkGetUrls = [];
    for (const originalUrl of this.preferredChunkGetUrls) {
      const resolved = resolvedUrls[originalUrl];
      if (resolved !== undefined && resolved.length > 0) {
        this.resolvedChunkGetUrls.push(...resolved);
      } else {
        this.resolvedChunkGetUrls.push(originalUrl);
      }
    }

    // Update resolved POST URLs
    this.resolvedChunkPostUrls = [];
    for (const originalUrl of this.preferredChunkPostUrls) {
      const resolved = resolvedUrls[originalUrl];
      if (resolved !== undefined && resolved.length > 0) {
        this.resolvedChunkPostUrls.push(...resolved);
      } else {
        this.resolvedChunkPostUrls.push(originalUrl);
      }
    }

    // Re-initialize weighted lists with new resolved URLs
    this.initializePreferredChunkGetUrls();
    this.initializePreferredChunkPostUrls();
  }

  /**
   * Stop DNS resolution updates
   */
  stopDnsResolution(): void {
    if (this.dnsUpdateInterval) {
      clearInterval(this.dnsUpdateInterval);
      this.dnsUpdateInterval = undefined;
    }
  }

  /**
   * Get all known peers
   */
  getPeers(): Record<string, ArweavePeer> {
    return this.peers;
  }

  /**
   * Select weighted random peers for an operation
   */
  selectPeers(category: ArweavePeerCategory, count: number): string[] {
    const log = this.log.child({ method: 'selectPeers', category });

    const peerListName = this.getPeerListName(category);
    const peerList = this[peerListName];

    if (peerList.length === 0) {
      log.debug('No weighted peers available');
      return [];
    }

    return randomWeightedChoices<string>({
      table: peerList,
      count,
    });
  }

  private getPeerListName(category: ArweavePeerCategory): WeightedPeerListName {
    switch (category) {
      case 'chain':
        return 'weightedChainPeers';
      case 'getChunk':
        return 'weightedGetChunkPeers';
      case 'postChunk':
        return 'weightedPostChunkPeers';
      default:
        throw new Error(`Unknown peer category: ${category}`);
    }
  }

  /**
   * Report successful interaction with a peer
   */
  reportSuccess(
    category: ArweavePeerCategory,
    peerUrl: string,
    metrics?: ArweavePeerSuccessMetrics,
  ): void {
    if (metrics?.responseTimeMs !== undefined) {
      this.log.debug('Peer success reported', {
        category,
        peerUrl,
        responseTimeMs: metrics.responseTimeMs,
      });
    }

    const peerListName = this.getPeerListName(category);
    const peerList = this[peerListName];

    // Warm the succeeding peer
    peerList.forEach((weightedPeer) => {
      if (weightedPeer.id === peerUrl) {
        weightedPeer.weight = Math.min(
          weightedPeer.weight + this.temperatureDelta,
          100,
        );
      }
    });
  }

  /**
   * Report failed interaction with a peer
   */
  reportFailure(category: ArweavePeerCategory, peerUrl: string): void {
    this.log.debug('Peer failure reported', {
      category,
      peerUrl,
    });

    const peerListName = this.getPeerListName(category);
    const peerList = this[peerListName];

    // Cool the failing peer
    peerList.forEach((weightedPeer) => {
      if (weightedPeer.id === peerUrl) {
        weightedPeer.weight = Math.max(
          weightedPeer.weight - this.temperatureDelta,
          1,
        );
      }
    });
  }

  /**
   * Refresh the peer list from the trusted node
   */
  async refreshPeers(): Promise<void> {
    const log = this.log.child({ method: 'refreshPeers' });
    log.debug('Refreshing peers...');

    try {
      const response = await axios.request({
        method: 'GET',
        url: `${this.trustedNodeUrl}/peers`,
        timeout: this.peerInfoTimeoutMs,
      });
      const peerHosts = response.data as string[];

      // Create concurrency limiter for peer info requests
      const peerInfoLimit = pLimit(config.PEER_REFRESH_CONCURRENCY);

      await Promise.all(
        peerHosts.map((peerHost) =>
          peerInfoLimit(async () => {
            if (!this.ignoreUrls.includes(peerHost)) {
              try {
                const peerUrl = `http://${peerHost}`;
                const response = await axios.request({
                  method: 'GET',
                  url: `${peerUrl}/info`,
                  timeout: this.peerInfoTimeoutMs,
                });
                this.peers[peerHost] = {
                  url: peerUrl,
                  blocks: response.data.blocks,
                  height: response.data.height,
                  lastSeen: new Date().getTime(),
                };
              } catch (error) {
                metrics.arweavePeerInfoErrorCounter.inc();
              }
            } else {
              this.log.debug('Ignoring peer:', { peerHost });
            }
          }),
        ),
      );

      this.updateWeightedPeerLists();

      log.debug('Peer refresh completed', {
        totalPeers: Object.keys(this.peers).length,
      });
    } catch (error: any) {
      this.log.warn('Error refreshing peers:', {
        message: error.message,
        stack: error.stack,
      });
      metrics.arweavePeerRefreshErrorCounter.inc();
    }
  }

  private updateWeightedPeerLists(): void {
    // Update chain and post chunk peers (no preferred URLs)
    for (const peerListName of [
      'weightedChainPeers',
      'weightedPostChunkPeers',
    ] as WeightedPeerListName[]) {
      this[peerListName] = Object.values(this.peers).map((peerObject) => {
        const previousWeight =
          this[peerListName].find((peer) => peer.id === peerObject.url)
            ?.weight ?? undefined;
        return {
          id: peerObject.url,
          weight: previousWeight === undefined ? 50 : previousWeight,
        };
      });
    }

    // Update GET chunk peers (preserve resolved preferred URLs)
    const preferredChunkGetEntries = this.weightedGetChunkPeers.filter((peer) =>
      this.resolvedChunkGetUrls.includes(peer.id),
    );

    // Add discovered peers for chunk GET
    const discoveredChunkGetEntries = Object.values(this.peers).map(
      (peerObject) => {
        const previousWeight =
          this.weightedGetChunkPeers.find((peer) => peer.id === peerObject.url)
            ?.weight ?? undefined;
        return {
          id: peerObject.url,
          weight: previousWeight === undefined ? 1 : previousWeight,
        };
      },
    );

    // Combine preferred and discovered peers for chunk GET, avoiding duplicates
    const allChunkGetEntries = [...preferredChunkGetEntries];
    for (const discoveredPeer of discoveredChunkGetEntries) {
      if (!allChunkGetEntries.some((peer) => peer.id === discoveredPeer.id)) {
        allChunkGetEntries.push(discoveredPeer);
      }
    }

    this.weightedGetChunkPeers = allChunkGetEntries;

    // Update POST chunk peers (preserve preferred URLs)
    const preferredChunkPostEntries = this.weightedPostChunkPeers.filter(
      (peer) =>
        this.preferredChunkPostUrls.includes(peer.id) ||
        this.resolvedChunkPostUrls.includes(peer.id),
    );

    // Add discovered peers for chunk POST
    const discoveredChunkPostEntries = Object.values(this.peers).map(
      (peerObject) => {
        const previousWeight =
          this.weightedPostChunkPeers.find((peer) => peer.id === peerObject.url)
            ?.weight ?? undefined;
        return {
          id: peerObject.url,
          weight: previousWeight === undefined ? 50 : previousWeight,
        };
      },
    );

    // Combine preferred and discovered peers for chunk POST, avoiding duplicates
    const allChunkPostEntries = [...preferredChunkPostEntries];
    for (const discoveredPeer of discoveredChunkPostEntries) {
      if (!allChunkPostEntries.some((peer) => peer.id === discoveredPeer.id)) {
        allChunkPostEntries.push(discoveredPeer);
      }
    }

    this.weightedPostChunkPeers = allChunkPostEntries;
  }

  /**
   * Start automatic peer refresh interval
   */
  startAutoRefresh(): void {
    if (this.refreshInterval) {
      this.stopAutoRefresh(); // Clear existing interval
    }

    this.refreshInterval = setInterval(() => {
      this.refreshPeers().catch((error) => {
        this.log.warn('Auto peer refresh failed', {
          error: error.message,
        });
      });
    }, this.refreshIntervalMs);

    this.log.debug('Started automatic peer refresh', {
      intervalMs: this.refreshIntervalMs,
    });
  }

  /**
   * Stop automatic peer refresh
   */
  stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
      this.log.debug('Stopped automatic peer refresh');
    }
  }

  /**
   * Get peer URLs for a specific category (for debugging/monitoring)
   */
  getPeerUrls(category?: ArweavePeerCategory): string[] {
    if (!category) {
      return Object.values(this.peers).map((peer) => peer.url);
    }

    const peerListName = this.getPeerListName(category);
    return this[peerListName].map((peer) => peer.id);
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopAutoRefresh();
    this.stopDnsResolution();
  }
}
