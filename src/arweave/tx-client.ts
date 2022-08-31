import { Readable } from 'stream';
import winston from 'winston';

import { ChainSource, ChunkSource, TxDataSource } from '../types.js';

export class TxClient implements TxDataSource {
  private log: winston.Logger;
  private chunkSource: ChunkSource;
  private chainSource: ChainSource;

  constructor({
    log,
    chainSource,
    chunkSource,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chunkSource: ChunkSource;
  }) {
    this.log = log.child({ client: 'tx-client' });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getTxData(txId: string): Promise<{ data: Readable; size: number }> {
    this.log.info('Fetching chunk data for tx', { txId });

    try {
      const { offset, size } = await this.chainSource.getTxOffset(txId);
      const startOffset = +offset - +size + 1;
      let chunkPromise =
        this.chunkSource.getChunkDataByAbsoluteOffset(startOffset);
      let bytes = 0;
      const data = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
            if (!chunkPromise) {
              return;
            }

            const chunkData = await chunkPromise;
            // TODO: is this the best way to read the process returned stream
            const chunk = chunkData.read();
            bytes += chunk.length;

            // we're not done gatehering all chunks yet
            if (bytes < size) {
              // TODO: fix scoping issue
              chunkPromise = this.chunkSource
                .getChunkDataByAbsoluteOffset(startOffset + bytes)
                .catch(() => ({}));
            }

            this.push(chunk);
          } catch (error) {
            this.destroy();
          }
        },
      });
      return {
        data,
        size,
      };
    } catch (error: any) {
      this.log.error('Failed to retrieve transaction data', {
        txId,
        message: error.message,
      });
      throw error;
    }
  }
}
