/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import * as promClient from 'prom-client';
import * as rax from 'retry-axios';
import { Readable } from 'stream';
import { default as wait } from 'wait';
import * as winston from 'winston';

import { FsBlockCache } from '../cache/fs-block-cache.js';
import { FsTransactionCache } from '../cache/fs-transaction-cache.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import {
  sanityCheckBlock,
  sanityCheckChunk,
  sanityCheckTx,
  validateChunk,
} from '../lib/validation.js';
import {
  ChainSource,
  ChunkSource,
  JsonChunk,
  JsonTransactionOffset,
  PartialJsonBlock,
  PartialJsonBlockCache,
  PartialJsonTransaction,
  PartialJsonTransactionCache,
  TxDataSource,
} from '../types.js';
import { MAX_FORK_DEPTH } from './constants.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_RETRY_COUNT = 5;
const DEFAULT_MAX_REQUESTS_PER_SECOND = 15;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_BLOCK_PREFETCH_COUNT = 50;
const DEFAULT_BLOCK_TX_PREFETCH_COUNT = 1;
const createNodeCache = (options: NodeCache.Options = {}) =>
  new NodeCache({
    checkperiod: 10,
    stdTTL: 30,
    useClones: false, // cloning promises is unsafe
    ...options,
  });

type Peer = {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
};

