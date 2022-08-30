import axios, { AxiosInstance } from 'axios';
import { Readable } from 'stream';
import winston from 'winston';

import { ChunkSource, TxDataSource } from '../types.js';

export class TxClient implements TxDataSource {
  private log: winston.Logger;
  private chunkSource: ChunkSource;
  private trustedNodeUrl: string;
  private trustedNodeAxios: AxiosInstance;

  constructor({
    log,
    chunkSource,
    requestTimeout = 500,
    trustedNodeUrl,
  }: {
    log: winston.Logger;
    chunkSource: ChunkSource;
    requestTimeout: number;
    trustedNodeUrl: string;
  }) {
    this.log = log.child({ client: 'tx-client' });
    this.chunkSource = chunkSource;
    this.trustedNodeUrl = trustedNodeUrl;
    this.trustedNodeAxios = axios.create({
      baseURL: this.trustedNodeUrl,
      timeout: requestTimeout,
    });
  }

  async getTxData(txId: string): Promise<Readable> {
    this.log.info('Fetching chunk data for tx', { txId });

    try {
      const response = await this.trustedNodeAxios({
        method: 'GET',
        url: `/tx/${txId}/offset`,
      });

      const { offset, size } = response.data;
      const startOffset = +offset - +size + 1;
      const data = Buffer.alloc(size);
      let bytes = 0;
      while (bytes < +size) {
        const currentOffset = startOffset + bytes;
        const chunkData = await this.chunkSource.getChunkDataByAbsoluteOffset(
          currentOffset,
        );

        chunkData.on('data', (chunk) => {
          data.set(chunk, bytes);
          bytes += chunk.length;
        });

        chunkData.on('error', (error) => {
          this.log.error('Unable to read chunk data at offset', {
            txId,
            offset: currentOffset,
            message: error.message,
          });
          throw error;
        });
      }

      if (data.byteLength !== +size) {
        throw Error('Transaction data is incorrect size');
      }
      return Readable.from(data);
    } catch (error: any) {
      this.log.error('Failed to retrieve transaction data', {
        txId,
        message: error.message,
      });
      throw error;
    }
  }
}
