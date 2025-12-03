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
import { context, trace, Span } from '@opentelemetry/api';
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';
import { LRUCache } from 'lru-cache';

import { FailureSimulator } from '../lib/chaos.js';
import { fromB64Url } from '../lib/encoding.js';
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
  ArweavePeerManager,
  type ArweavePeerCategory,
} from '../peers/arweave-peer-manager.js';
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
  RequestAttributes,
  UnvalidatedChunk,
  UnvalidatedChunkSource,
} from '../types.js';
import { MAX_FORK_DEPTH } from './constants.js';
import { BlockOffsetMapping } from './block-offset-mapping.js';

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
const DEFAULT_PEER_TX_TIMEOUT_MS = 5000;
const PEER_CHUNK_REQUEST_TIMEOUT_MS = 500;

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

export class ArweaveCompositeClient
  implements
    ChainSource,
    ChunkBroadcaster,
    ChunkByAnySource,
    ChunkDataByAnySource,
    ChunkMetadataByAnySource,
    ContiguousDataSource,
    UnvalidatedChunkSource
{
  private arweave: Arweave;
  private log: winston.Logger;
  private failureSimulator: FailureSimulator;
  private txStore: PartialJsonTransactionStore;
  private blockStore: PartialJsonBlockStore;
  private chunkPromiseCache: ReadThroughPromiseCache<string, Chunk>;
  private skipCache: boolean;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peer management
  public peerManager: ArweavePeerManager;

  // Binary search caches (configured via environment variables)
  private blockCache = new LRUCache<string, any>({
    max: config.CHUNK_OFFSET_CHAIN_FALLBACK_BLOCK_CACHE_SIZE,
    ttl: config.CHUNK_OFFSET_CHAIN_FALLBACK_BLOCK_CACHE_TTL_MS,
  });
  private txOffsetCache = new LRUCache<
    string,
    { offset: number; size: number }
  >({
    max: config.CHUNK_OFFSET_CHAIN_FALLBACK_TX_OFFSET_CACHE_SIZE,
    ttl: config.CHUNK_OFFSET_CHAIN_FALLBACK_TX_OFFSET_CACHE_TTL_MS,
  });
  private txDataCache = new LRUCache<string, any>({
    max: config.CHUNK_OFFSET_CHAIN_FALLBACK_TX_DATA_CACHE_SIZE,
    ttl: config.CHUNK_OFFSET_CHAIN_FALLBACK_TX_DATA_CACHE_TTL_MS,
  });

  // Static offset-to-block mapping for optimizing binary search
  private blockOffsetMapping?: BlockOffsetMapping;

  // New peer-based chunk POST system
  private peerChunkQueues: Map<string, PeerChunkQueue> = new Map();
  private getSortedChunkPostPeers: (eligiblePeers: string[]) => string[];
  // Timer references for cleanup
  private bucketFillerInterval?: NodeJS.Timeout;

  // Block and TX promise caches used for prefetching
  private blockByHeightPromiseCache: NodeCache;
  private txPromiseCache: NodeCache;

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
    peerManager,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
    requestRetryCount = DEFAULT_REQUEST_RETRY_COUNT,
    maxRequestsPerSecond = DEFAULT_MAX_REQUESTS_PER_SECOND,
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    blockPrefetchCount = DEFAULT_BLOCK_PREFETCH_COUNT,
    blockTxPrefetchCount = DEFAULT_BLOCK_TX_PREFETCH_COUNT,
    skipCache = false,
    cacheCheckPeriodSeconds = 10,
    blockOffsetMapping,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    trustedNodeUrl: string;
    blockStore: PartialJsonBlockStore;
    txStore: PartialJsonTransactionStore;
    failureSimulator: FailureSimulator;
    peerManager: ArweavePeerManager;
    requestTimeout?: number;
    requestRetryCount?: number;
    requestPerSecond?: number;
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
    blockPrefetchCount?: number;
    blockTxPrefetchCount?: number;
    skipCache?: boolean;
    cacheCheckPeriodSeconds?: number;
    blockOffsetMapping?: BlockOffsetMapping;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.peerManager = peerManager;
    this.blockOffsetMapping = blockOffsetMapping;

    // Initialize memoized sorting function for chunk POST peers
    this.getSortedChunkPostPeers = memoize(
      (eligiblePeers: string[]) => {
        // Prioritize eligible peers chosen by weighted selection; never introduce ineligible ones
        const selected = new Set(
          this.peerManager.selectPeers('postChunk', eligiblePeers.length),
        );
        const prioritized = eligiblePeers.filter((p) => selected.has(p));
        const remainder = eligiblePeers.filter((p) => !selected.has(p));
        return [...prioritized, ...remainder];
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

    // Initialize NodeCache instances with configurable check period
    this.blockByHeightPromiseCache = new NodeCache({
      checkperiod: cacheCheckPeriodSeconds,
      stdTTL: 30,
      useClones: false, // cloning promises is unsafe
    });
    this.txPromiseCache = new NodeCache({
      checkperiod: cacheCheckPeriodSeconds,
      stdTTL: 60,
      useClones: false, // cloning promises is unsafe
    });

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
    this.bucketFillerInterval = setInterval(() => {
      if (this.trustedNodeRequestBucket <= maxRequestsPerSecond * 300) {
        this.trustedNodeRequestBucket += maxRequestsPerSecond;
      }
    }, 1000);

    // Initialize prefetch settings
    this.blockPrefetchCount = blockPrefetchCount;
    this.blockTxPrefetchCount = blockTxPrefetchCount;
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
    return this.peerManager.getPeerUrls('postChunk').filter((peerUrl) => {
      const peerQueue = this.peerChunkQueues.get(peerUrl);
      return (
        !peerQueue ||
        peerQueue.queue.length() < config.CHUNK_POST_QUEUE_DEPTH_THRESHOLD
      );
    });
  }

  private async postChunkToPeer(task: ChunkPostTask): Promise<ChunkPostResult> {
    try {
      this.failureSimulator.maybeFail();

      // Dry-run mode: Validate chunk and skip actual HTTP POST
      // This allows testing uploads without burning AR tokens while still
      // verifying that chunks are properly formatted and have valid merkle proofs
      if (config.ARWEAVE_POST_DRY_RUN) {
        // Skip validation if configured
        if (config.ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION) {
          this.log.debug(
            'Dry-run mode: Skipping chunk POST (validation disabled)',
            {
              peer: task.peer,
              dataRoot: task.chunk.data_root,
            },
          );

          metrics.arweaveChunkPostCounter.inc({
            endpoint: task.peer,
            status: 'success',
          });

          return {
            success: true,
            statusCode: 200,
          };
        }

        // Validate required fields exist
        if (
          !task.chunk.chunk ||
          !task.chunk.data_path ||
          !task.chunk.data_root ||
          !task.chunk.data_size ||
          !task.chunk.offset
        ) {
          this.log.warn(
            'Dry-run mode: Invalid chunk - missing required fields',
            {
              peer: task.peer,
              hasChunk: !!task.chunk.chunk,
              hasDataPath: !!task.chunk.data_path,
              hasDataRoot: !!task.chunk.data_root,
              hasDataSize: !!task.chunk.data_size,
              hasOffset: !!task.chunk.offset,
            },
          );

          metrics.arweaveChunkPostCounter.inc({
            endpoint: task.peer,
            status: 'fail',
          });

          return {
            success: false,
            statusCode: 400,
          };
        }

        // Validate merkle proof
        try {
          const chunkBuffer = fromB64Url(task.chunk.chunk);
          const dataPathBuffer = fromB64Url(task.chunk.data_path);
          const dataRootBuffer = fromB64Url(task.chunk.data_root);
          const dataSize = parseInt(task.chunk.data_size, 10);
          const offset = parseInt(task.chunk.offset, 10);

          // Create a Chunk object for validation
          const chunkForValidation: Chunk = {
            chunk: chunkBuffer,
            data_path: dataPathBuffer,
            data_root: dataRootBuffer,
            data_size: dataSize,
            offset: offset,
            hash: Buffer.alloc(0), // Not needed for validation
          };

          await validateChunk(
            dataSize,
            chunkForValidation,
            dataRootBuffer,
            offset,
          );

          this.log.debug(
            'Dry-run mode: Chunk validated successfully, skipping POST',
            {
              peer: task.peer,
              dataRoot: task.chunk.data_root,
              dataSize: task.chunk.data_size,
              offset: task.chunk.offset,
            },
          );
        } catch (error: any) {
          this.log.warn('Dry-run mode: Chunk validation failed', {
            peer: task.peer,
            dataRoot: task.chunk.data_root,
            error: error.message,
          });

          metrics.arweaveChunkPostCounter.inc({
            endpoint: task.peer,
            status: 'fail',
          });

          return {
            success: false,
            statusCode: 400,
          };
        }

        metrics.arweaveChunkPostCounter.inc({
          endpoint: task.peer,
          status: 'success',
        });

        return {
          success: true,
          statusCode: 200,
        };
      }

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
        this.peerManager.reportSuccess('postChunk', peer);
        span.addEvent('Chunk POST succeeded');
      } else {
        if (result.error !== undefined) {
          span.addEvent('Chunk POST failed', { error: result.error });
        }
        this.peerManager.reportFailure('postChunk', peer);
      }

      return result;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
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
    const peersToTry = this.peerManager.selectPeers('chain', retryCount);

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
            this.handlePeerSuccess(peerUrl, 'peerGetTx', 'peer', 'chain');

            const tx = this.arweave.transactions.fromRaw(response.data);
            const isValid = await this.arweave.transactions.verify(tx);
            if (!isValid) {
              // If TX is invalid, mark this peer as failed and reject.
              throw new Error(`Invalid TX from peer: ${peerUrl}`);
            }

            return response;
          } catch (err) {
            // On error, mark this peer as failed and reject the promise for this peer.
            this.handlePeerFailure(peerUrl, 'peerGetTx', 'peer', 'chain');
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

    const response = (
      await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/tx/${txId}/offset`,
      })
    ).data;

    // Ensure offset and size are numbers (API might return strings)
    return {
      offset:
        typeof response.offset === 'string'
          ? parseInt(response.offset)
          : response.offset,
      size:
        typeof response.size === 'string'
          ? parseInt(response.size)
          : response.size,
    };
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
    sourceType: 'trusted' | 'preferred' | 'peer',
    category: ArweavePeerCategory,
    peerType?: 'bucket' | 'general',
  ): void {
    if (method === 'peerGetChunk') {
      metrics.requestChunkTotal.inc({
        status: 'success',
        method,
        class: this.constructor.name,
        source: peer,
        source_type: sourceType,
        peer_type: peerType || 'unknown',
      });
    }
    if (sourceType === 'peer') {
      this.peerManager.reportSuccess(category, peer);
    }
  }

  handlePeerFailure(
    peer: string,
    method: string,
    sourceType: 'trusted' | 'preferred' | 'peer',
    category: ArweavePeerCategory,
    peerType?: 'bucket' | 'general',
  ): void {
    if (method === 'peerGetChunk') {
      metrics.requestChunkTotal.inc({
        status: 'error',
        method,
        class: this.constructor.name,
        source: peer,
        source_type: sourceType,
        peer_type: peerType || 'unknown',
      });
    }
    if (sourceType === 'peer') {
      this.peerManager.reportFailure(category, peer);
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
      // Try bucket-specific peers first, then general peers as fallback
      const bucketPeers = this.peerManager.selectBucketPeersForOffset(
        absoluteOffset,
        Math.max(peerSelectionCount, retryCount), // Get more bucket peers upfront
      );

      // Get general peers as secondary fallback (excluding bucket peers to avoid duplicates)
      const allGeneralPeers = this.peerManager.selectPeers(
        'getChunk',
        Math.max(peerSelectionCount, retryCount),
      );

      // Filter out bucket peers from general peers to avoid duplicates
      const bucketPeerSet = new Set(bucketPeers);
      const generalPeers = allGeneralPeers.filter(
        (peer) => !bucketPeerSet.has(peer),
      );

      // Combine: bucket peers first, then general peers
      const orderedPeers = [...bucketPeers, ...generalPeers];

      this.log.debug('Peer selection for chunk request', {
        absoluteOffset,
        bucketPeers: bucketPeers.length,
        generalPeers: generalPeers.length,
        totalSelectedPeers: orderedPeers.length,
        maxAttempts: Math.min(orderedPeers.length, retryCount),
        peers: orderedPeers.slice(0, 3), // Log first 3 peers for debugging
      });

      if (orderedPeers.length === 0) {
        const error = new Error('No peers available for chunk retrieval');
        span.recordException(error);
        this.log.error('No peers available for chunk retrieval', {
          absoluteOffset,
        });
        throw error;
      }

      span.setAttributes({
        'chunk.available_peers': orderedPeers.length,
        'chunk.bucket_peers': bucketPeers.length,
        'chunk.general_peers': generalPeers.length,
      });

      // Iterate through peers sequentially (bucket peers first, then general)
      const maxAttempts = Math.min(orderedPeers.length, retryCount);
      for (let peerIndex = 0; peerIndex < maxAttempts; peerIndex++) {
        // Check if we're transitioning from bucket peers to general peers
        const isBucketPeer = peerIndex < bucketPeers.length;
        const isTransition =
          peerIndex === bucketPeers.length && bucketPeers.length > 0;

        if (isTransition) {
          span.addEvent('Transitioning to general peers', {
            bucket_peers_tried: bucketPeers.length,
            remaining_general_peers: generalPeers.length,
          });
          this.log.debug('All bucket peers failed, trying general peers', {
            absoluteOffset,
            bucketPeersTried: bucketPeers.length,
            remainingGeneralPeers: generalPeers.length,
          });

          // Track transition metric
          metrics.chunkPeerTransitionTotal.inc({
            method: 'peerGetChunk',
          });
        }

        span.addEvent('Starting peer attempt', {
          peer_index: peerIndex + 1,
          total_peers: orderedPeers.length,
          max_attempts: maxAttempts,
          peer_type: isBucketPeer ? 'bucket' : 'general',
        });

        const randomPeer = orderedPeers[peerIndex];
        const peerHost = new URL(randomPeer).hostname;

        span.addEvent('Trying peer', {
          peer_host: peerHost,
          peer_index: peerIndex + 1,
          total_peers: orderedPeers.length,
          peer_type: isBucketPeer ? 'bucket' : 'general',
        });

        const requestUrl = `${randomPeer}/chunk/${absoluteOffset}`;

        this.log.debug('Making chunk request to peer', {
          peer: randomPeer,
          peerHost,
          absoluteOffset,
          requestUrl,
          timeout: PEER_CHUNK_REQUEST_TIMEOUT_MS,
          peerIndex: peerIndex + 1,
          totalPeers: orderedPeers.length,
          peerType: isBucketPeer ? 'bucket' : 'general',
        });

        const startTime = Date.now();

        try {
          const response = await axios({
            method: 'GET',
            url: requestUrl,
            timeout: PEER_CHUNK_REQUEST_TIMEOUT_MS,
          });
          const responseTime = Date.now() - startTime;

          this.log.debug('Received chunk response from peer', {
            peer: randomPeer,
            peerHost,
            absoluteOffset,
            responseTime,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers['content-type'],
            dataSize: JSON.stringify(response.data).length,
            peerIndex: peerIndex + 1,
            totalPeers: orderedPeers.length,
          });

          const jsonChunk = response.data;

          // Fast fail if chunk has the wrong structure
          try {
            sanityCheckChunk(jsonChunk);
          } catch (sanityError: any) {
            this.log.warn('Chunk failed sanity check', {
              peer: randomPeer,
              peerHost,
              absoluteOffset,
              sanityError: sanityError.message,
              chunkData: jsonChunk,
              peerIndex: peerIndex + 1,
              totalPeers: orderedPeers.length,
            });
            throw sanityError;
          }

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

          try {
            await validateChunk(
              txSize,
              chunk,
              fromB64Url(dataRoot),
              relativeOffset,
            );
          } catch (validationError: any) {
            this.log.warn('Chunk failed validation', {
              peer: randomPeer,
              peerHost,
              absoluteOffset,
              txSize,
              dataRoot,
              relativeOffset,
              validationError: validationError.message,
              chunkSize: chunk.chunk.length,
              peerIndex: peerIndex + 1,
              totalPeers: orderedPeers.length,
            });
            throw validationError;
          }

          span.setAttributes({
            'chunk.successful_peer': peerHost,
            'chunk.final_peer_index': peerIndex + 1,
            'chunk.total_peers_tried': peerIndex + 1,
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
            this.peerManager.isPreferredChunkGetPeer(randomPeer)
              ? 'preferred'
              : 'peer',
            'getChunk',
            isBucketPeer ? 'bucket' : 'general',
          );

          return chunk;
        } catch (error: any) {
          const responseTime = Date.now() - startTime;

          // Log essential error information only
          const errorDetails = {
            peer: randomPeer,
            peerHost,
            absoluteOffset,
            peerIndex: peerIndex + 1,
            totalPeers: orderedPeers.length,
            responseTime,
            error: error.message,
            ...(axios.isAxiosError(error) && {
              code: error.code,
              status: error.response?.status,
            }),
          };

          this.log.debug('Chunk request failed', errorDetails);

          span.addEvent('Peer request failed', {
            peer_host: peerHost,
            error: error.message,
            peer_index: peerIndex + 1,
            total_peers: orderedPeers.length,
            error_code: error.code,
            http_status: error.response?.status,
          });

          this.handlePeerFailure(
            randomPeer,
            'peerGetChunk',
            this.peerManager.isPreferredChunkGetPeer(randomPeer)
              ? 'preferred'
              : 'peer',
            'getChunk',
            isBucketPeer ? 'bucket' : 'general',
          );

          // Continue to next peer (no early exit needed in for loop)
        }
      }

      // If we exit the loop without returning, all peers failed
      span.addEvent('All peers failed', {
        total_peers_tried: maxAttempts,
        available_peers: orderedPeers.length,
      });
      const error = new Error(
        `Failed to fetch chunk from ${maxAttempts} peers (${orderedPeers.length} available)`,
      );
      span.recordException(error);
      throw error;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    const { txSize, absoluteOffset, dataRoot, relativeOffset } = params;

    const span = tracer.startSpan('ArweaveCompositeClient.getChunkByAny', {
      attributes: {
        'chunk.absolute_offset': absoluteOffset,
        'chunk.data_root': dataRoot,
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

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    const { hash, chunk, source, sourceHost } =
      await this.getChunkByAny(params);
    return {
      hash,
      chunk,
      source,
      sourceHost,
    };
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkMetadata> {
    this.failureSimulator.maybeFail();

    // Fetch the full chunk using the existing getChunkByAny method
    // This leverages the existing chunk caching
    const chunk = await this.getChunkByAny(params);

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

    // Include tx_path if it's available
    if (chunk.tx_path !== undefined) {
      metadata.tx_path = chunk.tx_path;
    }

    return metadata;
  }

  /**
   * Fetch chunk from Arweave peers WITHOUT validation.
   * Validation is deferred to the handler level.
   */
  async getUnvalidatedChunk(
    absoluteOffset: number,
    _requestAttributes?: RequestAttributes,
  ): Promise<UnvalidatedChunk> {
    const span = tracer.startSpan(
      'ArweaveCompositeClient.getUnvalidatedChunk',
      {
        attributes: {
          'chunk.absolute_offset': absoluteOffset,
        },
      },
    );

    try {
      this.failureSimulator.maybeFail();

      // Select peers for chunk retrieval
      const peerSelectionCount = 10;
      const retryCount = 5;

      const bucketPeers = this.peerManager.selectBucketPeersForOffset(
        absoluteOffset,
        Math.max(peerSelectionCount, retryCount),
      );

      const allGeneralPeers = this.peerManager.selectPeers(
        'getChunk',
        Math.max(peerSelectionCount, retryCount),
      );

      const bucketPeerSet = new Set(bucketPeers);
      const generalPeers = allGeneralPeers.filter(
        (peer) => !bucketPeerSet.has(peer),
      );

      const orderedPeers = [...bucketPeers, ...generalPeers];

      if (orderedPeers.length === 0) {
        throw new Error('No peers available for chunk retrieval');
      }

      span.setAttributes({
        'chunk.available_peers': orderedPeers.length,
        'chunk.bucket_peers': bucketPeers.length,
        'chunk.general_peers': generalPeers.length,
      });

      const maxAttempts = Math.min(orderedPeers.length, retryCount);

      for (let peerIndex = 0; peerIndex < maxAttempts; peerIndex++) {
        const isBucketPeer = peerIndex < bucketPeers.length;
        const peer = orderedPeers[peerIndex];
        const peerHost = new URL(peer).hostname;

        span.addEvent('Trying peer', {
          peer_host: peerHost,
          peer_index: peerIndex + 1,
          peer_type: isBucketPeer ? 'bucket' : 'general',
        });

        const startTime = Date.now();

        try {
          // Fetch chunk from peer
          const response = await axios({
            method: 'GET',
            url: `${peer}/chunk/${absoluteOffset}`,
            timeout: PEER_CHUNK_REQUEST_TIMEOUT_MS,
          });

          const responseTime = Date.now() - startTime;
          const jsonChunk = response.data;

          // Basic sanity check
          sanityCheckChunk(jsonChunk);

          // Parse chunk response
          const txPathBuffer = jsonChunk.tx_path
            ? fromB64Url(jsonChunk.tx_path)
            : undefined;
          const dataPathBuffer = fromB64Url(jsonChunk.data_path);
          const hash = dataPathBuffer.slice(-64, -32);
          const chunkBuffer = fromB64Url(jsonChunk.chunk);

          span.addEvent('Unvalidated chunk retrieval successful', {
            peer_host: peerHost,
            chunk_size: chunkBuffer.length,
            has_tx_path: txPathBuffer !== undefined,
            response_time_ms: responseTime,
          });

          // Report success
          this.handlePeerSuccess(
            peer,
            'peerGetChunk',
            this.peerManager.isPreferredChunkGetPeer(peer)
              ? 'preferred'
              : 'peer',
            'getChunk',
            isBucketPeer ? 'bucket' : 'general',
          );

          // Return unvalidated chunk (NO validation performed)
          return {
            chunk: chunkBuffer,
            hash,
            data_path: dataPathBuffer,
            tx_path: txPathBuffer,
            source: 'arweave-peers',
            sourceHost: peerHost,
          };
        } catch (error: any) {
          const responseTime = Date.now() - startTime;
          span.addEvent('Peer request failed', {
            peer_host: peerHost,
            error: error.message,
            response_time_ms: responseTime,
          });

          // Report failure
          this.handlePeerFailure(
            peer,
            'peerGetChunk',
            this.peerManager.isPreferredChunkGetPeer(peer)
              ? 'preferred'
              : 'peer',
            'getChunk',
            isBucketPeer ? 'bucket' : 'general',
          );
          // Continue to next peer
        }
      }

      // All retry attempts failed
      const error = new Error(
        `Failed to fetch unvalidated chunk from Arweave peers after ${maxAttempts} attempts`,
      );
      span.recordException(error);
      throw error;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
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

      const requestType = region ? 'range' : 'full';

      stream.on('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: dataResponse.config.baseURL,
          request_type: requestType,
        });
      });

      stream.on('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: dataResponse.config.baseURL,
          request_type: requestType,
        });

        // Track bytes streamed
        const bytesStreamed = region ? region.size : size;
        metrics.getDataStreamBytesTotal.inc(
          {
            class: this.constructor.name,
            source: dataResponse.config.baseURL,
            request_type: requestType,
          },
          bytesStreamed,
        );

        metrics.getDataStreamSizeHistogram.observe(
          {
            class: this.constructor.name,
            source: dataResponse.config.baseURL,
            request_type: requestType,
          },
          bytesStreamed,
        );
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

  /**
   * Broadcasts a chunk to multiple AR.IO peers in parallel with early termination.
   *
   * The broadcast uses two early termination conditions:
   * 1. **Success threshold**: Stops when `chunkPostMinSuccessCount` peers accept the chunk
   * 2. **Consecutive failures**: Stops after `CHUNK_POST_MAX_CONSECUTIVE_FAILURES` consecutive
   *    4xx responses when no peers have accepted the chunk (configurable, 0 to disable)
   *
   * @param chunk - The chunk data to broadcast
   * @param abortTimeout - Timeout for aborting in-flight requests after success threshold
   * @param responseTimeout - Timeout for individual peer requests
   * @param originAndHopsHeaders - Headers to propagate for request tracing
   * @param chunkPostMinSuccessCount - Minimum successful posts to consider broadcast complete
   * @param parentSpan - Optional parent span for distributed tracing
   * @returns Results including success/failure counts and per-peer response details
   */
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

      span.setAttribute('chunk.sorted_peers', sortedPeers.length);

      // Calculate preferred vs non-preferred peer counts for logging
      const preferredChunkPostUrls =
        this.peerManager.getPreferredChunkPostUrls();
      const preferredPeerCount = sortedPeers.filter((peer) =>
        preferredChunkPostUrls.includes(peer),
      ).length;
      const nonPreferredPeerCount = sortedPeers.length - preferredPeerCount;

      // 3. Broadcast in parallel with concurrency limit
      const peerConcurrencyLimit = pLimit(config.CHUNK_POST_PEER_CONCURRENCY);

      // Note: These counters are accessed concurrently by multiple tasks. This is
      // acceptable because they're used for optimization heuristics (early termination),
      // not correctness. Race conditions could cause undercounting, which means we may
      // send a few extra requests before early termination kicks in. Logged and traced
      // counts may also be slightly inaccurate; use the results array for precise values.
      let successCount = 0;
      let failureCount = 0;
      let consecutive4xxFailures = 0;
      let hasAnySuccess = false;
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
              skipReason: 'success_threshold' as const,
            };
          }

          // Skip if consecutive 4xx failures reached (only when no successes)
          if (
            config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES > 0 &&
            !hasAnySuccess &&
            consecutive4xxFailures >= config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES
          ) {
            this.log.debug(
              'Skipping peer due to consecutive 4xx failures threshold',
              {
                peer,
                consecutive4xxFailures,
              },
            );
            return {
              success: false,
              statusCode: 0,
              canceled: false,
              timedOut: false,
              skipped: true,
              skipReason: 'consecutive_failures' as const,
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

            const statusCode = result.statusCode ?? 0;

            if (result.success) {
              successCount++;
              hasAnySuccess = true;
              consecutive4xxFailures = 0;
              this.log.debug('Chunk POST succeeded', { peer, successCount });
            } else {
              failureCount++;
              // Only count 4xx responses toward consecutive failures
              if (statusCode >= 400 && statusCode < 500) {
                consecutive4xxFailures++;
              } else {
                consecutive4xxFailures = 0;
              }
              this.log.debug('Chunk POST failed', {
                peer,
                statusCode,
                consecutive4xxFailures,
                error: result.error,
              });
            }

            return {
              success: result.success,
              statusCode,
              canceled: result.canceled ?? false,
              timedOut: result.timedOut ?? false,
            };
          } catch (error: any) {
            failureCount++;
            // Network errors reset the consecutive 4xx counter
            consecutive4xxFailures = 0;
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

      // Determine early termination reason
      // Only report 'consecutive_failures' when:
      // 1. Feature is enabled (config > 0)
      // 2. No peers have accepted the chunk (!hasAnySuccess)
      // 3. We hit the consecutive failure threshold
      const terminatedDueToConsecutiveFailures =
        config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES > 0 &&
        !hasAnySuccess &&
        consecutive4xxFailures >= config.CHUNK_POST_MAX_CONSECUTIVE_FAILURES;

      const earlyTerminationReason = succeeded
        ? 'success_threshold'
        : terminatedDueToConsecutiveFailures
          ? 'consecutive_failures'
          : 'completed';
      span.setAttribute(
        'chunk.broadcast.early_termination_reason',
        earlyTerminationReason,
      );

      if (succeeded) {
        span.addEvent('Broadcast threshold reached');
      } else if (earlyTerminationReason === 'consecutive_failures') {
        span.addEvent('Broadcast stopped due to consecutive 4xx failures');
      }

      this.log.debug('Chunk broadcast complete', {
        successCount,
        failureCount,
        consecutive4xxFailures,
        totalPeers: sortedPeers.length,
        resultsCount: results.length,
        duration,
        succeeded,
        earlyTerminationReason,
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

  /**
   * Find transaction that contains the given offset using binary search on the chain
   */
  async findTxByOffset(offset: number): Promise<{
    txId: string;
    txOffset: number;
    txSize: number;
    txStartOffset: number;
    txEndOffset: number;
  } | null> {
    const searchId = Math.random().toString(36).substring(7);
    this.log.debug('Starting binary search for transaction by offset', {
      offset,
      searchId,
    });

    try {
      // First, find the block that contains this offset
      this.log.debug('Phase 1: Searching for containing block', {
        offset,
        searchId,
      });

      const containingBlock = await this.binarySearchBlocks(offset);
      if (!containingBlock) {
        this.log.debug(
          'Binary search completed: No block found containing offset',
          {
            offset,
            searchId,
            result: 'not_found',
          },
        );
        return null;
      }

      this.log.debug('Phase 1 completed: Found containing block', {
        blockHeight: containingBlock.height,
        blockOffset: containingBlock.weave_size,
        txCount: containingBlock.txs?.length || 0,
        offset,
        searchId,
      });

      // Then search within that block's transactions
      this.log.debug(
        'Phase 2: Searching for containing transaction within block',
        {
          offset,
          blockHeight: containingBlock.height,
          txCount: containingBlock.txs?.length || 0,
          searchId,
        },
      );

      const result = await this.binarySearchTransactions(
        containingBlock,
        offset,
      );
      if (!result) {
        this.log.debug(
          'Phase 2 completed: No transaction found containing offset within block',
          {
            offset,
            blockHeight: containingBlock.height,
            txCount: containingBlock.txs?.length || 0,
            searchId,
            result: 'not_found',
          },
        );
        return null;
      }

      this.log.debug('Binary search completed successfully', {
        txId: result.txId,
        txOffset: result.txOffset,
        blockHeight: containingBlock.height,
        offset,
        searchId,
        result: 'found',
      });

      return result;
    } catch (error: any) {
      this.log.error('Binary search failed with error', {
        offset,
        searchId,
        error: error.message,
        stack: error.stack,
        result: 'error',
      });
      throw error;
    }
  }

  /**
   * Binary search through blocks to find the one containing the given offset.
   * Returns the block containing the target offset, or null if not found.
   *
   * @param targetOffset - The absolute weave offset to search for
   * @returns Block data with tx_root, weave_size, height, txs, etc. or null
   */
  public async binarySearchBlocks(targetOffset: number): Promise<any | null> {
    const cacheKey = `block_for_offset_${targetOffset}`;
    const cached = this.blockCache.get(cacheKey);
    if (cached) {
      this.log.debug('Block search cache hit', {
        targetOffset,
        cachedBlockHeight: cached.height,
        cachedBlockOffset: cached.weave_size,
      });
      return cached;
    }

    try {
      const currentHeight = await this.getHeight();
      let left = 0;
      let right = currentHeight;

      // Use offset mapping to narrow search bounds if available
      const bounds = this.blockOffsetMapping?.getSearchBounds(
        targetOffset,
        currentHeight,
      );
      if (bounds) {
        left = bounds.lowHeight;
        // Use min to handle case where mapping is slightly outdated
        right = Math.min(bounds.highHeight, currentHeight);

        this.log.debug('Using offset mapping to narrow block search', {
          targetOffset,
          originalRange: `0-${currentHeight}`,
          narrowedRange: `${left}-${right}`,
          reductionPercent: (
            (1 - (right - left) / currentHeight) *
            100
          ).toFixed(1),
        });
      }

      let result: any | null = null;
      let iteration = 0;

      this.log.debug('Starting binary search for blocks', {
        targetOffset,
        heightRange: `${left}-${right}`,
        totalBlocks: right - left + 1,
        usingMapping: !!bounds,
      });

      while (left <= right) {
        iteration++;
        const mid = Math.floor((left + right) / 2);

        this.log.debug('Block search iteration', {
          iteration,
          left,
          right,
          mid,
          targetOffset,
          searchSpace: right - left + 1,
        });

        const block = await this.getBlockByHeight(mid);

        if (block === undefined || block === null) {
          this.log.debug('Block not found at height, adjusting search range', {
            height: mid,
            iteration,
            newRight: mid - 1,
            targetOffset,
          });
          right = mid - 1;
          continue;
        }

        const blockOffset = parseInt(block.weave_size);
        const decision =
          blockOffset >= targetOffset ? 'search_left' : 'search_right';

        this.log.debug('Block found, analyzing offset', {
          height: mid,
          blockOffset,
          targetOffset,
          decision,
          iteration,
          isCandidate: blockOffset >= targetOffset,
        });

        if (blockOffset >= targetOffset) {
          result = block;
          right = mid - 1;
          this.log.debug(
            'Block is candidate, searching left for better match',
            {
              candidateHeight: mid,
              candidateOffset: blockOffset,
              newRight: right,
              targetOffset,
              iteration,
            },
          );
        } else {
          left = mid + 1;
          this.log.debug('Block offset too small, searching right', {
            height: mid,
            blockOffset,
            newLeft: left,
            targetOffset,
            iteration,
          });
        }
      }

      this.log.debug('Block binary search completed', {
        targetOffset,
        iterations: iteration,
        foundBlock: result
          ? {
              height: result.height,
              offset: result.weave_size,
              txCount: result.txs?.length || 0,
            }
          : null,
        cacheKey,
      });

      if (result) {
        this.blockCache.set(cacheKey, result);
        this.log.debug('Caching block search result', {
          targetOffset,
          blockHeight: result.height,
          blockOffset: result.weave_size,
        });
      }

      return result;
    } catch (error: any) {
      this.log.error('Error in binary search for blocks', {
        targetOffset,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Linear scan through transactions in a block to find the one containing the given offset
   * Note: Transactions in blocks are NOT sorted by offset, so binary search doesn't work
   */
  private async binarySearchTransactions(
    block: any,
    targetOffset: number,
  ): Promise<{
    txId: string;
    txOffset: number;
    txSize: number;
    txStartOffset: number;
    txEndOffset: number;
  } | null> {
    const txIds = block.txs || [];
    if (txIds.length === 0) {
      this.log.debug('Block has no transactions', {
        blockHeight: block.height,
        targetOffset,
      });
      return null;
    }

    this.log.debug('Starting binary search for transactions', {
      blockHeight: block.height,
      blockOffset: block.weave_size,
      txCount: txIds.length,
      targetOffset,
      txIds: txIds.slice(0, 5), // Log first 5 tx IDs for debugging
    });

    // Sort transaction IDs by their binary representation (same as Arweave does)
    // Arweave assigns offsets to transactions after sorting them by ID as binary data
    const sortedTxIds = [...txIds].sort((a, b) => {
      try {
        // Decode base64url to binary for proper comparison
        const decodeB64Url = (str: string): Buffer => {
          // Add padding if needed and convert to base64
          const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
          const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
          return Buffer.from(padded, 'base64');
        };

        const bufA = decodeB64Url(a);
        const bufB = decodeB64Url(b);
        return Buffer.compare(bufA, bufB);
      } catch (error) {
        // Fallback to string comparison if decoding fails
        return a.localeCompare(b);
      }
    });

    this.log.debug('Sorted transactions for binary search', {
      originalOrder: txIds.slice(0, 3),
      sortedOrder: sortedTxIds.slice(0, 3),
      isSortingNeeded: JSON.stringify(txIds) !== JSON.stringify(sortedTxIds),
    });

    let left = 0;
    let right = sortedTxIds.length - 1;
    let result: {
      txId: string;
      txOffset: number;
      txSize: number;
      txStartOffset: number;
      txEndOffset: number;
    } | null = null;
    let iteration = 0;
    const offsetRequests: {
      txId: string;
      offset: number;
      size: number;
      fromCache: boolean;
    }[] = [];

    while (left <= right) {
      iteration++;
      const mid = Math.floor((left + right) / 2);
      const txId = sortedTxIds[mid];

      this.log.debug('Transaction search iteration', {
        iteration,
        left,
        right,
        mid,
        txId,
        targetOffset,
        blockHeight: block.height,
        searchSpace: right - left + 1,
      });

      // Check cache first
      const cacheKey = `tx_offset_${txId}`;
      const cachedData = this.txOffsetCache.get(cacheKey);
      let txOffset: number;
      let txSize: number;
      let fromCache = true;

      if (cachedData === undefined) {
        fromCache = false;
        try {
          this.log.debug('Fetching transaction offset from chain', {
            txId,
            iteration,
            blockHeight: block.height,
            targetOffset,
          });

          const offsetResponse = await this.getTxOffset(txId);
          txOffset = offsetResponse.offset;
          txSize = offsetResponse.size;
          this.txOffsetCache.set(cacheKey, { offset: txOffset, size: txSize });

          this.log.debug('Successfully fetched transaction offset', {
            txId,
            txOffset,
            iteration,
            targetOffset,
          });
        } catch (error: any) {
          this.log.error(
            'Failed to get transaction offset during binary search',
            {
              txId,
              blockHeight: block.height,
              iteration,
              targetOffset,
              error: error.message,
            },
          );
          // If we can't get the offset for this transaction, we can't reliably
          // perform binary search, so we should fail the search
          throw new Error(
            `Failed to get transaction offset for ${txId}: ${error.message}`,
          );
        }
      } else {
        // Cache hit - extract data from cached object
        if (typeof cachedData === 'number') {
          // Handle legacy cache entries that only stored offset
          txOffset = cachedData;
          txSize = 0; // We don't have size for legacy entries, will need to refetch
          fromCache = false; // Force refetch to get complete data

          const offsetResponse = await this.getTxOffset(txId);
          txOffset = offsetResponse.offset;
          txSize = offsetResponse.size;
          this.txOffsetCache.set(cacheKey, { offset: txOffset, size: txSize });
        } else {
          // New cache format with both offset and size
          txOffset = cachedData.offset;
          txSize = cachedData.size;
        }
      }

      offsetRequests.push({ txId, offset: txOffset, size: txSize, fromCache });

      // Check if target offset falls within this transaction's data range
      // Calculate transaction boundaries: txStart = txOffset - txSize + 1
      const txStartOffset = txOffset - txSize + 1;
      const txEndOffset = txOffset;

      // Check if target is within transaction boundaries
      const isWithinTransaction =
        targetOffset >= txStartOffset && targetOffset <= txEndOffset;

      let decision: 'search_left' | 'search_right' | 'found';
      if (isWithinTransaction) {
        decision = 'found';
      } else if (targetOffset < txStartOffset) {
        // Target is before this transaction - search left (earlier transactions)
        decision = 'search_left';
      } else {
        // Target is after this transaction - search right (later transactions)
        decision = 'search_right';
      }

      const isCandidate = isWithinTransaction;

      this.log.debug('Transaction offset comparison', {
        txId,
        txOffset,
        txSize,
        txStartOffset,
        txEndOffset,
        targetOffset,
        isWithinTransaction,
        decision,
        isCandidate,
        fromCache,
        iteration,
        blockHeight: block.height,
      });

      if (decision === 'found') {
        // Found the transaction containing the target offset
        result = { txId, txOffset, txSize, txStartOffset, txEndOffset };
        this.log.debug('Found transaction containing target offset', {
          txId,
          txOffset,
          txSize,
          txStartOffset,
          txEndOffset,
          targetOffset,
          offsetWithinTx: targetOffset - txStartOffset,
          iteration,
        });
        break; // Exit the binary search loop
      } else if (decision === 'search_left') {
        right = mid - 1;
        this.log.debug('Target before transaction, searching left', {
          txId,
          txStartOffset,
          txEndOffset,
          targetOffset,
          newRight: right,
          iteration,
        });
      } else {
        // decision === 'search_right'
        left = mid + 1;
        this.log.debug('Target after transaction, searching right', {
          txId,
          txStartOffset,
          txEndOffset,
          targetOffset,
          newLeft: left,
          iteration,
        });
      }
    }

    this.log.debug('Transaction binary search completed', {
      blockHeight: block.height,
      targetOffset,
      iterations: iteration,
      totalOffsetRequests: offsetRequests.length,
      cacheHits: offsetRequests.filter((r) => r.fromCache).length,
      cacheMisses: offsetRequests.filter((r) => !r.fromCache).length,
      foundTransaction: result
        ? {
            txId: result.txId,
            txOffset: result.txOffset,
            txSize: result.txSize,
            txStartOffset: result.txStartOffset,
            txEndOffset: result.txEndOffset,
          }
        : null,
      offsetRequests: offsetRequests.slice(0, 10), // Log first 10 requests for debugging
    });

    return result;
  }

  /**
   * Cleanup method to stop timers and clear caches
   * Should be called when the client is no longer needed (e.g., in tests)
   */
  cleanup(): void {
    // Clear the bucket filler interval
    if (this.bucketFillerInterval) {
      clearInterval(this.bucketFillerInterval);
      this.bucketFillerInterval = undefined;
    }

    // Clear NodeCache instances and stop their internal timers
    this.blockByHeightPromiseCache.close();
    this.txPromiseCache.close();

    // Clear LRU caches
    this.blockCache.clear();
    this.txOffsetCache.clear();
    this.txDataCache.clear();

    // Clear promise cache
    this.chunkPromiseCache.clear();
  }
}