export class ArweaveCompositeClient
  implements ChainSource, ChunkSource, TxDataSource
{
  private arweave: Arweave;
  private log: winston.Logger;
  private txCache: PartialJsonTransactionCache;
  private blockCache: PartialJsonBlockCache;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredPeers: Set<Peer> = new Set();

  // Block and TX promise caches used for prefetching
  private blockByHeightPromiseCache: NodeCache = createNodeCache({
    stdTTL: 30,
  });
  private txPromiseCache: NodeCache = createNodeCache({ stdTTL: 60 });

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

  // Metrics
  private arweavePeerInfoErrorCounter: promClient.Counter<string>;
  private arweavePeerRefreshErrorCounter: promClient.Counter<string>;

  constructor({
    log,
    metricsRegistry,
    arweave,
    trustedNodeUrl,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
    requestRetryCount = DEFAULT_REQUEST_RETRY_COUNT,
    maxRequestsPerSecond = DEFAULT_MAX_REQUESTS_PER_SECOND,
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    blockPrefetchCount = DEFAULT_BLOCK_PREFETCH_COUNT,
    blockTxPrefetchCount = DEFAULT_BLOCK_TX_PREFETCH_COUNT,
  }: {
    log: winston.Logger;
    metricsRegistry: promClient.Registry;
    arweave: Arweave;
    trustedNodeUrl: string;
    requestTimeout?: number;
    requestRetryCount?: number;
    requestPerSecond?: number;
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
    blockPrefetchCount?: number;
    blockTxPrefetchCount?: number;
  }) {
    this.log = log.child({ class: 'ArweaveCompositeClient' });
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.txCache = new FsTransactionCache();
    this.blockCache = new FsBlockCache();

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

    // Metrics
    this.arweavePeerInfoErrorCounter = new promClient.Counter({
      name: 'arweave_peer_info_errors_total',
      help: 'Count of failed Arweave peer info requests',
    });
    metricsRegistry.registerMetric(this.arweavePeerInfoErrorCounter);

    this.arweavePeerRefreshErrorCounter = new promClient.Counter({
      name: 'arweave_peer_referesh_errors_total',
      help: 'Count of errors refreshing the Arweave peers list',
    });
    metricsRegistry.registerMetric(this.arweavePeerRefreshErrorCounter);
  }

  async refreshPeers(): Promise<void> {
    try {
      const response = await this.trustedNodeRequest({
        method: 'GET',
        url: '/peers',
      });
      const peerHosts = response.data as string[];
      await Promise.all(
        peerHosts.map(async (peerHost) => {
          try {
            const peerUrl = `http://${peerHost}`;
            const response = await axios({
              method: 'GET',
              url: '/info',
              baseURL: peerUrl,
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
            this.arweavePeerInfoErrorCounter.inc();
          }
          return;
        }),
      );
    } catch (error) {
      this.arweavePeerRefreshErrorCounter.inc();
    }
  }

  async trustedNodeRequest(request: AxiosRequestConfig) {
    while (this.trustedNodeRequestBucket <= 0) {
      await wait(100);
    }
    this.trustedNodeRequestBucket--;
    return this.trustedNodeAxios(request);
  }

  async prefetchBlockByHeight(height: number, prefetchTxs = false) {
    let blockPromise = this.blockByHeightPromiseCache.get(height);

    if (!blockPromise) {
      blockPromise = this.blockCache
        .getByHeight(height)
        .then((block) => {
          // Return cached block if it exists
          if (block) {
            return block;
          }

          return this.trustedNodeRequestQueue
            .push({
              method: 'GET',
              url: `/block/height/${height}`,
            })
            .then((response) => {
              // Delete POA to reduce cache size
              if (response?.data?.poa) {
                delete response.data.poa;
              }
              return response.data;
            });
        })
        .then((block) => {
          sanityCheckBlock(block);
          this.blockCache.set(
            block,
            this.maxPrefetchHeight - block.height > MAX_FORK_DEPTH
              ? block.height
              : undefined,
          );
          return block;
        })
        .catch((error) => {
          this.log.error('Block prefetch failed:', {
            height: height,
            message: error.message,
          });
        });

      this.blockByHeightPromiseCache.set(height, blockPromise);
    }

    try {
      const block = (await blockPromise) as PartialJsonBlock;

      if (prefetchTxs) {
        block.txs.forEach(async (txId: string) => {
          this.prefetchTx(txId);
        });
      }
    } catch (error: any) {
      this.log.error('Error prefetching block transactions:', {
        height: height,
        message: error.message,
      });
    }
  }

  // TODO make second arg an options object
  async getBlockByHeight(
    height: number,
    shouldPrefetch = false,
  ): Promise<PartialJsonBlock> {
    // Prefetch the requested block
    this.prefetchBlockByHeight(height);

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
      const block = (await this.blockByHeightPromiseCache.get(
        height,
      )) as PartialJsonBlock;

      // Check that a response was returned
      if (!block) {
        throw new Error('Prefetched block request failed');
      }

      // Sanity check block format
      sanityCheckBlock(block);

      // Remove prefetched request from cache so forks are handled correctly
      this.blockByHeightPromiseCache.del(height);

      return block;
    } catch (error) {
      // Remove failed requests from the cache
      this.blockByHeightPromiseCache.del(height);
      throw error;
    }
  }

  async peerGetTx(txId: string) {
    const peersToTry = Array.from(this.preferredPeers);
    const randomPeer =
      peersToTry[Math.floor(Math.random() * peersToTry.length)];

    return axios({
      method: 'GET',
      url: `/tx/${txId}`,
      baseURL: randomPeer.url,
      timeout: 500,
    }).then(async (response) => {
      const tx = this.arweave.transactions.fromRaw(response.data);
      const isValid = await this.arweave.transactions.verify(tx);
      if (!isValid) {
        throw new Error('Invalid transaction');
      }
      return response;
    });
  }

  prefetchTx(txId: string) {
    const cachedResponsePromise = this.txPromiseCache.get(txId);
    if (cachedResponsePromise) {
      // Update TTL if block promise is already cached
      this.txPromiseCache.set(txId, cachedResponsePromise);
      return;
    }

    const responsePromise = this.txCache
      .get(txId)
      .then((tx) => {
        // Return cached tx if it exists
        if (tx) {
          return tx;
        }

        return this.peerGetTx(txId)
          .catch(async () => {
            // Request TX from trusted node if peer fetch failed
            return this.trustedNodeRequestQueue.push({
              method: 'GET',
              url: `/tx/${txId}`,
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
      .then((tx) => {
        sanityCheckTx(tx);
        this.txCache.set(tx);
        return tx;
      })
      .catch((error) => {
        this.log.error('Transaction prefetch failed:', {
          txId: txId,
          message: error.message,
        });
      });
    this.txPromiseCache.set(txId, responsePromise);
  }

  async getTx(txId: string): Promise<PartialJsonTransaction> {
    // Prefetch TX
    this.prefetchTx(txId);

    try {
      // Wait for TX response
      const tx = (await this.txPromiseCache.get(
        txId,
      )) as PartialJsonTransaction;

      // Check that a response was returned
      if (!tx) {
        throw new Error('Prefetched transaction request failed');
      }

      return tx;
    } catch (error: any) {
      // Remove failed requests from the cache
      this.txPromiseCache.del(txId);

      this.log.error('Failed to get transaction:', {
        txId: txId,
        message: error.message,
      });

      throw error;
    }
  }

  async getTxOffset(txId: string): Promise<JsonTransactionOffset> {
    try {
      const response = await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/tx/${txId}/offset`,
      });
      return response.data;
    } catch (error: any) {
      this.log.error('Failed to get transaction offset:', {
        txId,
        message: error.message,
      });
      throw error;
    }
  }

  async getTxField<T>(
    txId: string,
    field: keyof PartialJsonTransaction,
  ): Promise<T> {
    try {
      const response = await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/tx/${txId}/${field}`,
      });
      return response.data;
    } catch (error: any) {
      this.log.error(`Failed to get transaction ${field}:`, {
        txId,
        message: error.message,
      });
      throw error;
    }
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
          const tx = await this.getTx(txId);
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

  async getChunkByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<JsonChunk> {
    try {
      const response = await this.trustedNodeRequestQueue.push({
        method: 'GET',
        url: `/chunk/${absoluteOffset}`,
      });
      const chunk = response.data;

      sanityCheckChunk(chunk);

      await validateChunk(chunk, dataRoot, relativeOffset);

      return chunk;
    } catch (error: any) {
      this.log.error('Failed to get chunk:', {
        absoluteOffset,
        dataRoot: toB64Url(dataRoot),
        relativeOffset,
        message: error.message,
      });
      throw error;
    }
  }

  async getChunkDataByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<Readable> {
    const { chunk } = await this.getChunkByRelativeOrAbsoluteOffset(
      absoluteOffset,
      dataRoot,
      relativeOffset,
    );
    const data = fromB64Url(chunk);
    return Readable.from(data);
  }

  async getTxData(txId: string): Promise<{ data: Readable; size: number }> {
    try {
      const [dataResponse, dataSizeResponse] = await Promise.all([
        this.trustedNodeRequestQueue.push({
          method: 'GET',
          url: `/tx/${txId}/data`,
        }),
        this.trustedNodeRequestQueue.push({
          method: 'GET',
          url: `/tx/${txId}/data_size`,
        }),
      ]);

      if (!dataResponse.data) {
        throw Error('No transaction data');
      }

      const size = +dataSizeResponse.data;
      const txData = fromB64Url(dataResponse.data);
      return { data: Readable.from(txData), size };
    } catch (error: any) {
      this.log.error('Failed to get transaction data:', {
        txId,
        message: error.message,
      });
      throw error;
    }
  }
}
