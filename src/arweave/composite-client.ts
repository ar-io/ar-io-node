/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as Arweave } from 'arweave';
import { AxiosRequestConfig, AxiosResponse, default as axios } from 'axios';
import type { queueAsPromised } from 'fastq';
import { default as fastq } from 'fastq';
import { default as NodeCache } from 'node-cache';
import { Readable } from 'node:stream';
import * as rax from 'retry-axios';
import wait from '../lib/wait.js';
import * as winston from 'winston';
import pLimit from 'p-limit';
import memoize from 'memoizee';
import { isDeepStrictEqual } from 'node:util';
import { context, trace, Span } from '@opentelemetry/api';
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';

import { FailureSimulator } from '../lib/chaos.js';
import { DnsResolver } from '../lib/dns-resolver.js';
import { fromB64Url } from '../lib/encoding.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import {
  sanityCheckBlock,
  sanityCheckChunk,
  sanityCheckTx,
  validateChunk,
} from '../lib/validation.js';
import { secp256k1OwnerFromTx } from '../lib/ecdsa-public-key-recover.js';
import * as metrics from '../metrics.js';
import * as config from '../config.js';
import { tracer } from '../tracing.js';
import {
  BroadcastChunkResult,
  BroadcastChunkResponses,
  ChainSource,
  Chunk,
  ChunkBroadcaster,
  ChunkByAnySource,
  ChunkData,
  ChunkDataByAnySource,
  ChunkMetadata,
  ChunkMetadataByAnySource,
  ContiguousData,
  ContiguousDataSource,
  JsonChunkPost,
  JsonTransactionOffset,
  PartialJsonBlock,
  PartialJsonBlockStore,
  PartialJsonTransaction,
  PartialJsonTransactionStore,
  Region,
  ChunkDataByAnySourceParams,
  WithPeers,
} from '../types.js';
import { MAX_FORK_DEPTH } from './constants.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_RETRY_COUNT = 5;
const DEFAULT_MAX_REQUESTS_PER_SECOND = 5;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_BLOCK_PREFETCH_COUNT = 50;
const DEFAULT_BLOCK_TX_PREFETCH_COUNT = 1;
const CHUNK_CACHE_TTL_SECONDS = 5;
const CHUNK_CACHE_CAPACITY = 1000;
const DEFAULT_CHUNK_POST_ABORT_TIMEOUT_MS = 2000;
const DEFAULT_CHUNK_POST_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_PEER_INFO_TIMEOUT_MS = 5000;
const DEFAULT_PEER_TX_TIMEOUT_MS = 5000;

// Peer queue management types
interface ChunkPostTask {
  peer: string;
  chunk: JsonChunkPost;
  abortTimeout: number;
  responseTimeout: number;
  headers: Record<string, string | undefined>;
}

interface ChunkPostResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  canceled?: boolean;
  timedOut?: boolean;
}

interface PeerChunkQueue {
  queue: queueAsPromised<ChunkPostTask, ChunkPostResult>;
  totalAttempts: number;
  totalSuccesses: number;
}

interface Peer {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
}

type WeightedPeerListName =
  | 'weightedChainPeers'
  | 'weightedGetChunkPeers'
  | 'weightedPostChunkPeers';

