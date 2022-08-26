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
import fs from 'fs';
import { default as NodeCache } from 'node-cache';
import path from 'path';
import * as rax from 'retry-axios';
import { default as wait } from 'wait';
import * as winston from 'winston';

import {
  jsonBlockToMsgpack,
  jsonTxToMsgpack,
  msgpackToJsonBlock,
  msgpackToJsonTx,
} from '../lib/encoding.js';
import { sanityCheckBlock, sanityCheckTx } from '../lib/validation.js';
import {
  ChainSource,
  PartialJsonBlock,
  PartialJsonBlockCache,
  PartialJsonTransaction,
  PartialJsonTxCache,
} from '../types.js';
import { MAX_FORK_DEPTH } from './constants.js';

function txCacheDir(txId: string) {
  const txPrefix = `${txId.substring(0, 2)}/${txId.substring(2, 4)}`;
  return `data/headers/partial-txs/${txPrefix}`;
}

function txCachePath(txId: string) {
  return `${txCacheDir(txId)}/${txId}.msgpack`;
}

class FsTxCache implements PartialJsonTxCache {
  async has(txId: string) {
    try {
      await fs.promises.access(txCachePath(txId), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(txId: string) {
    try {
      const txData = await fs.promises.readFile(txCachePath(txId));
      return msgpackToJsonTx(txData);
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(tx: PartialJsonTransaction) {
    try {
      await fs.promises.mkdir(txCacheDir(tx.id), { recursive: true });
      const txData = jsonTxToMsgpack(tx);
      await fs.promises.writeFile(txCachePath(tx.id), txData);
    } catch (error) {
      // TODO log error
    }
  }
}

function blockCacheHashDir(hash: string) {
  const blockPrefix = `${hash.substring(0, 2)}/${hash.substring(2, 4)}`;
  return `data/headers/partial-blocks/hash/${blockPrefix}`;
}

function blockCacheHashPath(hash: string) {
  return `${blockCacheHashDir(hash)}/${hash}.msgpack`;
}

function blockCacheHeightDir(height: number) {
  return `data/headers/partial-blocks/height/${height % 1000}`;
}

function blockCacheHeightPath(height: number) {
  return `${blockCacheHeightDir(height)}/${height}.msgpack`;
}

class FsBlockCache implements PartialJsonBlockCache {
  async hasHash(hash: string) {
    try {
      await fs.promises.access(blockCacheHashPath(hash), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async hasHeight(height: number) {
    try {
      await fs.promises.access(blockCacheHeightPath(height), fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getByHash(hash: string) {
    try {
      if (await this.hasHash(hash)) {
        const blockData = await fs.promises.readFile(blockCacheHashPath(hash));
        return msgpackToJsonBlock(blockData);
      }

      return undefined;
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async getByHeight(height: number) {
    try {
      if (await this.hasHeight(height)) {
        const blockData = await fs.promises.readFile(
          blockCacheHeightPath(height),
        );
        return msgpackToJsonBlock(blockData);
      }

      return undefined;
    } catch (error) {
      // TODO log error
      return undefined;
    }
  }

  async set(block: PartialJsonBlock, height?: number) {
    try {
      if (!(await this.hasHash(block.indep_hash))) {
        await fs.promises.mkdir(blockCacheHashDir(block.indep_hash), {
          recursive: true,
        });

        const blockData = jsonBlockToMsgpack(block);
        await fs.promises.writeFile(
          blockCacheHashPath(block.indep_hash),
          blockData,
        );
      }

      if (height && !(await this.hasHeight(height))) {
        await fs.promises.mkdir(blockCacheHeightDir(height), {
          recursive: true,
        });

        const targetPath = path.relative(
          `${process.cwd()}/${blockCacheHeightDir(height)}`,
          `${process.cwd()}/${blockCacheHashPath(block.indep_hash)}`,
        );
        await fs.promises.symlink(targetPath, blockCacheHeightPath(height));
      }
    } catch (error) {
      // TODO log error
    }
  }
}

type Peer = {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
};

export class ArweaveCompositeClient implements ChainSource {
  private arweave: Arweave;
  private log: winston.Logger;
  private txCache: PartialJsonTxCache;
  private blockCache: PartialJsonBlockCache;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredPeers: Set<Peer> = new Set();

  // Block and TX promise caches
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
    requestTimeout = 15000,
    requestRetryCount = 5,
    maxRequestsPerSecond = 20,
    maxConcurrentRequests = 100,
    blockPrefetchCount = 50,
    blockTxPrefetchCount = 1,
  }: {
    log: winston.Logger;
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
    // TODO add context to logger
    this.log = log;
    this.arweave = arweave;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');
    this.txCache = new FsTxCache();
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
  }

  // TODO recursively traverse peers
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
            // TODO track metric
          }
          return;
        }),
      );
    } catch (error) {
      // TODO track metric
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
          this.log.error(`Block prefetch failed:`, {
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
    } catch (error) {
      // TODO log error
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
        throw new Error(`Invalid transaction`);
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
}
