import { Readable } from 'stream';
import winston from 'winston';

import { ChainSource, ChunkSource, TxDataSource } from '../types.js';

export class TxClient implements TxDataSource {
  private log: winston.Logger;
  // TODO: could make this a speicifc type
  private client: ChainSource & ChunkSource;

  constructor({
    log,
    client,
  }: {
    log: winston.Logger;
    client: ChainSource & ChunkSource;
  }) {
    this.log = log.child({ client: 'tx-client' });
    this.client = client;
  }

  async getTxData(txId: string): Promise<{ data: Readable; size: number }> {
    this.log.info('Fetching chunk data for tx', { txId });

    try {
      const { offset, size } = await this.client.getTxOffset(txId);
      const startOffset = +offset - +size + 1;
      // we lose scope in the readable, so set to internal function
      const getChunkDataByAbsoluteOffset =
        this.client.getChunkDataByAbsoluteOffset;
      let chunkPromise: Promise<Readable> | undefined =
        this.client.getChunkDataByAbsoluteOffset(startOffset);
      let bytes = 0;
      const data = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
            if (!chunkPromise) {
              return;
            }

            const chunkData = await chunkPromise;
            chunkData.on('data', (chunk) => {
              this.push(chunk);
              bytes += chunk.length;
            });

            // we're not done gatehering all chunks yet
            if (bytes < size) {
              // TODO: fix scoping issue
              chunkPromise = getChunkDataByAbsoluteOffset(
                startOffset + bytes,
              ).catch();
            } else {
              chunkPromise = undefined;
            }
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
