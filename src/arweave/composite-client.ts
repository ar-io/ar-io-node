/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
import CircuitBreaker from 'opossum';

import { FailureSimulator } from '../lib/chaos.js';
import { fromB64Url } from '../lib/encoding.js';
import { shuffleArray } from '../lib/random.js';
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
} from '../types.js';
import { MAX_FORK_DEPTH } from './constants.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_RETRY_COUNT = 5;
const DEFAULT_MAX_REQUESTS_PER_SECOND = 15;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_BLOCK_PREFETCH_COUNT = 50;
const DEFAULT_BLOCK_TX_PREFETCH_COUNT = 1;
const CHUNK_CACHE_TTL_SECONDS = 5;
const DEFAULT_CHUNK_POST_ABORT_TIMEOUT_MS = 2000;
const DEFAULT_CHUNK_POST_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_PEER_INFO_TIMEOUT_MS = 5000;

interface Peer {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
}

export class ArweaveCompositeClient
  implements
    ChainSource,
    ChunkBroadcaster,
    ChunkByAnySource,
    ChunkDataByAnySource,
    ContiguousDataSource
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
  private chunkPostUrls: string[];
  private chunkPostConcurrency: number;
  private secondaryChunkPostUrls: string[];
  private secondaryChunkPostConcurrency: number;
  private secondaryChunkPostMinSuccessCount: number;
  private trustedNodeAxios;
  private primaryChunkPostCircuitBreakers: Record<
    string,
    CircuitBreaker<
      Parameters<ArweaveCompositeClient['postChunk']>,
      Awaited<ReturnType<ArweaveCompositeClient['postChunk']>>
    >
  > = {};

  private secondaryChunkPostCircuitBreakers: Record<
    string,
    CircuitBreaker<
      Parameters<ArweaveCompositeClient['postChunk']>,
      Awaited<ReturnType<ArweaveCompositeClient['postChunk']>>
    >
  > = {};

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredPeers: Set<Peer> = new Set();
  private weightedChunkPeers: WeightedElement<string>[] = [];

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
    chunkPostUrls,
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
  }: {
    log: winston.Logger;
    arweave: Arweave;
    trustedNodeUrl: string;
    chunkPostUrls: string[];
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
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.chunkPostUrls = chunkPostUrls.map((url) => url.replace(/\/$/, ''));
    this.chunkPostConcurrency = config.CHUNK_POST_CONCURRENCY_LIMIT;
    this.secondaryChunkPostUrls = config.SECONDARY_CHUNK_POST_URLS.map((url) =>
      url.replace(/\/$/, ''),
    );
    this.secondaryChunkPostConcurrency =
      config.SECONDARY_CHUNK_POST_CONCURRENCY_LIMIT;
    this.secondaryChunkPostMinSuccessCount =
      config.SECONDARY_CHUNK_POST_MIN_SUCCESS_COUNT;

    const commonCircuitBreakerOptions = {
      errorThresholdPercentage: 50,
    };

    // Initialize circuit breakers for primary chunk post nodes
    this.chunkPostUrls.forEach((url) => {
      const circuitBreaker = new CircuitBreaker(
        ({
          url,
          chunk,
          abortTimeout,
          responseTimeout,
          originAndHopsHeaders,
        }) => {
          return this.postChunk({
            url,
            chunk,
            abortTimeout,
            responseTimeout,
            originAndHopsHeaders,
          });
        },
        {
          name: `primaryBroadcastChunk-${url}`,
          capacity: 100,
          resetTimeout: 5000,
          ...commonCircuitBreakerOptions,
        },
      );

      this.primaryChunkPostCircuitBreakers[url] = circuitBreaker;
      metrics.circuitBreakerMetrics.add(circuitBreaker);
    });

    // Initialize circuit breakers for secondary chunk post nodes
    this.secondaryChunkPostUrls.forEach((url) => {
      const circuitBreaker = new CircuitBreaker(
        ({
          url,
          chunk,
          abortTimeout,
          responseTimeout,
          originAndHopsHeaders,
        }) => {
          return this.postChunk({
            url,
            chunk,
            abortTimeout,
            responseTimeout,
            originAndHopsHeaders,
          });
        },
        {
          name: `secondaryBroadcastChunk-${url}`,
          capacity: 10,
          resetTimeout: 10000,
          ...commonCircuitBreakerOptions,
        },
      );

      this.secondaryChunkPostCircuitBreakers[url] = circuitBreaker;
      metrics.circuitBreakerMetrics.add(circuitBreaker);
    });

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

    // Initialize prefetch settings
    this.blockPrefetchCount = blockPrefetchCount;
    this.blockTxPrefetchCount = blockTxPrefetchCount;
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
      await Promise.all(
        peerHosts.map(async (peerHost) => {
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
              if (response.data.blocks / response.data.height > 0.9) {
                this.preferredPeers.add(this.peers[peerHost]);
              }
            } catch (error) {
              metrics.arweavePeerInfoErrorCounter.inc();
            }
          } else {
            this.log.debug('Ignoring peer:', { peerHost });
          }
        }),
      );
      this.weightedChunkPeers = Object.values(this.peers).map((peerObject) => {
        const previousWeight =
          this.weightedChunkPeers.find((peer) => peer.id === peerObject.url)
            ?.weight ?? undefined;
        return {
          id: peerObject.url,
          weight: previousWeight === undefined ? 50 : previousWeight,
        };
      });
    } catch (error) {
      metrics.arweavePeerRefreshErrorCounter.inc();
    }
  }

  selectChunkPeers(peerCount: number): string[] {
    const log = this.log.child({ method: 'selectChunkPeers' });

    if (this.weightedChunkPeers.length === 0) {
      log.warn('No weighted chunk peers available');
      throw new Error('No weighted chunk peers available');
    }

    return randomWeightedChoices<string>({
      table: this.weightedChunkPeers,
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
              block.txs.forEach(async (txId: string) => {
                this.prefetchTx({ txId });
              });
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

  async peerGetTx(url: string) {
    const peersToTry = Array.from(this.preferredPeers);
    const randomPeer =
      peersToTry[Math.floor(Math.random() * peersToTry.length)];

    return axios({
      method: 'GET',
      url,
      baseURL: randomPeer.url,
      timeout: 500,
    }).then(async (response) => {
      const tx = this.arweave.transactions.fromRaw(response.data);
      const isValid = await this.arweave.transactions.verify(tx);
      if (!isValid) {
        throw new Error('Invalid peer fetched transaction');
      }
      return response;
    });
  }

  prefetchTx({
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

    const responsePromise = this.txStore
      .get(txId)
      .then((tx) => {
        this.failureSimulator.maybeFail();

        // Return cached TX if it exists
        if (!this.skipCache && tx) {
          return tx;
        }

        return this.peerGetTx(url)
          .catch(async () => {
            downloadedFromPeer = false;

            // Request TX from trusted node if peer fetch failed
            return this.trustedNodeRequestQueue.push({
              method: 'GET',
              url,
            });
          })
          .then((response) => {
            // Delete TX data to reduce response cache size
            if (response?.data?.data) {
              delete response.data.data;
            }

            return response.data;
          });
      })
      .then(async (tx) => {
        try {
          metrics.arweaveTxFetchCounter.inc({
            node_type: downloadedFromPeer ? 'arweave_peer' : 'trusted',
          });
          // Sanity check to guard against accidental bad data from both
          // cache and trusted node
          sanityCheckTx(tx);

          await this.txStore.set(tx);

          return tx;
        } catch (error) {
          this.txStore.del(txId);
        }
      })
      .catch((error) => {
        this.log.warn('Transaction prefetch failed:', {
          txId: txId,
          message: error.message,
          stack: error.stack,
        });
      });

    this.txPromiseCache.set(txId, responsePromise);

    return responsePromise as Promise<PartialJsonTransaction | undefined>;
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
      this.weightedChunkPeers.forEach((weightedChunkPeer) => {
        if (weightedChunkPeer.id === peer) {
          weightedChunkPeer.weight = Math.min(
            weightedChunkPeer.weight + config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
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
      this.weightedChunkPeers.forEach((weightedChunkPeer) => {
        if (weightedChunkPeer.id === peer) {
          weightedChunkPeer.weight = Math.max(
            weightedChunkPeer.weight - config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
            1,
          );
        }
      });
    }
  }

  async peerGetChunk({
    absoluteOffset,
    retryCount,
    txSize,
    dataRoot,
    relativeOffset,
  }: {
    txSize: number;
    absoluteOffset: number;
    dataRoot: string;
    relativeOffset: number;
    retryCount: number;
  }): Promise<Chunk> {
    const randomChunkPeers = this.selectChunkPeers(retryCount);
    for (const randomChunkPeer of randomChunkPeers) {
      try {
        const response = await axios({
          method: 'GET',
          url: `/chunk/${absoluteOffset}`,
          baseURL: randomChunkPeer,
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

        this.handlePeerSuccess(randomChunkPeer, 'peerGetChunk', 'peer');

        this.chunkCache.set(
          { absoluteOffset },
          {
            cachedAt: Date.now(),
            chunk,
          },
        );

        return chunk;
      } catch {
        this.handlePeerFailure(randomChunkPeer, 'peerGetChunk', 'peer');
      }
    }

    throw new Error('Failed to fetch chunk from any peer');
  }

  async getChunkByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<Chunk> {
    this.failureSimulator.maybeFail();

    try {
      const response = await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/chunk/${absoluteOffset}`,
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

      await validateChunk(txSize, chunk, fromB64Url(dataRoot), relativeOffset);

      this.handlePeerSuccess(this.trustedNodeUrl, 'getChunkByAny', 'trusted');

      this.chunkCache.set(
        { absoluteOffset },
        {
          cachedAt: Date.now(),
          chunk,
        },
      );

      metrics.getChunkTotal.inc({
        status: 'success',
        method: 'getChunkByAny',
        class: this.constructor.name,
      });

      return chunk;
    } catch (error: any) {
      this.handlePeerFailure(this.trustedNodeUrl, 'getChunkByAny', 'trusted');
      metrics.getChunkTotal.inc({
        status: 'error',
        method: 'getChunkByAny',
        class: this.constructor.name,
      });
      this.log.warn('Failed to fetch chunk trusted node, attempting peers: ', {
        messsage: error.message,
        stack: error.stack,
      });
    }

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

    try {
      const result = await this.peerGetChunk({
        absoluteOffset,
        retryCount: 3,
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
      this.log.warn('Unable to fetch chunk from peers', {
        messsage: error.message,
        stack: error.stack,
      });
    }

    throw new Error('Unable to fetch chunk from trusted node or peers');
  }

  async getChunkDataByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkData> {
    const { hash, chunk } = await this.getChunkByAny(
      txSize,
      absoluteOffset,
      dataRoot,
      relativeOffset,
    );
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

  async postChunk({
    url,
    chunk,
    abortTimeout = DEFAULT_CHUNK_POST_ABORT_TIMEOUT_MS,
    responseTimeout = DEFAULT_CHUNK_POST_RESPONSE_TIMEOUT_MS,
    originAndHopsHeaders,
  }: {
    url: string;
    chunk: JsonChunkPost;
    abortTimeout?: number;
    responseTimeout?: number;
    originAndHopsHeaders: Record<string, string | undefined>;
  }) {
    try {
      this.failureSimulator.maybeFail();

      const resp = await axios({
        url,
        method: 'POST',
        data: chunk,
        signal: AbortSignal.timeout(abortTimeout),
        timeout: responseTimeout,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: originAndHopsHeaders,
      });

      return {
        success: true,
        statusCode: resp.status,
        canceled: false,
        timedOut: false,
      };
    } catch (error: any) {
      let canceled = false;
      let timedOut = false;

      if (axios.isAxiosError(error)) {
        timedOut = error.code === 'ECONNABORTED';
        canceled = error.code === 'ERR_CANCELED';
      }

      this.log.error('Failed to broadcast chunk:', {
        message: error.message,
        stack: error.stack,
        url,
      });

      return {
        success: false,
        statusCode: error.response?.status,
        canceled,
        timedOut,
      };
    }
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
    const primaryChunkNodePostLimit = pLimit(this.chunkPostConcurrency);

    const primaryChunkNodeUrls = shuffleArray([...this.chunkPostUrls]);
    const primaryResults: Promise<BroadcastChunkResponses | undefined>[] = [];

    let successCount = 0;
    let failureCount = 0;

    for (const url of primaryChunkNodeUrls) {
      const task = primaryChunkNodePostLimit(async () => {
        if (successCount < chunkPostMinSuccessCount) {
          const response = await this.primaryChunkPostCircuitBreakers[url].fire(
            {
              url,
              chunk,
              abortTimeout,
              responseTimeout,
              originAndHopsHeaders,
            },
          );

          if (response.success) {
            successCount++;
            metrics.arweaveChunkPostCounter.inc({
              endpoint: url,
              status: 'success',
              role: 'primary',
            });
          } else {
            failureCount++;
            metrics.arweaveChunkPostCounter.inc({
              endpoint: url,
              status: 'fail',
              role: 'primary',
            });
          }

          return response;
        }
        return undefined;
      });

      primaryResults.push(task);
    }

    let secondarySuccessCount = 0;

    const secondaryResults: Promise<BroadcastChunkResponses>[] = [];

    if (this.secondaryChunkPostUrls.length > 0) {
      const shuffledSecondaryChunkPostUrls = shuffleArray([
        ...this.secondaryChunkPostUrls,
      ]);

      const secondaryChunkNodePostLimit = pLimit(
        this.secondaryChunkPostConcurrency,
      );
      for (const url of shuffledSecondaryChunkPostUrls) {
        if (secondarySuccessCount >= this.secondaryChunkPostMinSuccessCount)
          break;

        const circuitBreaker = this.secondaryChunkPostCircuitBreakers[url];
        const task = secondaryChunkNodePostLimit(async () => {
          const response = await circuitBreaker.fire({
            url,
            chunk,
            abortTimeout,
            responseTimeout,
            originAndHopsHeaders,
          });

          if (response.success) {
            secondarySuccessCount++;
            metrics.arweaveChunkPostCounter.inc({
              endpoint: url,
              status: 'success',
              role: 'secondary',
            });
          } else {
            metrics.arweaveChunkPostCounter.inc({
              endpoint: url,
              status: 'fail',
              role: 'secondary',
            });
          }

          return response;
        });

        secondaryResults.push(task);
      }
      Promise.all(secondaryResults);
    }

    const results = (await Promise.all(primaryResults)).filter(
      (result) => result !== undefined,
    );

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
