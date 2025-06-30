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
import { default as wait } from 'wait';
import * as winston from 'winston';
import pLimit from 'p-limit';
import memoize from 'memoizee';

import { FailureSimulator } from '../lib/chaos.js';
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
import {
  BroadcastChunkResult,
  BroadcastChunkResponses,
  ChainSource,
  Chunk,
  ChunkBroadcaster,
  ChunkByAnySource,
  ChunkData,
  ChunkDataByAnySource,
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
  currentDepth: number;
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
    ContiguousDataSource,
    WithPeers<Peer>
{
  private arweave: Arweave;
  private log: winston.Logger;
  private failureSimulator: FailureSimulator;
  private txStore: PartialJsonTransactionStore;
  private blockStore: PartialJsonBlockStore;
  private chunkCache: WeakMap<
    { absoluteOffset: number },
    { cachedAt: number; chunk: Chunk }
  >;
  private skipCache: boolean;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredChunkGetUrls: string[];
  private weightedChainPeers: WeightedElement<string>[] = [];
  private weightedGetChunkPeers: WeightedElement<string>[] = [];
  private weightedPostChunkPeers: WeightedElement<string>[] = [];

  // New peer-based chunk POST system
  private preferredChunkPostUrls: string[];
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
    chunkCache = new WeakMap(),
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
  }: {
    log: winston.Logger;
    arweave: Arweave;
    trustedNodeUrl: string;
    blockStore: PartialJsonBlockStore;
    chunkCache?: WeakMap<
      { absoluteOffset: number },
      { cachedAt: number; chunk: Chunk }
    >;
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
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.preferredChunkGetUrls = preferredChunkGetUrls.map((url) =>
      url.replace(/\/$/, ''),
    );

    // TODO: use defaults in constructor instead of referencing config here

    // Initialize new peer-based chunk POST system
    this.preferredChunkPostUrls = config.PREFERRED_CHUNK_POST_NODE_URLS.map(
      (url) => url.replace(/\/$/, ''),
    );
    this.initializeChunkPostPeers();

    // Initialize memoized sorting function for chunk POST peers
    this.getSortedChunkPostPeers = memoize(
      (eligiblePeers: string[]) => {
        // Create a copy and sort by weight
        return [...eligiblePeers].sort(
          (a, b) => this.getPeerWeight(b) - this.getPeerWeight(a),
        );
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
    this.chunkCache = chunkCache;
    this.skipCache = skipCache;

    // Initialize trusted node Axios with automatic retries
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: requestTimeout,
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

  private initializePreferredChunkGetUrls(): void {
    // Initialize weightedGetChunkPeers with preferred URLs at high weight
    this.weightedGetChunkPeers = this.preferredChunkGetUrls.map((peerUrl) => ({
      id: peerUrl,
      weight: 100, // High weight for preferred chunk GET URLs
    }));
  }

  private initializeChunkPostPeers(): void {
    // Initialize weightedPostChunkPeers with preferred URLs at high weight
    this.weightedPostChunkPeers = this.preferredChunkPostUrls.map(
      (peerUrl) => ({
        id: peerUrl,
        weight: config.PREFERRED_CHUNK_POST_WEIGHT,
      }),
    );
  }

  private getOrCreatePeerQueue(peer: string): PeerChunkQueue {
    let peerQueue = this.peerChunkQueues.get(peer);

    if (!peerQueue) {
      peerQueue = {
        queue: fastq.promise(
          this.postChunkToPeer.bind(this),
          config.CHUNK_POST_PER_NODE_CONCURRENCY,
        ), // Concurrency per peer
        currentDepth: 0,
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
          peerQueue.currentDepth < config.CHUNK_POST_QUEUE_DEPTH_THRESHOLD
        );
      })
      .map((peer) => peer.id);
  }

  private getPeerWeight(peer: string): number {
    const weightedPeer = this.weightedPostChunkPeers.find((p) => p.id === peer);
    return weightedPeer?.weight ?? 1;
  }

  private updateChunkPostPeerWeight(peer: string, success: boolean): void {
    const peerIndex = this.weightedPostChunkPeers.findIndex(
      (p) => p.id === peer,
    );
    if (peerIndex !== -1) {
      const delta = config.WEIGHTED_PEERS_TEMPERATURE_DELTA;
      if (success) {
        this.weightedPostChunkPeers[peerIndex].weight = Math.min(
          this.weightedPostChunkPeers[peerIndex].weight + delta,
          100,
        );
      } else {
        this.weightedPostChunkPeers[peerIndex].weight = Math.max(
          this.weightedPostChunkPeers[peerIndex].weight - delta,
          1,
        );
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
  ): Promise<ChunkPostResult> {
    const peerQueue = this.getOrCreatePeerQueue(peer);

    // Check queue depth
    if (peerQueue.currentDepth >= config.CHUNK_POST_QUEUE_DEPTH_THRESHOLD) {
      throw new Error(`Peer ${peer} queue depth exceeded`);
    }

    // Queue the chunk post
    peerQueue.currentDepth++;
    peerQueue.totalAttempts++;

    try {
      const result = await peerQueue.queue.push({
        peer,
        chunk,
        abortTimeout,
        responseTimeout,
        headers,
      });

      if (result.success) {
        peerQueue.totalSuccesses++;
        this.updateChunkPostPeerWeight(peer, true);
      } else {
        this.updateChunkPostPeerWeight(peer, false);
      }

      return result;
    } finally {
      peerQueue.currentDepth--;
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

      // Update GET chunk peers (preserve preferred URLs)
      const preferredChunkGetEntries = this.weightedGetChunkPeers.filter(
        (peer) => this.preferredChunkGetUrls.includes(peer.id),
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
        (peer) => this.preferredChunkPostUrls.includes(peer.id),
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
    for (let attempt = 0; attempt < retryCount; attempt++) {
      // Select a random set of peers for each retry attempt
      const randomPeers = this.selectPeers(
        peerSelectionCount,
        'weightedGetChunkPeers',
      );

      if (randomPeers.length === 0) {
        throw new Error('No peers available for chunk retrieval');
      }

      const randomPeer = randomPeers[0];

      try {
        const response = await axios({
          method: 'GET',
          url: `/chunk/${absoluteOffset}`,
          baseURL: randomPeer,
          timeout: 500,
        });
        const jsonChunk = response.data;

        // Fast fail if chunk has the wrong structure
        sanityCheckChunk(jsonChunk);

        const txPath = fromB64Url(jsonChunk.tx_path);
        const dataRootBuffer = txPath.slice(-64, -32);
        const dataPath = fromB64Url(jsonChunk.data_path);
        const hash = dataPath.slice(-64, -32);

        const chunk = {
          tx_path: txPath,
          data_root: dataRootBuffer,
          data_size: txSize,
          data_path: dataPath,
          offset: relativeOffset,
          hash,
          chunk: fromB64Url(jsonChunk.chunk),
        };

        await validateChunk(
          txSize,
          chunk,
          fromB64Url(dataRoot),
          relativeOffset,
        );

        this.handlePeerSuccess(
          randomPeer,
          'peerGetChunk',
          'peer',
          'weightedGetChunkPeers',
        );

        this.chunkCache.set(
          { absoluteOffset },
          {
            cachedAt: Date.now(),
            chunk,
          },
        );

        return chunk;
      } catch {
        this.handlePeerFailure(
          randomPeer,
          'peerGetChunk',
          'peer',
          'weightedGetChunkPeers',
        );

        // If this is the last attempt, throw the error
        if (attempt === retryCount - 1) {
          throw new Error(
            `Failed to fetch chunk from any peer after ${retryCount} attempts`,
          );
        }
      }
    }

    throw new Error('Failed to fetch chunk from any peer');
  }

  async getChunkByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<Chunk> {
    this.failureSimulator.maybeFail();

    // Check cache first
    const cacheEntry = this.chunkCache.get({ absoluteOffset });
    if (
      cacheEntry &&
      cacheEntry.cachedAt > Date.now() - CHUNK_CACHE_TTL_SECONDS * 1000
    ) {
      metrics.getChunkTotal.inc({
        status: 'success',
        method: 'getChunkByAny',
        class: this.constructor.name,
      });
      return cacheEntry.chunk;
    }

    // Only use peer-based chunk retrieval
    try {
      const result = await this.peerGetChunk({
        absoluteOffset,
        txSize,
        dataRoot,
        relativeOffset,
      });
      metrics.getChunkTotal.inc({
        status: 'success',
        method: 'getChunkByAny',
        class: this.constructor.name,
      });
      return result;
    } catch (error: any) {
      metrics.getChunkTotal.inc({
        status: 'error',
        method: 'getChunkByAny',
        class: this.constructor.name,
      });
      this.log.warn('Unable to fetch chunk from peers', {
        messsage: error.message,
        stack: error.stack,
      });
      throw new Error('Unable to fetch chunk from any available peers');
    }
  }

  async getChunkDataByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkData> {
    const { hash, chunk } = await this.getChunkByAny({
      txSize,
      absoluteOffset,
      dataRoot,
      relativeOffset,
    });
    return {
      hash,
      chunk,
    };
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
  }: {
    chunk: JsonChunkPost;
    abortTimeout?: number;
    responseTimeout?: number;
    originAndHopsHeaders: Record<string, string | undefined>;
    chunkPostMinSuccessCount: number;
  }): Promise<BroadcastChunkResult> {
    const startTime = Date.now();

    // 1. Get eligible peers (not over queue threshold)
    const eligiblePeers = this.getEligiblePeersForPost();

    if (eligiblePeers.length === 0) {
      this.log.warn('No eligible peers available for chunk broadcasting');
      return {
        successCount: 0,
        failureCount: 0,
        results: [],
      };
    }

    // 2. Get sorted peers from memoized function (cached for 10 seconds)
    const sortedPeers = this.getSortedChunkPostPeers(eligiblePeers);

    // 3. Broadcast in parallel with concurrency limit
    const peerConcurrencyLimit = pLimit(config.CHUNK_POST_PEER_CONCURRENCY);
    let successCount = 0;
    let failureCount = 0;
    const results: BroadcastChunkResponses[] = [];

    this.log.debug('Starting chunk broadcast', {
      eligiblePeers: eligiblePeers.length,
      sortedPeers: sortedPeers.length,
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
          );

          if (result.success) {
            successCount++;
            this.log.debug('Chunk POST succeeded', { peer, successCount });
          } else {
            failureCount++;
            this.log.debug('Chunk POST failed', { peer, error: result.error });
          }

          return {
            success: result.success,
            statusCode: result.statusCode ?? 0,
            canceled: result.canceled ?? false,
            timedOut: result.timedOut ?? false,
          };
        } catch (error: any) {
          failureCount++;
          this.log.debug('Chunk POST errored', { peer, error: error.message });

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

    this.log.debug('Chunk broadcast complete', {
      successCount,
      failureCount,
      totalPeers: sortedPeers.length,
      resultsCount: results.length,
      duration,
      succeeded: successCount >= chunkPostMinSuccessCount,
    });

    // Update overall broadcast metrics
    if (successCount >= chunkPostMinSuccessCount) {
      metrics.arweaveChunkBroadcastCounter.inc({ status: 'success' });
    } else {
      metrics.arweaveChunkBroadcastCounter.inc({ status: 'fail' });
    }

    return {
      successCount,
      failureCount,
      results,
    };
  }

  queueDepth(): number {
    return this.trustedNodeRequestQueue.length();
  }
}
