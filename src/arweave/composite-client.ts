import { default as NodeCache } from 'node-cache';
import { AxiosRequestConfig, AxiosResponse, default as axios } from 'axios';
import * as rax from 'retry-axios';
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import { default as wait } from 'wait';
import { default as Arweave } from 'arweave';
import * as winston from 'winston';

import { ChainSource, JsonBlock, JsonTransaction } from '../types.js';

type Peer = {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
};

export class ArweaveCompositeClient implements ChainSource {
  private log: winston.Logger;

  // Trusted node
  private trustedNodeUrl: string;
  private trustedNodeAxios;

  // Peers
  private peers: Record<string, Peer> = {};
  private preferredPeers: Set<Peer> = new Set();

  // TODO rename caches
  // Block and TX caches
  private blockByHeightPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 30,
    useClones: false // cloning promises is unsafe
  });
  private txPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 60,
    useClones: false // cloning promises is unsafe
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

  // TODO construct this in app.ts and pass it in
  // Arweave API (for TX validatio)
  private arweave = Arweave.init({});

  constructor({
    log,
    trustedNodeUrl,
    requestTimeout = 15000,
    requestRetryCount = 5,
    maxRequestsPerSecond = 20,
    maxConcurrentRequests = 100,
    blockPrefetchCount = 50,
    blockTxPrefetchCount = 1
  }: {
    log: winston.Logger;
    trustedNodeUrl: string;
    requestTimeout?: number;
    requestRetryCount?: number;
    requestPerSecond?: number;
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
    blockPrefetchCount?: number;
    blockTxPrefetchCount?: number;
  }) {
    this.log = log;
    this.trustedNodeUrl = trustedNodeUrl.replace(/\/$/, '');

    // Initialize trusted node Axios with automatic retries
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: requestTimeout
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
      }
    };
    rax.attach(this.trustedNodeAxios);

    // Initialize trusted node request queue
    this.trustedNodeRequestQueue = fastq.promise(
      this.trustedNodeRequest.bind(this),
      maxConcurrentRequests
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
        url: '/peers'
      });
      const peerHosts = response.data as string[];
      await Promise.all(
        peerHosts.map(async (peerHost) => {
          try {
            const peerUrl = `http://${peerHost}`;
            const response = await axios({
              method: 'GET',
              url: '/info',
              baseURL: peerUrl
            });
            this.peers[peerHost] = {
              url: peerUrl,
              blocks: response.data.blocks,
              height: response.data.height,
              lastSeen: new Date().getTime()
            };
            if (response.data.blocks / response.data.height > 0.9) {
              this.preferredPeers.add(this.peers[peerHost]);
            }
          } catch (error) {
            // TODO track metric
          }
          return;
        })
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
    let responsePromise = this.blockByHeightPromiseCache.get(height);
    if (responsePromise) {
      // Update TTL if block promise is already cached
      this.blockByHeightPromiseCache.set(height, responsePromise);
    } else {
      responsePromise = this.trustedNodeRequestQueue
        .push({
          method: 'GET',
          url: `/block/height/${height}`
        })
        .then((response) => {
          // Delete POA to reduce cache size
          if (response?.data?.poa) {
            delete response.data.poa;
          }
          return response;
        })
        .catch((error) => {
          this.log.error(`Block prefetch failed:`, {
            height: height,
            message: error.message
          });
        });
      this.blockByHeightPromiseCache.set(height, responsePromise);
    }

    try {
      const response = (await responsePromise) as AxiosResponse<JsonBlock>;

      if (prefetchTxs) {
        response.data.txs.forEach((txId: string) => {
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
    shouldPrefetch = false
  ): Promise<JsonBlock> {
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
            i <= this.blockTxPrefetchCount
          );
        } else {
          break;
        }
      }
    }

    try {
      const response = (await this.blockByHeightPromiseCache.get(
        height
      )) as AxiosResponse;

      // Check that a response was returned
      if (!response) {
        throw new Error('Prefetched block request failed');
      }

      const block = response.data as JsonBlock;

      // Sanity check block format
      if (!block?.indep_hash) {
        throw new Error(`Invalid block`);
      }

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
      timeout: 500
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

    const responsePromise = this.peerGetTx(txId)
      .catch(async () => {
        // Request TX from trusted node if peer fetch failed
        return this.trustedNodeRequestQueue.push({
          method: 'GET',
          url: `/tx/${txId}`
        });
      })
      .then((response) => {
        // Delete TX data to reduce cache size
        if (response?.data?.data) {
          delete response.data.data;
        }
        return response;
      })
      .catch((error) => {
        this.log.error('Transaction prefetch failed:', {
          txId: txId,
          message: error.message
        });
      });
    this.txPromiseCache.set(txId, responsePromise);
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    // Prefetch TX
    this.prefetchTx(txId);

    try {
      // Wait for TX response
      const response = (await this.txPromiseCache.get(txId)) as AxiosResponse;

      // Check that a response was returned
      if (!response) {
        throw new Error('Prefetched transaction request failed');
      }

      const tx = response.data as JsonTransaction;

      // Sanity check TX format
      if (!tx?.id) {
        throw new Error('Invalid transaction');
      }

      return tx;
    } catch (error: any) {
      // Remove failed requests from the cache
      this.txPromiseCache.del(txId);

      this.log.error('Failed to get transaction:', {
        txId: txId,
        message: error.message
      });

      throw error;
    }
  }

  // TODO make second arg an options object
  async getBlockAndTxsByHeight(
    height: number,
    shouldPrefetch = true
  ): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }> {
    const block = await this.getBlockByHeight(height, shouldPrefetch);

    // Retrieve block transactions
    const missingTxIds: string[] = [];
    const txs: JsonTransaction[] = [];
    await Promise.all(
      block.txs.map(async (txId) => {
        try {
          const tx = await this.getTx(txId);
          txs.push(tx);
        } catch (error) {
          missingTxIds.push(txId);
        }
      })
    );

    return { block, txs: txs, missingTxIds: missingTxIds };
  }

  async getHeight(): Promise<number> {
    const response = await this.trustedNodeRequest({
      method: 'GET',
      url: '/height'
    });

    // Save max observed height for use as block prefetch boundary
    this.maxPrefetchHeight =
      this.maxPrefetchHeight < response.data
        ? response.data
        : this.maxPrefetchHeight;

    return response.data;
  }
}