export class ArweaveCompositeClient
  implements
    ChainSource,
    ChunkBroadcaster,
    ChunkByAnySource,
    ChunkDataByAnySource,
    ChunkMetadataByAnySource,
    ContiguousDataSource,
    WithPeers<Peer>
{
  private arweave: Arweave;
  private log: winston.Logger;
  private failureSimulator: FailureSimulator;
  private txStore: PartialJsonTransactionStore;
  private blockStore: PartialJsonBlockStore;
  private chunkPromiseCache: ReadThroughPromiseCache<string, Chunk>;
  private skipCache: boolean;
  private dnsResolver?: DnsResolver;
  private dnsUpdateInterval?: NodeJS.Timeout;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredChunkGetUrls: string[];
  private resolvedChunkGetUrls: string[];
  private weightedChainPeers: WeightedElement<string>[] = [];
  private weightedGetChunkPeers: WeightedElement<string>[] = [];
  private weightedPostChunkPeers: WeightedElement<string>[] = [];

  // New peer-based chunk POST system
  private preferredChunkPostUrls: string[];
  private resolvedChunkPostUrls: string[];
  private peerChunkQueues: Map<string, PeerChunkQueue> = new Map();
  private getSortedChunkPostPeers: (eligiblePeers: string[]) => string[];

  // Block and TX promise caches used for prefetching
  private blockByHeightPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 30,
    useClones: false, // cloning promises is unsafe
  });
  private txPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 60,
    useClones: false, // cloning promises is unsafe
  });

  // Trusted node request queue
  private trustedNodeRequestQueue: queueAsPromised<
    AxiosRequestConfig,
    AxiosResponse
  >;

  // Trusted node request bucket (for rate limiting)
  private trustedNodeRequestBucket = 0;

  // Prefetch settings and state
  private blockPrefetchCount;
  private blockTxPrefetchCount;
  private maxPrefetchHeight = -1;

  constructor({
    log,
    arweave,
    trustedNodeUrl,
    blockStore,
    txStore,
    failureSimulator,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
    requestRetryCount = DEFAULT_REQUEST_RETRY_COUNT,
    maxRequestsPerSecond = DEFAULT_MAX_REQUESTS_PER_SECOND,
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    blockPrefetchCount = DEFAULT_BLOCK_PREFETCH_COUNT,
    blockTxPrefetchCount = DEFAULT_BLOCK_TX_PREFETCH_COUNT,
    skipCache = false,
    preferredChunkGetUrls = [],
    dnsResolver,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    trustedNodeUrl: string;
    blockStore: PartialJsonBlockStore;
    txStore: PartialJsonTransactionStore;
    failureSimulator: FailureSimulator;
    requestTimeout?: number;
    requestRetryCount?: number;
    requestPerSecond?: number;
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
    blockPrefetchCount?: number;
    blockTxPrefetchCount?: number;
    skipCache?: boolean;
    preferredChunkGetUrls?: string[];
    dnsResolver?: DnsResolver;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.preferredChunkGetUrls = preferredChunkGetUrls.map((url) =>
      url.replace(/\/$/, ''),
    );
    this.dnsResolver = dnsResolver;

    // Initialize with unresolved URLs first
    this.resolvedChunkGetUrls = this.preferredChunkGetUrls;

    // TODO: use defaults in constructor instead of referencing config here

    // Initialize new peer-based chunk POST system
    this.preferredChunkPostUrls = config.PREFERRED_CHUNK_POST_NODE_URLS.map(
      (url) => url.replace(/\/$/, ''),
    );
    // Initialize with unresolved URLs first
    this.resolvedChunkPostUrls = this.preferredChunkPostUrls;
    this.initializeChunkPostPeers();

    // Initialize memoized sorting function for chunk POST peers
    this.getSortedChunkPostPeers = memoize(
      (eligiblePeers: string[]) => {
        // Create a copy and sort: preferred peers first, then by weight within each group
        return [...eligiblePeers].sort((a, b) => {
          const aIsPreferred = this.isPreferredPeer(a);
          const bIsPreferred = this.isPreferredPeer(b);

          // If one is preferred and the other isn't, preferred comes first
          if (aIsPreferred && !bIsPreferred) return -1;
          if (!aIsPreferred && bIsPreferred) return 1;

          // If both are preferred or both are not, sort by weight
          return this.getPeerWeight(b) - this.getPeerWeight(a);
        });
      },
      {
        maxAge: config.CHUNK_POST_SORTED_PEERS_CACHE_DURATION_MS,
        // Use array length as cache key for O(1) performance. This means different
        // peer lists of the same length will share cached results, which is acceptable
        // because: 1) peer weights change gradually, 2) the cache duration is short (10s),
        // and 3) this avoids expensive operations on every chunk POST request.
        normalizer: (args) => args[0].length.toString(),
      },
    );

    this.failureSimulator = failureSimulator;
    this.txStore = txStore;
    this.blockStore = blockStore;
    this.skipCache = skipCache;

    // Initialize chunk promise cache with read-through function
    this.chunkPromiseCache = new ReadThroughPromiseCache<string, Chunk>({
      cacheParams: {
        cacheCapacity: CHUNK_CACHE_CAPACITY,
        cacheTTL: CHUNK_CACHE_TTL_SECONDS * 1000,
      },
      readThroughFunction: async (cacheKey: string) => {
        // Parse the cache key back to parameters
        const params: ChunkDataByAnySourceParams = JSON.parse(cacheKey);

        try {
          const chunk = await this.peerGetChunk({
            absoluteOffset: params.absoluteOffset,
            txSize: params.txSize,
            dataRoot: params.dataRoot,
            relativeOffset: params.relativeOffset,
          });

          metrics.getChunkTotal.inc({
            status: 'success',
            method: 'getChunkByAny',
            class: this.constructor.name,
          });

          return chunk;
        } catch (error: any) {
          metrics.getChunkTotal.inc({
            status: 'error',
            method: 'getChunkByAny',
            class: this.constructor.name,
          });
          this.log.warn('Unable to fetch chunk from peers', {
            message: error.message,
            stack: error.stack,
          });
          throw new Error('Unable to fetch chunk from any available peers');
        }
      },
    });

    // Initialize trusted node Axios with automatic retries
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: requestTimeout,
      headers: {
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
      },
    });
    this.trustedNodeAxios.defaults.raxConfig = {
      retry: requestRetryCount,
      instance: this.trustedNodeAxios,
      onRetryAttempt: (error) => {
        const cfg = rax.getConfig(error);
        const attempt = cfg?.currentRetryAttempt ?? 1;
        if (error?.response?.status === 429) {
          this.trustedNodeRequestBucket -= 2 ** attempt;
        }
      },
    };
    rax.attach(this.trustedNodeAxios);

    // Initialize trusted node request queue
    this.trustedNodeRequestQueue = fastq.promise(
      this.trustedNodeRequest.bind(this),
      maxConcurrentRequests,
    );

    // Start trusted node request bucket filler (for rate limiting)
    setInterval(() => {
      if (this.trustedNodeRequestBucket <= maxRequestsPerSecond * 300) {
        this.trustedNodeRequestBucket += maxRequestsPerSecond;
      }
    }, 1000);

    // Refresh Arweave peers every 10 minutes
    setInterval(() => this.refreshPeers(), 10 * 60 * 1000);

    // Initialize preferred chunk GET URLs with high weight
    this.initializePreferredChunkGetUrls();

    // Initialize prefetch settings
    this.blockPrefetchCount = blockPrefetchCount;
    this.blockTxPrefetchCount = blockTxPrefetchCount;
  }

  /**
   * Initializes the weighted GET chunk peers with preferred URLs.
   * Sets high initial weight (100) for all preferred GET URLs.
   * Deduplicates URLs to prevent over-representation.
   * @private
   */
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
    const resolveStart = Date.now();
    log.info('Resolving DNS for preferred chunk nodes...', {
      getUrlCount: this.preferredChunkGetUrls.length,
      postUrlCount: this.preferredChunkPostUrls.length,
      totalUrlCount: allUrls.length,
    });

    await this.dnsResolver.resolveUrls(allUrls);

    const resolvedUrls = this.dnsResolver.getAllResolvedUrls();
    const successCount = resolvedUrls.filter(
      (r) => r.resolutionError === undefined,
    ).length;

    log.info('DNS resolution complete', {
      totalUrls: allUrls.length,
      successfulResolutions: successCount,
      failedResolutions: allUrls.length - successCount,
      durationMs: Date.now() - resolveStart,
      usingDefaultGets: this.preferredChunkGetUrls.some(
        (url) => url.includes('data-') && url.includes('.arweave.xyz'),
      ),
      usingDefaultPosts: this.preferredChunkPostUrls.some(
        (url) => url.includes('tip-') && url.includes('.arweave.xyz'),
      ),
    });

    // Log resolved URLs for debugging
    resolvedUrls.forEach((result) => {
      if (result.resolutionError !== undefined) {
        log.warn('Failed to resolve URL', {
          hostname: result.hostname,
          originalUrl: result.originalUrl,
          error: result.resolutionError,
        });
      } else {
        log.debug('Resolved URL', {
          hostname: result.hostname,
          originalUrl: result.originalUrl,
          resolvedUrl: result.resolvedUrl,
          ips: result.ips,
        });
      }
    });

    // Update resolved URLs
    this.updateResolvedUrls();

    // Start periodic DNS re-resolution
    if (config.PREFERRED_CHUNK_NODE_DNS_RESOLUTION_INTERVAL_SECONDS > 0) {
      // Single interval that handles both DNS resolution and updates
      this.dnsUpdateInterval = setInterval(async () => {
        try {
          log.debug('Running periodic DNS re-resolution');

          // Trigger fresh DNS resolution
          await this.dnsResolver?.resolveUrls(allUrls);

          // Update our peer lists with the new results
          this.updateResolvedUrls();
        } catch (error: any) {
          log.error('Error during periodic DNS resolution', {
            error: error.message,
            stack: error.stack,
          });
        }
      }, config.PREFERRED_CHUNK_NODE_DNS_RESOLUTION_INTERVAL_SECONDS * 1000);

      // Don't block the event loop
      this.dnsUpdateInterval.unref();

      log.info('Started periodic DNS re-resolution', {
        intervalSeconds:
          config.PREFERRED_CHUNK_NODE_DNS_RESOLUTION_INTERVAL_SECONDS,
      });
    }
  }

  /**
   * Updates the resolved URLs for both GET and POST peers based on current DNS resolution.
   * Detects changes and updates weighted peer lists accordingly.
   * @private
   */
  private updateResolvedUrls(): void {
    if (!this.dnsResolver) {
      return;
    }

    // Update GET URLs
    const newResolvedGetUrls = this.dnsResolver.getResolvedUrlStrings(
      this.preferredChunkGetUrls,
    );

    // Check if GET URLs have changed
    const getUrlsChanged = !isDeepStrictEqual(
      newResolvedGetUrls,
      this.resolvedChunkGetUrls,
    );

    if (getUrlsChanged) {
      this.log.debug(
        'DNS resolution changed, updating preferred chunk GET URLs',
        {
          oldUrls: this.resolvedChunkGetUrls,
          newUrls: newResolvedGetUrls,
        },
      );

      // Deduplicate resolved URLs to prevent over-representation
      this.resolvedChunkGetUrls = [...new Set(newResolvedGetUrls)];

      // Update the weighted peers list with new resolved URLs
      const preferredPeers = this.resolvedChunkGetUrls.map((peerUrl) => ({
        id: peerUrl,
        weight: 100,
      }));

      // Preserve non-preferred peers
      const nonPreferredPeers = this.weightedGetChunkPeers.filter(
        (peer) =>
          !this.resolvedChunkGetUrls.includes(peer.id) &&
          !this.preferredChunkGetUrls.includes(peer.id),
      );

      this.weightedGetChunkPeers = [...preferredPeers, ...nonPreferredPeers];
    }

    // Update POST URLs
    const newResolvedPostUrls = this.dnsResolver.getResolvedUrlStrings(
      this.preferredChunkPostUrls,
    );

    // Check if POST URLs have changed
    const postUrlsChanged = !isDeepStrictEqual(
      newResolvedPostUrls,
      this.resolvedChunkPostUrls,
    );

    if (postUrlsChanged) {
      this.log.debug(
        'DNS resolution changed, updating preferred chunk POST URLs',
        {
          oldUrls: this.resolvedChunkPostUrls,
          newUrls: newResolvedPostUrls,
        },
      );

      // Deduplicate resolved URLs to prevent over-representation
      this.resolvedChunkPostUrls = [...new Set(newResolvedPostUrls)];

      // Update the weighted POST peers list with new resolved URLs
      const preferredPostPeers = this.resolvedChunkPostUrls.map((peerUrl) => ({
        id: peerUrl,
        weight: config.PREFERRED_CHUNK_POST_WEIGHT,
      }));

      // Preserve non-preferred POST peers
      const nonPreferredPostPeers = this.weightedPostChunkPeers.filter(
        (peer) =>
          !this.resolvedChunkPostUrls.includes(peer.id) &&
          !this.preferredChunkPostUrls.includes(peer.id),
      );

      this.weightedPostChunkPeers = [
        ...preferredPostPeers,
        ...nonPreferredPostPeers,
      ];
    }
  }

  /**
   * Stops the periodic DNS resolution timer if running.
   * Safe to call multiple times.
   */
  stopDnsResolution(): void {
    if (this.dnsUpdateInterval) {
      clearInterval(this.dnsUpdateInterval);
      this.dnsUpdateInterval = undefined;
    }
  }

  /**
   * Initializes the weighted POST chunk peers with preferred URLs.
   * Sets weight from config for all preferred POST URLs.
   * Deduplicates URLs to prevent over-representation.
   * @private
   */
  private initializeChunkPostPeers(): void {
    // Deduplicate and initialize weightedPostChunkPeers with resolved URLs at high weight
    const uniqueUrls = [...new Set(this.resolvedChunkPostUrls)];
    this.weightedPostChunkPeers = uniqueUrls.map((peerUrl) => ({
      id: peerUrl,
      weight: config.PREFERRED_CHUNK_POST_WEIGHT,
    }));
  }

  private getOrCreatePeerQueue(peer: string): PeerChunkQueue {
    let peerQueue = this.peerChunkQueues.get(peer);

    if (!peerQueue) {
      peerQueue = {
        queue: fastq.promise(
          this.postChunkToPeer.bind(this),
          config.CHUNK_POST_PER_NODE_CONCURRENCY,
        ), // Concurrency per peer
        totalAttempts: 0,
        totalSuccesses: 0,
      };
      this.peerChunkQueues.set(peer, peerQueue);
    }

    return peerQueue;
  }

  private getEligiblePeersForPost(): string[] {
    return this.weightedPostChunkPeers
      .filter((peer) => {
        const peerQueue = this.peerChunkQueues.get(peer.id);
        return (
          !peerQueue ||
          peerQueue.queue.length() < config.CHUNK_POST_QUEUE_DEPTH_THRESHOLD
        );
      })
      .map((peer) => peer.id);
  }

  private getPeerWeight(peer: string): number {
    const weightedPeer = this.weightedPostChunkPeers.find((p) => p.id === peer);
    return weightedPeer?.weight ?? 1;
  }

  private isPreferredPeer(peer: string): boolean {
    return (
      this.preferredChunkPostUrls.includes(peer) ||
      this.resolvedChunkPostUrls.includes(peer)
    );
  }

  private updateChunkPostPeerWeight(peer: string, success: boolean): void {
    const peerIndex = this.weightedPostChunkPeers.findIndex(
      (p) => p.id === peer,
    );
    if (peerIndex !== -1) {
      const delta = config.WEIGHTED_PEERS_TEMPERATURE_DELTA;
      const isPreferred = this.isPreferredPeer(peer);

      if (success) {
        this.weightedPostChunkPeers[peerIndex].weight = Math.min(
          this.weightedPostChunkPeers[peerIndex].weight + delta,
          100,
        );
      } else {
        // Never decrease weight for preferred peers
        if (!isPreferred) {
          this.weightedPostChunkPeers[peerIndex].weight = Math.max(
            this.weightedPostChunkPeers[peerIndex].weight - delta,
            1,
          );
        } else {
          this.log.debug('Skipping weight decrease for preferred peer', {
            peer,
            currentWeight: this.weightedPostChunkPeers[peerIndex].weight,
          });
        }
      }
    }
  }

  private async postChunkToPeer(task: ChunkPostTask): Promise<ChunkPostResult> {
    try {
      this.failureSimulator.maybeFail();

      const response = await axios({
        method: 'POST',
        url: `${task.peer}/chunk`,
        data: task.chunk,
        signal: AbortSignal.timeout(task.abortTimeout),
        timeout: task.responseTimeout,
        headers: task.headers,
        validateStatus: (status) => status === 200,
      });

      metrics.arweaveChunkPostCounter.inc({
        endpoint: task.peer,
        status: 'success',
      });

      return {
        success: true,
        statusCode: response.status,
      };
    } catch (error: any) {
      let canceled = false;
      let timedOut = false;

      if (axios.isAxiosError(error)) {
        timedOut = error.code === 'ECONNABORTED';
        canceled = error.code === 'ERR_CANCELED';
      }

      metrics.arweaveChunkPostCounter.inc({
        endpoint: task.peer,
        status: 'fail',
      });

      this.log.debug('Failed to POST chunk to peer:', {
        peer: task.peer,
        error: error.message,
      });

      return {
        success: false,
        statusCode: error.response?.status,
        error: error.message,
        canceled,
        timedOut,
      };
    }
  }

  private async queueChunkPost(
    peer: string,
    chunk: JsonChunkPost,
    abortTimeout: number,
    responseTimeout: number,
    headers: Record<string, string | undefined>,
    parentSpan?: Span,
  ): Promise<ChunkPostResult> {
    const span = tracer.startSpan(
      'ArweaveCompositeClient.queueChunkPost',
      {
        attributes: {
          'chunk.peer': peer,
          'chunk.peer.is_preferred': this.isPreferredPeer(peer),
          'chunk.data_root': chunk.data_root,
          'chunk.data_size': chunk.data_size,
        },
      },
      ...(parentSpan ? [trace.setSpan(context.active(), parentSpan)] : []),
    );

    const peerQueue = this.getOrCreatePeerQueue(peer);

    try {
      const queueDepth = peerQueue.queue.length();
      span.setAttribute('chunk.queue_depth', queueDepth);

      // Check queue depth
      if (queueDepth >= config.CHUNK_POST_QUEUE_DEPTH_THRESHOLD) {
        span.addEvent('Queue depth exceeded');
        throw new Error(`Peer ${peer} queue depth exceeded`);
      }

      // Queue the chunk post
      peerQueue.totalAttempts++;

      const result = await peerQueue.queue.push({
        peer,
        chunk,
        abortTimeout,
        responseTimeout,
        headers,
      });

      span.setAttribute('chunk.post.success', result.success);
      if (result.statusCode !== undefined) {
        span.setAttribute('chunk.post.status_code', result.statusCode);
      }
      if (result.canceled) {
        span.setAttribute('chunk.post.canceled', result.canceled);
      }
      if (result.timedOut) {
        span.setAttribute('chunk.post.timed_out', result.timedOut);
      }

      if (result.success) {
        peerQueue.totalSuccesses++;
        this.updateChunkPostPeerWeight(peer, true);
        span.addEvent('Chunk POST succeeded');
      } else {
        if (result.error !== undefined) {
          span.addEvent('Chunk POST failed', { error: result.error });
        }
        this.updateChunkPostPeerWeight(peer, false);
      }

      return result;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async refreshPeers(): Promise<void> {
    const log = this.log.child({ method: 'refreshPeers' });
    log.debug('Refreshing peers...');

    try {
      const response = await this.trustedNodeRequest({
        method: 'GET',
        url: '/peers',
      });
      const peerHosts = response.data as string[];

      // Create concurrency limiter for peer info requests
      const peerInfoLimit = pLimit(config.PEER_REFRESH_CONCURRENCY);

      await Promise.all(
        peerHosts.map((peerHost) =>
          peerInfoLimit(async () => {
            if (!config.ARWEAVE_NODE_IGNORE_URLS.includes(peerHost)) {
              try {
                const peerUrl = `http://${peerHost}`;
                const response = await axios({
                  method: 'GET',
                  url: '/info',
                  baseURL: peerUrl,
                  timeout: DEFAULT_PEER_INFO_TIMEOUT_MS,
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
      const preferredChunkGetEntries = this.weightedGetChunkPeers.filter(
        (peer) => this.resolvedChunkGetUrls.includes(peer.id),
      );

      // Add discovered peers for chunk GET
      const discoveredChunkGetEntries = Object.values(this.peers).map(
        (peerObject) => {
          const previousWeight =
            this.weightedGetChunkPeers.find(
              (peer) => peer.id === peerObject.url,
            )?.weight ?? undefined;
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
            this.weightedPostChunkPeers.find(
              (peer) => peer.id === peerObject.url,
            )?.weight ?? undefined;
          return {
            id: peerObject.url,
            weight: previousWeight === undefined ? 50 : previousWeight,
          };
        },
      );

      // Combine preferred and discovered peers for chunk POST, avoiding duplicates
      const allChunkPostEntries = [...preferredChunkPostEntries];
      for (const discoveredPeer of discoveredChunkPostEntries) {
        if (
          !allChunkPostEntries.some((peer) => peer.id === discoveredPeer.id)
        ) {
          allChunkPostEntries.push(discoveredPeer);
        }
      }

      this.weightedPostChunkPeers = allChunkPostEntries;
    } catch (error: any) {
      this.log.warn('Error refreshing peers:', {
        message: error.message,
        stack: error.stack,
      });
      metrics.arweavePeerRefreshErrorCounter.inc();
    }
  }

  getPeers(): Record<string, Peer> {
    return this.peers;
  }

  selectPeers(peerCount: number, peerListName: WeightedPeerListName): string[] {
    const log = this.log.child({ method: 'selectPeers', peerListName });

    if (this[peerListName].length === 0) {
      log.debug('No weighted peers available');
      return [];
    }

    return randomWeightedChoices<string>({
      table: this[peerListName],
      count: peerCount,
    });
  }

  async trustedNodeRequest(request: AxiosRequestConfig) {
    while (this.trustedNodeRequestBucket <= 0) {
      await wait(100);
    }
    this.trustedNodeRequestBucket--;
    return this.trustedNodeAxios(request);
  }

  async prefetchBlockByHeight(
    height: number,
    prefetchTxs = true,
  ): Promise<PartialJsonBlock | undefined> {
    let blockPromise = this.blockByHeightPromiseCache.get(height);

    if (!blockPromise) {
      blockPromise = this.blockStore
        .getByHeight(height)
        .then((block) => {
          this.failureSimulator.maybeFail();

          // Return cached block if it exists
          if (!this.skipCache && block) {
            return block;
          }

          return this.trustedNodeRequestQueue
            .push({
              method: 'GET',
              url: `/block/height/${height}`,
            })
            .then((response) => {
              // Delete PoA and PoA 2 to reduce cache size
              if (response?.data?.poa) {
                if (response.data.poa.chunk !== '') {
                  metrics.arweavePoaCounter.inc();
                }
                delete response.data.poa;
              }
              if (response?.data?.poa2) {
                if (response.data.poa2.chunk !== '') {
                  metrics.arweavePoa2Counter.inc();
                }
                delete response.data.poa2;
              }
              return response.data;
            });
        })
        .then(async (block) => {
          try {
            // Sanity check to guard against accidental bad data from both
            // cache and trusted node
            sanityCheckBlock(block);

            await this.blockStore.set(
              block,
              // Only cache height for stable blocks (where height doesn't change)
              this.maxPrefetchHeight - block.height > MAX_FORK_DEPTH
                ? block.height
                : undefined,
            );

            // Prefetch transactions
            if (prefetchTxs) {
              for (const txId of block.txs) {
                // await intentionally left out here to allow multiple
                // "fire-and-forget" prefetches to run in parallel
                this.prefetchTx({ txId });
              }
            }

            return block;
          } catch (error) {
            this.blockStore.delByHeight(height);
            this.blockStore.delByHash(block.indep_hash);
          }
        })
        .catch((error) => {
          this.log.warn('Block prefetch failed:', {
            height: height,
            message: error.message,
            stack: error.stack,
          });
        });

      this.blockByHeightPromiseCache.set(height, blockPromise);
    }

    return blockPromise as Promise<PartialJsonBlock | undefined>;
  }

  // TODO make second arg an options object
  async getBlockByHeight(
    height: number,
    shouldPrefetch = false,
  ): Promise<PartialJsonBlock> {
    const blockPromise = this.prefetchBlockByHeight(height);

    // Prefetch the next N blocks
    if (shouldPrefetch && height < this.maxPrefetchHeight) {
      for (let i = 1; i < this.blockPrefetchCount; i++) {
        const prefetchHeight = height + i;
        if (
          // Don't prefetch beyond the end of the chain
          prefetchHeight <= this.maxPrefetchHeight &&
          // Save some capacity for other requests
          this.trustedNodeRequestQueue.length() === 0
        ) {
          this.prefetchBlockByHeight(
            prefetchHeight,
            i <= this.blockTxPrefetchCount,
          );
        } else {
          break;
        }
      }
    }

    try {
      const block = await blockPromise;

      // Check that a response was returned since the promise returns undefined
      // on failure
      if (!block) {
        throw new Error('Prefetched block request failed');
      }

      // Remove prefetched request from cache so forks are handled correctly
      this.blockByHeightPromiseCache.del(height);

      return block;
    } catch (error) {
      // Remove failed requests from the cache so they get retried
      this.blockByHeightPromiseCache.del(height);

      throw error;
    }
  }

  async peerGetTx(url: string, retryCount = 3) {
    const peersToTry = this.selectPeers(retryCount, 'weightedChainPeers');

    return Promise.any(
      peersToTry.map((peerUrl) => {
        return (async () => {
          try {
            const response = await axios({
              method: 'GET',
              url,
              baseURL: peerUrl,
              timeout: DEFAULT_PEER_TX_TIMEOUT_MS,
            });

            // The arweave JS library will fail to validate some valid
            // transactions, so as long as we can retrieve the TX we count it
            // as a success and increment the weights. If the TX is invalid we
            // also decement the weight so it's a wash and a flood of invalid
            // TXs will still be counted against the peer.
            this.handlePeerSuccess(
              peerUrl,
              'peerGetTx',
              'peer',
              'weightedChainPeers',
            );

            const tx = this.arweave.transactions.fromRaw(response.data);
            const isValid = await this.arweave.transactions.verify(tx);
            if (!isValid) {
              // If TX is invalid, mark this peer as failed and reject.
              throw new Error(`Invalid TX from peer: ${peerUrl}`);
            }

            return response;
          } catch (err) {
            // On error, mark this peer as failed and reject the promise for this peer.
            this.handlePeerFailure(
              peerUrl,
              'peerGetTx',
              'peer',
              'weightedChainPeers',
            );
            throw err;
          }
        })();
      }),
    ).catch((errors) => {
      // Handle the scenario where all peers have failed
      throw new Error(`All peer requests failed: ${errors}`);
    });
  }

  async prefetchTx({
    txId,
    isPendingTx = false,
  }: {
    txId: string;
    isPendingTx?: boolean;
  }): Promise<PartialJsonTransaction | undefined> {
    const cachedResponsePromise = this.txPromiseCache.get(txId);
    if (cachedResponsePromise) {
      // Update TTL if block promise is already cached
      this.txPromiseCache.set(txId, cachedResponsePromise);
      return cachedResponsePromise as Promise<
        PartialJsonTransaction | undefined
      >;
    }

    const transactionType = isPendingTx ? 'unconfirmed_tx' : 'tx';
    const url = `/${transactionType}/${txId}`;
    let downloadedFromPeer = true;

    const responsePromise = (async () => {
      try {
        // Check if it's already in the store
        const storedTx = await this.txStore.get(txId);

        this.failureSimulator.maybeFail();

        if (!this.skipCache && storedTx) {
          return storedTx;
        }

        // Attempt to fetch from peer
        let response;

        try {
          response = await this.peerGetTx(url, 3);
        } catch {
          // If peer fails, fall back to trusted node
          downloadedFromPeer = false;
          response = await this.trustedNodeRequestQueue.push({
            method: 'GET',
            url,
          });
        }

        // Delete the TX data payload (if present) to minimize memory/cache usage
        if (response?.data?.data) {
          delete response.data.data;
        }

        // Sanity-check the result
        metrics.arweaveTxFetchCounter.inc({
          node_type: downloadedFromPeer ? 'arweave_peer' : 'trusted',
        });
        sanityCheckTx(response.data);

        // Store to our TX cache
        await this.txStore.set(response.data);

        return response.data;
      } catch (errorUnknown: unknown) {
        // If something goes wrong, remove it from the store (in case partially cached)
        this.txStore.del(txId);
        const error = errorUnknown as Error;
        this.log.warn('Transaction prefetch failed:', {
          txId,
          message: error.message,
          stack: error.stack,
        });
        return undefined; // Return undefined on failure
      }
    })();

    // Store our in-flight promise in the cache
    this.txPromiseCache.set(txId, responsePromise);

    return responsePromise;
  }

  async getTx({
    txId,
    isPendingTx = false,
  }: {
    txId: string;
    isPendingTx?: boolean;
  }): Promise<PartialJsonTransaction> {
    try {
      // Wait for TX response
      const tx = await this.prefetchTx({ txId, isPendingTx });

      // Check that a response was returned since the promise returns undefined
      // on failure
      if (!tx) {
        throw new Error('Prefetched transaction request failed');
      }

      if (!tx.owner) {
        // Arweave supports transactions where the owner field is an empty string.
        // This is possible because the public owner key can be derived from the signature payload.
        // The derivation is achieved through ECDSA public key recovery using the secp256k1 algorithm.
        // For more details, see: https://github.com/ArweaveTeam/arweave/releases/tag/N.2.9.1
        tx.owner = await secp256k1OwnerFromTx(tx);
      }

      return tx;
    } catch (error: any) {
      // Remove failed requests from the cache so they get retried
      this.txPromiseCache.del(txId);

      throw error;
    }
  }

  async getTxOffset(txId: string): Promise<JsonTransactionOffset> {
    this.failureSimulator.maybeFail();

    return (
      await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/tx/${txId}/offset`,
      })
    ).data;
  }

  async getTxField<K extends keyof PartialJsonTransaction>(
    txId: string,
    field: K,
  ): Promise<PartialJsonTransaction[K]> {
    this.failureSimulator.maybeFail();

    return (
      await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/tx/${txId}/${field}`,
      })
    ).data;
  }

  // TODO make second arg an options object
  async getBlockAndTxsByHeight(
    height: number,
    shouldPrefetch = true,
  ): Promise<{
    block: PartialJsonBlock;
    txs: PartialJsonTransaction[];
    missingTxIds: string[];
  }> {
    const block = await this.getBlockByHeight(height, shouldPrefetch);

    // Retrieve block transactions
    const missingTxIds: string[] = [];
    const txs: PartialJsonTransaction[] = [];
    await Promise.all(
      block.txs.map(async (txId) => {
        try {
          const tx = await this.getTx({ txId });
          txs.push(tx);
        } catch (error) {
          missingTxIds.push(txId);
        }
      }),
    );

    return { block, txs: txs, missingTxIds: missingTxIds };
  }

  async getHeight(): Promise<number> {
    const response = await this.trustedNodeRequest({
      method: 'GET',
      url: '/height',
    });

    // Save max observed height for use as block prefetch boundary
    this.maxPrefetchHeight =
      this.maxPrefetchHeight < response.data
        ? response.data
        : this.maxPrefetchHeight;

    return response.data;
  }

  handlePeerSuccess(
    peer: string,
    method: string,
    sourceType: 'trusted' | 'peer',
    peerListName: WeightedPeerListName,
  ): void {
    metrics.requestChunkTotal.inc({
      status: 'success',
      method,
      class: this.constructor.name,
      source: peer,
      source_type: sourceType,
    });
    if (sourceType === 'peer') {
      // warm the succeeding peer
      this[peerListName].forEach((weightedPeer) => {
        if (weightedPeer.id === peer) {
          weightedPeer.weight = Math.min(
            weightedPeer.weight + config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
            100,
          );
        }
      });
    }
  }

  handlePeerFailure(
    peer: string,
    method: string,
    sourceType: 'trusted' | 'peer',
    peerListName: WeightedPeerListName,
  ): void {
    metrics.requestChunkTotal.inc({
      status: 'error',
      method,
      class: this.constructor.name,
      source: peer,
      source_type: sourceType,
    });
    if (sourceType === 'peer') {
      // cool the failing peer
      this[peerListName].forEach((weightedPeer) => {
        if (weightedPeer.id === peer) {
          weightedPeer.weight = Math.max(
            weightedPeer.weight - config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
            1,
          );
        }
      });
    }
  }

  async peerGetChunk({
    absoluteOffset,
    txSize,
    dataRoot,
    relativeOffset,
    peerSelectionCount = 10,
    retryCount = 50,
  }: {
    txSize: number;
    absoluteOffset: number;
    dataRoot: string;
    relativeOffset: number;
    peerSelectionCount?: number;
    retryCount?: number;
  }): Promise<Chunk> {
    const span = tracer.startSpan('ArweaveCompositeClient.peerGetChunk', {
      attributes: {
        'chunk.data_root': dataRoot,
        'chunk.absolute_offset': absoluteOffset,
        'chunk.relative_offset': relativeOffset,
        'chunk.tx_size': txSize,
        'chunk.retry_count': retryCount,
        'chunk.peer_selection_count': peerSelectionCount,
      },
    });

    try {
      for (let attempt = 0; attempt < retryCount; attempt++) {
        span.addEvent('Starting peer attempt', {
          attempt: attempt + 1,
          max_attempts: retryCount,
        });

        // Select a random set of peers for each retry attempt
        const randomPeers = this.selectPeers(
          peerSelectionCount,
          'weightedGetChunkPeers',
        );

        if (randomPeers.length === 0) {
          const error = new Error('No peers available for chunk retrieval');
          span.recordException(error);
          throw error;
        }

        span.setAttribute('chunk.available_peers', randomPeers.length);
        const randomPeer = randomPeers[0];
        const peerHost = new URL(randomPeer).hostname;

        span.addEvent('Trying peer', {
          peer_host: peerHost,
          attempt: attempt + 1,
        });

        try {
          const startTime = Date.now();
          const response = await axios({
            method: 'GET',
            url: `/chunk/${absoluteOffset}`,
            baseURL: randomPeer,
            timeout: 500,
          });
          const responseTime = Date.now() - startTime;

          const jsonChunk = response.data;

          // Fast fail if chunk has the wrong structure
          sanityCheckChunk(jsonChunk);

          const txPath = fromB64Url(jsonChunk.tx_path);
          const dataRootBuffer = txPath.slice(-64, -32);
          const dataPath = fromB64Url(jsonChunk.data_path);
          const hash = dataPath.slice(-64, -32);

          // Extract hostname from peer URL for source tracking
          const sourceHost = new URL(randomPeer).hostname;

          const chunk = {
            tx_path: txPath,
            data_root: dataRootBuffer,
            data_size: txSize,
            data_path: dataPath,
            offset: relativeOffset,
            hash,
            chunk: fromB64Url(jsonChunk.chunk),
            source: 'arweave-network',
            sourceHost,
          };

          await validateChunk(
            txSize,
            chunk,
            fromB64Url(dataRoot),
            relativeOffset,
          );

          span.setAttributes({
            'chunk.successful_peer': peerHost,
            'chunk.final_attempt': attempt + 1,
            'chunk.response_time_ms': responseTime,
            'chunk.size': chunk.chunk.length,
          });

          span.addEvent('Chunk retrieval and validation successful', {
            peer_host: peerHost,
            response_time_ms: responseTime,
            chunk_size: chunk.chunk.length,
          });

          this.handlePeerSuccess(
            randomPeer,
            'peerGetChunk',
            'peer',
            'weightedGetChunkPeers',
          );

          return chunk;
        } catch (error: any) {
          span.addEvent('Peer request failed', {
            peer_host: peerHost,
            error: error.message,
            attempt: attempt + 1,
          });

          this.handlePeerFailure(
            randomPeer,
            'peerGetChunk',
            'peer',
            'weightedGetChunkPeers',
          );

          // If this is the last attempt, throw the error
          if (attempt === retryCount - 1) {
            const finalError = new Error(
              `Failed to fetch chunk from any peer after ${retryCount} attempts`,
            );
            span.recordException(finalError);
            throw finalError;
          }
        }
      }

      span.addEvent('All attempts failed');
      const error = new Error('Failed to fetch chunk from any peer');
      span.recordException(error);
      throw error;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async getChunkByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<Chunk> {
    const span = tracer.startSpan('ArweaveCompositeClient.getChunkByAny', {
      attributes: {
        'chunk.data_root': dataRoot,
        'chunk.absolute_offset': absoluteOffset,
        'chunk.relative_offset': relativeOffset,
        'chunk.tx_size': txSize,
      },
    });

    try {
      this.failureSimulator.maybeFail();

      const cacheKey = JSON.stringify({
        absoluteOffset,
        txSize,
        dataRoot,
        relativeOffset,
      });

      const result = await this.chunkPromiseCache.get(cacheKey);

      span.setAttributes({
        'chunk.source': result.source ?? 'unknown',
        'chunk.source_host': result.sourceHost ?? 'unknown',
      });

      return result;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async getChunkDataByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkData> {
    const { hash, chunk, source, sourceHost } = await this.getChunkByAny({
      txSize,
      absoluteOffset,
      dataRoot,
      relativeOffset,
    });
    return {
      hash,
      chunk,
      source,
      sourceHost,
    };
  }

  async getChunkMetadataByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkMetadata> {
    this.failureSimulator.maybeFail();

    // Fetch the full chunk using the existing getChunkByAny method
    // This leverages the existing chunk caching
    const chunk = await this.getChunkByAny({
      txSize,
      absoluteOffset,
      dataRoot,
      relativeOffset,
    });

    // Extract and return only the metadata portion
    const metadata: ChunkMetadata = {
      data_root: chunk.data_root,
      data_size: chunk.data_size,
      data_path: chunk.data_path,
      offset: chunk.offset,
      hash: chunk.hash,
    };

    // Include chunk_size if it's available
    if (chunk.chunk_size !== undefined) {
      metadata.chunk_size = chunk.chunk_size;
    }

    return metadata;
  }

  async getData({
    id,
    region,
  }: {
    id: string;
    region?: Region;
  }): Promise<ContiguousData> {
    this.failureSimulator.maybeFail();

    try {
      const [dataResponse, dataSizeResponse] = await Promise.all([
        this.trustedNodeRequestQueue.push({
          method: 'GET',
          url: `/tx/${id}/data`,
        }),
        this.trustedNodeRequestQueue.push({
          method: 'GET',
          url: `/tx/${id}/data_size`,
        }),
      ]);

      if (!dataResponse.data) {
        throw Error('No transaction data');
      }

      const size = +dataSizeResponse.data;
      let txData = fromB64Url(dataResponse.data);

      if (region) {
        txData = txData.subarray(region.offset, region.offset + region.size);
      }

      const stream = Readable.from(txData);

      stream.on('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: dataResponse.config.baseURL,
        });
      });

      stream.on('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: dataResponse.config.baseURL,
        });
      });

      return {
        stream,
        size: region ? region.size : size,
        verified: false,
        trusted: true,
        cached: false,
      };
    } catch (error) {
      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
      });
      throw error;
    }
  }

  async getPendingTxIds(): Promise<string[]> {
    const response = await this.trustedNodeRequest({
      method: 'GET',
      url: '/tx/pending',
    });

    return response.data;
  }

  async broadcastChunk({
    chunk,
    abortTimeout = DEFAULT_CHUNK_POST_ABORT_TIMEOUT_MS,
    responseTimeout = DEFAULT_CHUNK_POST_RESPONSE_TIMEOUT_MS,
    originAndHopsHeaders,
    chunkPostMinSuccessCount,
    parentSpan,
  }: {
    chunk: JsonChunkPost;
    abortTimeout?: number;
    responseTimeout?: number;
    originAndHopsHeaders: Record<string, string | undefined>;
    chunkPostMinSuccessCount: number;
    parentSpan?: Span;
  }): Promise<BroadcastChunkResult> {
    const span = tracer.startSpan(
      'ArweaveCompositeClient.broadcastChunk',
      {
        attributes: {
          'chunk.data_root': chunk.data_root,
          'chunk.data_size': chunk.data_size,
          'chunk.min_success_count': chunkPostMinSuccessCount,
        },
      },
      ...(parentSpan ? [trace.setSpan(context.active(), parentSpan)] : []),
    );

    const startTime = Date.now();

    try {
      // 1. Get eligible peers (not over queue threshold)
      const eligiblePeers = this.getEligiblePeersForPost();
      span.setAttribute('chunk.eligible_peers', eligiblePeers.length);

      if (eligiblePeers.length === 0) {
        span.addEvent('No eligible peers available');
        this.log.warn('No eligible peers available for chunk broadcasting');
        return {
          successCount: 0,
          failureCount: 0,
          results: [],
        };
      }

      // 2. Get sorted peers from memoized function (cached for 10 seconds)
      const sortedPeers = this.getSortedChunkPostPeers(eligiblePeers);
      const preferredPeerCount = sortedPeers.filter((peer) =>
        this.isPreferredPeer(peer),
      ).length;
      const nonPreferredPeerCount = sortedPeers.length - preferredPeerCount;

      span.setAttribute('chunk.sorted_peers', sortedPeers.length);
      span.setAttribute('chunk.preferred_peers', preferredPeerCount);
      span.setAttribute('chunk.non_preferred_peers', nonPreferredPeerCount);

      // 3. Broadcast in parallel with concurrency limit
      const peerConcurrencyLimit = pLimit(config.CHUNK_POST_PEER_CONCURRENCY);
      let successCount = 0;
      let failureCount = 0;
      const results: BroadcastChunkResponses[] = [];

      this.log.debug('Starting chunk broadcast', {
        eligiblePeers: eligiblePeers.length,
        sortedPeers: sortedPeers.length,
        preferredPeers: preferredPeerCount,
        nonPreferredPeers: nonPreferredPeerCount,
        minSuccessCount: chunkPostMinSuccessCount,
        concurrency: config.CHUNK_POST_PEER_CONCURRENCY,
      });

      // Create promises for all peers
      const peerPromises = sortedPeers.map((peer) =>
        peerConcurrencyLimit(async () => {
          // Skip if we already have enough successes
          if (successCount >= chunkPostMinSuccessCount) {
            this.log.debug('Skipping peer due to success threshold reached', {
              peer,
            });
            return {
              success: true,
              statusCode: 200,
              canceled: false,
              timedOut: false,
              skipped: true,
            };
          }

          try {
            const result = await this.queueChunkPost(
              peer,
              chunk,
              abortTimeout,
              responseTimeout,
              originAndHopsHeaders,
              span,
            );

            if (result.success) {
              successCount++;
              this.log.debug('Chunk POST succeeded', { peer, successCount });
            } else {
              failureCount++;
              this.log.debug('Chunk POST failed', {
                peer,
                error: result.error,
              });
            }

            return {
              success: result.success,
              statusCode: result.statusCode ?? 0,
              canceled: result.canceled ?? false,
              timedOut: result.timedOut ?? false,
            };
          } catch (error: any) {
            failureCount++;
            this.log.debug('Chunk POST errored', {
              peer,
              error: error.message,
            });

            return {
              success: false,
              statusCode: 0,
              canceled: false,
              timedOut: false,
            };
          }
        }),
      );

      // Wait for all to complete
      const allResults = await Promise.allSettled(peerPromises);

      // Process results
      for (const result of allResults) {
        if (result.status === 'fulfilled' && !result.value.skipped) {
          results.push(result.value);
        }
      }

      const duration = Date.now() - startTime;

      span.setAttribute('chunk.broadcast.duration_ms', duration);
      span.setAttribute('chunk.broadcast.success_count', successCount);
      span.setAttribute('chunk.broadcast.failure_count', failureCount);
      span.setAttribute('chunk.broadcast.total_results', results.length);

      const succeeded = successCount >= chunkPostMinSuccessCount;
      span.setAttribute('chunk.broadcast.succeeded', succeeded);

      if (succeeded) {
        span.addEvent('Broadcast threshold reached');
      }

      this.log.debug('Chunk broadcast complete', {
        successCount,
        failureCount,
        totalPeers: sortedPeers.length,
        resultsCount: results.length,
        duration,
        succeeded,
      });

      // Update overall broadcast metrics
      if (succeeded) {
        metrics.arweaveChunkBroadcastCounter.inc({ status: 'success' });
      } else {
        metrics.arweaveChunkBroadcastCounter.inc({ status: 'fail' });
      }

      return {
        successCount,
        failureCount,
        results,
      };
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  queueDepth(): number {
    return this.trustedNodeRequestQueue.length();
  }
}
