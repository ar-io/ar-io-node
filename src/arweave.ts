import { default as NodeCache } from 'node-cache';
import { AxiosRequestConfig, AxiosResponse, default as axios } from 'axios';
import * as rax from 'retry-axios';

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
  private blockByHeightPromiseCache = new NodeCache({
    checkperiod: 10,
    stdTTL: 30,
    useClones: false
  });
  private maxHeight = -1;
  private blockPrefetchCount = 50;

  constructor(chainApiUrl: string) {
    this.trustedNodeUrl = chainApiUrl.replace(/\/$/, '');
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: 15000
    });
    this.trustedNodeAxios.defaults.raxConfig = {
      retry: 5,
      instance: this.trustedNodeAxios
    };
    rax.attach(this.trustedNodeAxios);
  }

  trustedNodeRequest(request: AxiosRequestConfig) {
    return this.trustedNodeAxios(request);
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
            const response = await this.trustedNodeRequest({
              method: 'GET',
              url: '/info'
            });
            this.peers[peerHost] = {
              url: peerUrl,
              blocks: response.data.blocks,
              height: response.data.height,
              lastSeen: new Date().getTime()
            };
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

  prefetchBlockByHeight(height: number) {
    const cachedResponsePromise = this.blockByHeightPromiseCache.get(height);
    if (cachedResponsePromise) {
      // Update TTL if block promise is already cached
      try {
        this.blockByHeightPromiseCache.set(height, cachedResponsePromise);
      } catch (error) {
        // TODO log error
      }
      return;
    }

    const responsePromise = this.trustedNodeRequest({
      method: 'GET',
      url: `/block/height/${height}`
    }).catch((error) => {
      return error;
    });
    this.blockByHeightPromiseCache.set(height, responsePromise);

    // TODO prefetch txs
  }

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
        if (prefetchHeight <= this.maxHeight) {
          this.prefetchBlockByHeight(prefetchHeight);
        } else {
          break;
        }
      }
    }

    const responseOrError = await this.blockByHeightPromiseCache.get(height);

    // TODO cleanup error handling
    if (!(responseOrError as AxiosResponse).status) {
      throw new Error(`Failed to retrieve block at height ${height}`);
    }

    return (responseOrError as AxiosResponse).data as JsonBlock;
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    const response = await this.trustedNodeRequest({
      method: 'GET',
      url: `/tx/${txId}`
    });
    return response.data as JsonTransaction;
  }

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
