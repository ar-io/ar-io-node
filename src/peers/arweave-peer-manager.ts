/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import winston from 'winston';
import pLimit from 'p-limit';

import { DnsResolver, ResolvedUrl } from '../lib/dns-resolver.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import { parseETFSyncBuckets } from '../lib/etf-sync-buckets-parser.js';
import * as metrics from '../metrics.js';
import * as config from '../config.js';

const DEFAULT_PEER_INFO_TIMEOUT_MS = 5000;
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TEMPERATURE_DELTA = 5;
const DEFAULT_BUCKET_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUCKET_SIZE = 10 * 1024 * 1024 * 1024; // 10GB bucket size

/**
 * Represents an Arweave peer node with its metadata
 */
interface ArweavePeer {
  url: string; // Full URL of the peer (e.g., "http://peer1.example.com")
  blocks: number; // Number of blocks the peer has
  height: number; // Current height of the peer's chain
  lastSeen: number; // Timestamp of last successful contact
  syncBuckets?: Set<number>; // Set of 10GB bucket indices this peer has
  bucketsLastUpdated?: number; // Timestamp of last bucket update
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
  bucketRefreshIntervalMs?: number; // How often to refresh sync buckets (default 5 minutes)
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
  private bucketRefreshIntervalMs: number;

  // Optional DNS resolver
  private dnsResolver?: DnsResolver;
  private dnsUpdateInterval?: NodeJS.Timeout;

  // Auto-refresh timers
  private refreshInterval?: NodeJS.Timeout;
  private bucketRefreshInterval?: NodeJS.Timeout;

  constructor(config: ArweavePeerManagerConfig) {
    this.log = config.log.child({ class: this.constructor.name });
    this.trustedNodeUrl = config.trustedNodeUrl;
    this.preferredChunkGetUrls = this.normalizeUrls(
      config.preferredChunkGetUrls || [],
    );
    this.preferredChunkPostUrls = this.normalizeUrls(
      config.preferredChunkPostUrls || [],
    );
    this.ignoreUrls = config.ignoreUrls || [];
    this.peerInfoTimeoutMs =
      config.peerInfoTimeoutMs ?? DEFAULT_PEER_INFO_TIMEOUT_MS;
    this.refreshIntervalMs =
      config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.temperatureDelta =
      config.temperatureDelta ?? DEFAULT_TEMPERATURE_DELTA;
    this.bucketRefreshIntervalMs =
      config.bucketRefreshIntervalMs ?? DEFAULT_BUCKET_REFRESH_INTERVAL_MS;
    this.dnsResolver = config.dnsResolver;

    // Initialize preferred URLs
    this.initializePreferredUrls();
  }

  private normalizeUrls(urls: string[]): string[] {
    return urls.map((url) => (url.endsWith('/') ? url.slice(0, -1) : url));
  }

  private initializePreferredUrls(): void {
    // Initialize resolved URLs with preferred URLs (DNS resolver will update these later if configured)
    this.resolvedChunkGetUrls = [...this.preferredChunkGetUrls];
    this.resolvedChunkPostUrls = [...this.preferredChunkPostUrls];

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

    // Log URL initialization for debugging
    if (this.preferredChunkGetUrls.length > 0) {
      this.log.debug('Initialized preferred chunk GET URLs', {
        originalUrls: this.preferredChunkGetUrls.length,
        resolvedUrls: uniqueUrls.length,
      });
    }
  }

