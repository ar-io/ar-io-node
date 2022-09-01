import { Readable } from 'stream';
import winston from 'winston';

import { ChainSource, ChunkSource, TxDataSource } from '../types.js';

export class TxDataChunksRetriever implements TxDataSource {
  private log: winston.Logger;
  // TODO: could make this a speicifc type
  private chainSource: ChainSource;
  private chunkSource: ChunkSource;

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
      const offsetResponse = await this.chainSource.getTxOffset(txId);
      const size = +offsetResponse.size;
      const offset = +offsetResponse.offset;
      const startOffset = offset - size + 1;
      // we lose scope in the readable, so set to internal function
      const getChunkDataByAbsoluteOffset = (offset: number) =>
        this.chunkSource.getChunkDataByAbsoluteOffset(offset);
      let chunkPromise: Promise<Readable> | undefined =
        getChunkDataByAbsoluteOffset(startOffset);
      let bytes = 0;
      const data = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
            if (!chunkPromise) {
              this.push(null);
              return;
            }
            const chunkData = await chunkPromise;
            chunkData.on('data', (chunk) => {
              this.push(chunk);
              bytes += chunk.length;
            });

            chunkData.on('end', () => {
              // check if we're done
              if (bytes < size) {
                chunkPromise = getChunkDataByAbsoluteOffset(
                  startOffset + bytes,
                );
              } else {
                chunkPromise = undefined;
              }
            });

            chunkData.on('error', (error) => {
              this.emit('error', error);
            });
          } catch (error: any) {
            this.destroy(error);
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
