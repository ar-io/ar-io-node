import { default as NodeCache } from 'node-cache';
import { AxiosRequestConfig, AxiosResponse, default as axios } from 'axios';
import * as rax from 'retry-axios';
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import { default as wait } from 'wait';
import { default as Arweave } from 'arweave';

import { IChainSource, JsonBlock, JsonTransaction } from './types.js';

type Peer = {
  url: string;
  blocks: number;
  height: number;
  lastSeen: number;
};

export class ChainApiClient implements IChainSource {
  private trustedNodeUrl: string;
  private trustedNodeAxios;
  private peers: Record<string, Peer> = {};
  private preferredPeers: Set<Peer> = new Set();
  private blockByHeightPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 30,
    useClones: false
  });
  private txPromiseCache = new NodeCache({
    checkperiod: 30,
    stdTTL: 120,
    useClones: false
  });
  private maxHeight = -1;
  private blockPrefetchCount;
  private trustedNodeRequestQueue: queueAsPromised<
    AxiosRequestConfig,
    AxiosResponse
  >;
  private trustedNodeRequestBucket = 0;
  private requestsPerSecond = 10;
  private arweave = Arweave.init({});

  constructor({
    chainApiUrl,
    requestTimeout = 15000,
    requestRetryCount = 5,
    maxRequestsPerSecond = 100,
    maxConcurrentRequests = 100
  }: {
    chainApiUrl: string;
    requestTimeout?: number;
    requestRetryCount?: number;
    requestPerSecond?: number;
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
  }) {
    this.trustedNodeUrl = chainApiUrl.replace(/\/$/, '');

    // Initialize Axios
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: requestTimeout
    });
    this.trustedNodeAxios.defaults.raxConfig = {
      retry: requestRetryCount,
      instance: this.trustedNodeAxios,
      onRetryAttempt: (err) => {
        const cfg = rax.getConfig(err);
        const attempt = cfg?.currentRetryAttempt ?? 1;
        if (err?.response?.status === 429) {
          this.trustedNodeRequestBucket -= 2 ** attempt;
          this.requestsPerSecond -= Math.max(1, 2 ** attempt);
        }
      }
    };
    rax.attach(this.trustedNodeAxios);

    // Start rate limiter
    setInterval(() => {
      if (this.trustedNodeRequestBucket <= this.requestsPerSecond * 300) {
        this.trustedNodeRequestBucket += this.requestsPerSecond;
      }
    }, 1000);

    // Start request rate increment process
    setInterval(() => {
      if (this.requestsPerSecond < maxRequestsPerSecond) {
        this.requestsPerSecond += 0.2;
      }
    }, 1000);

    // Initialize trusted node request queue
    this.trustedNodeRequestQueue = fastq.promise(
      this.trustedNodeRequest.bind(this),
      maxConcurrentRequests
    );

    this.blockPrefetchCount = maxConcurrentRequests;
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

  async prefetchBlockByHeight(height: number) {
    const cachedResponsePromise = this.blockByHeightPromiseCache.get(height);
    if (cachedResponsePromise) {
      // Update TTL if block promise is already cached
      this.blockByHeightPromiseCache.set(height, cachedResponsePromise);
      return;
    }

    const responsePromise = this.trustedNodeRequestQueue
      .push({
        method: 'GET',
        url: `/block/height/${height}`
      })
      .then((response) => {
        // Delete POA to reduce cache size
        if (response.data.poa) {
          delete response.data.poa;
        }
        return response;
      });
    this.blockByHeightPromiseCache.set(height, responsePromise);

    try {
      const response = await responsePromise;

      response.data.txs.forEach((txId: string) => {
        this.prefetchTx(txId);
      });
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
    if (shouldPrefetch && height < this.maxHeight) {
      for (let i = 1; i <= this.blockPrefetchCount; i++) {
        const prefetchHeight = height + i;
        if (
          prefetchHeight <= this.maxHeight &&
          this.trustedNodeRequestQueue.length() === 0
        ) {
          this.prefetchBlockByHeight(prefetchHeight);
        } else {
          break;
        }
      }
    }

    const response = (await this.blockByHeightPromiseCache.get(
      height
    )) as AxiosResponse;
    const block = response.data as JsonBlock;

    if (!block || typeof block !== 'object' || !block.indep_hash) {
      throw new Error(`Failed to retrieve block at ${height}`);
    }

    return block;
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
      const isValid = this.arweave.transactions.verify(tx);
      if (!isValid) {
        throw new Error(`Invalid peer TX ${txId}`);
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
        if (response && response.data.data) {
          delete response.data.data;
        }
        return response;
      });

    this.txPromiseCache.set(txId, responsePromise);
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    // Prefetch TX
    this.prefetchTx(txId);

    // Wait for TX response
    const response = (await this.txPromiseCache.get(txId)) as AxiosResponse;
    const tx = response.data as JsonTransaction;

    if (!tx || typeof tx !== 'object' || !tx.id) {
      throw new Error(`Failed to retrieve transaction ${txId}`);
    }

    return tx;
  }

  // TODO make second arg an options object
  async getBlockAndTxs(
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
          // TODO log error
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
    this.maxHeight =
      this.maxHeight < response.data ? response.data : this.maxHeight;
    return response.data as number;
  }
}