  private initializePreferredChunkPostUrls(): void {
    // Deduplicate and initialize weightedPostChunkPeers with resolved URLs at high weight
    const uniqueUrls = [...new Set(this.resolvedChunkPostUrls)];
    this.weightedPostChunkPeers = uniqueUrls.map((peerUrl) => ({
      id: peerUrl,
      weight: 100, // High weight for preferred chunk POST URLs
    }));

    // Log URL initialization for debugging
    if (this.preferredChunkPostUrls.length > 0) {
      this.log.debug('Initialized preferred chunk POST URLs', {
        originalUrls: this.preferredChunkPostUrls.length,
        resolvedUrls: uniqueUrls.length,
      });
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
      const resolvedUrlsMap = this.convertResolvedUrlsToMap(resolvedUrls);
      this.updateResolvedUrls(resolvedUrlsMap);

      log.debug('Initial DNS resolution completed', {
        originalCount: allUrls.length,
        resolvedCount: resolvedUrls.length,
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
          const resolvedUrlsMap = this.convertResolvedUrlsToMap(resolvedUrls);
          this.updateResolvedUrls(resolvedUrlsMap);

          log.debug('Periodic DNS resolution completed', {
            originalCount: allUrls.length,
            resolvedCount: resolvedUrls.length,
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

  private convertResolvedUrlsToMap(
    resolvedUrls: ResolvedUrl[],
  ): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const resolvedUrl of resolvedUrls) {
      result[resolvedUrl.originalUrl] = [resolvedUrl.resolvedUrl];
    }
    return result;
  }

  private updateResolvedUrls(resolvedUrls: Record<string, string[]>): void {
    // Update resolved GET URLs
    this.resolvedChunkGetUrls = [];
    for (const originalUrl of this.preferredChunkGetUrls) {
      const resolved = resolvedUrls[originalUrl];
      if (resolved !== undefined && resolved.length > 0) {
        this.resolvedChunkGetUrls.push(...this.normalizeUrls(resolved));
      } else {
        this.resolvedChunkGetUrls.push(originalUrl);
      }
    }

    // Update resolved POST URLs
    this.resolvedChunkPostUrls = [];
    for (const originalUrl of this.preferredChunkPostUrls) {
      const resolved = resolvedUrls[originalUrl];
      if (resolved !== undefined && resolved.length > 0) {
        this.resolvedChunkPostUrls.push(...this.normalizeUrls(resolved));
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
   * Get preferred chunk POST URLs
   */
  getPreferredChunkPostUrls(): string[] {
    return this.preferredChunkPostUrls;
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

      // Immediately fetch sync buckets for new/updated peers
      await this.refreshPeerSyncBuckets();

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
   * Start automatic bucket refresh interval
   */
  startBucketRefresh(): void {
    if (this.bucketRefreshInterval) {
      this.stopBucketRefresh(); // Clear existing interval
    }

    this.bucketRefreshInterval = setInterval(() => {
      this.refreshBuckets().catch((error) => {
        this.log.warn('Auto bucket refresh failed', {
          error: error.message,
        });
      });
    }, this.bucketRefreshIntervalMs);

    this.log.debug('Started automatic bucket refresh', {
      intervalMs: this.bucketRefreshIntervalMs,
    });
  }

  /**
   * Stop automatic bucket refresh
   */
  stopBucketRefresh(): void {
    if (this.bucketRefreshInterval) {
      clearInterval(this.bucketRefreshInterval);
      this.bucketRefreshInterval = undefined;
      this.log.debug('Stopped automatic bucket refresh');
    }
  }

  /**
   * Refresh sync buckets for peers without buckets (immediate refresh)
   */
  private async refreshPeerSyncBuckets(): Promise<void> {
    const log = this.log.child({ method: 'refreshPeerSyncBuckets' });

    // Find peers that don't have sync buckets yet
    const peersToUpdate = Object.entries(this.peers)
      .filter(([, peer]) => peer.syncBuckets === undefined)
      .map(([url]) => url);

    if (peersToUpdate.length === 0) {
      log.debug('All peers already have sync buckets');
      return;
    }

    log.debug('Immediately fetching sync buckets for new peers', {
      peerCount: peersToUpdate.length,
    });

    // Update sync buckets for each peer
    await Promise.all(
      peersToUpdate.map((peerUrl) => this.updatePeerBuckets(peerUrl)),
    );
  }

  /**
   * Refresh sync buckets for all peers that need updating
   */
  private async refreshBuckets(): Promise<void> {
    const log = this.log.child({ method: 'refreshBuckets' });
    const now = Date.now();

    // Find peers that need bucket updates
    const peersToUpdate = Object.entries(this.peers)
      .filter(([, peer]) => {
        // Update if buckets haven't been fetched yet, or if they're stale
        return (
          peer.bucketsLastUpdated === undefined ||
          now - peer.bucketsLastUpdated > this.bucketRefreshIntervalMs
        );
      })
      .map(([url]) => url);

    if (peersToUpdate.length === 0) {
      log.debug('No peers need bucket updates');
      return;
    }

    log.debug('Refreshing buckets for peers', {
      peerCount: peersToUpdate.length,
    });

    // Create concurrency limiter for bucket requests
    const bucketUpdateLimit = pLimit(config.PEER_REFRESH_CONCURRENCY);

    await Promise.all(
      peersToUpdate.map((peerUrl) =>
        bucketUpdateLimit(() => this.updatePeerBuckets(peerUrl)),
      ),
    );

    log.debug('Bucket refresh completed');
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
   * Select peers that have data for a specific offset
   */
  selectPeersForOffset(offset: number, count: number = 3): string[] {
    const log = this.log.child({
      method: 'selectPeersForOffset',
      offset,
      count,
    });

    const bucketIndex = this.getBucketIndex(offset);
    const candidatePeers: string[] = [];

    // Find peers that have the required bucket
    for (const [, peer] of Object.entries(this.peers)) {
      if (peer.syncBuckets?.has(bucketIndex)) {
        candidatePeers.push(peer.url);
      }
    }

    log.debug('Peer selection for offset', {
      bucketIndex,
      totalPeers: Object.keys(this.peers).length,
      peersWithSyncBuckets: Object.values(this.peers).filter(
        (p) => p.syncBuckets && p.syncBuckets.size > 0,
      ).length,
      candidatePeersWithBucket: candidatePeers.length,
    });

    if (candidatePeers.length === 0) {
      log.debug(
        'No peers found with required bucket, falling back to weighted selection',
        {
          bucketIndex,
        },
      );
      // Fall back to regular weighted selection for chunk operations
      const fallbackPeers = this.selectPeers('getChunk', count);
      log.debug('Fallback peer selection result', {
        selectedPeers: fallbackPeers.length,
        peers: fallbackPeers.slice(0, 3), // Log first 3 peers
      });
      return fallbackPeers;
    }

    // Score peers by their weight from the weighted lists
    const weightedGetChunkPeers = new Map(
      this.weightedGetChunkPeers.map((p) => [p.id, p.weight]),
    );

    // Create weighted elements for randomized selection
    const weightedElements = candidatePeers.map((url) => {
      // Extract hostname from full URL to match with weighted peers
      const hostname = new URL(url).hostname;
      return {
        id: url,
        weight: weightedGetChunkPeers.get(hostname) ?? 1, // Default weight if not in weighted list
      };
    });

    // Use randomized weighted selection like the regular selectPeers method
    const selected = randomWeightedChoices({
      table: weightedElements,
      count,
    });

    log.debug('Selected offset-aware peers', {
      bucketIndex,
      candidateCount: candidatePeers.length,
      selectedCount: selected.length,
    });

    return selected;
  }

  /**
   * Update sync buckets for a specific peer
   */
  private async updatePeerBuckets(peerKey: string): Promise<void> {
    const log = this.log.child({ method: 'updatePeerBuckets', peerKey });

    // Get the peer info to get the full URL
    const peer = this.peers[peerKey];
    if (peer === undefined) {
      log.warn('Peer not found for bucket update');
      return;
    }

    try {
      const response = await axios.get(`${peer.url}/sync_buckets`, {
        timeout: this.peerInfoTimeoutMs,
        responseType: 'arraybuffer',
      });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buckets = await this.parseETFSyncBuckets(response.data);

      // Update peer info (we already have the peer reference)
      peer.syncBuckets = buckets;
      peer.bucketsLastUpdated = Date.now();
      log.debug('Updated sync buckets', { bucketCount: buckets.size });

      // Record successful update
      metrics.arweavePeerSyncBucketUpdateCounter.inc();
    } catch (error: any) {
      log.warn('Failed to fetch sync buckets', { error: error.message });

      // Record error
      metrics.arweavePeerSyncBucketErrorCounter.inc();

      // Clear buckets on failure but don't remove the peer entirely
      peer.syncBuckets = undefined;
      peer.bucketsLastUpdated = undefined;
    }
  }

  /**
   * Calculate bucket index from offset
   */
  private getBucketIndex(offset: number): number {
    return Math.floor(offset / BUCKET_SIZE);
  }

  /**
   * Parse ETF sync bucket data from Arweave peer
   */
  private async parseETFSyncBuckets(data: ArrayBuffer): Promise<Set<number>> {
    try {
      const result = parseETFSyncBuckets(data);
      this.log.debug('Parsed ETF sync buckets', {
        bucketSize: result.bucketSize,
        bucketCount: result.buckets.size,
      });
      return result.buckets;
    } catch (error) {
      this.log.error('Failed to parse ETF sync buckets', { error });
      return new Set();
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopAutoRefresh();
    this.stopBucketRefresh();
    this.stopDnsResolution();
  }
}
