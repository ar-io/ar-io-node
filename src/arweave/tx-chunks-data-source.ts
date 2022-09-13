import { Readable } from 'stream';
import winston from 'winston';

import { fromB64Url } from '../lib/encoding.js';
import { ChainSource, ChunkSource, TxDataSource } from '../types.js';

export class TxChunksDataSource implements TxDataSource {
  private log: winston.Logger;
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
    this.log = log.child({ class: 'TxDataChunksRetriever' });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getTxData(txId: string): Promise<{ data: Readable; size: number }> {
    this.log.info('Fetching chunk data for tx', { txId });

    try {
      const [txData, txOffset] = await Promise.all([
        this.chainSource.getTx(txId),
        this.chainSource.getTxOffset(txId),
      ]);
      const size = +txOffset.size;
      const offset = +txOffset.offset;
      const startOffset = offset - size + 1;
      const dataRoot = fromB64Url(txData.data_root);
      let bytes = 0;
      // we lose scope in the readable, so set to internal function
      const getChunkDataByAbsoluteOffset = (
        absoluteOffset: number,
        dataRoot: Buffer,
        relativeOffset: number,
      ) =>
        this.chunkSource.getChunkDataByAbsoluteOffset(
          absoluteOffset,
          dataRoot,
          relativeOffset,
        );
      let chunkPromise: Promise<Readable> | undefined =
        getChunkDataByAbsoluteOffset(startOffset, dataRoot, bytes);
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
                  dataRoot,
                  bytes,
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
      this.log.error('Failed to retrieve transaction data:', {
        txId,
        message: error.message,
      });
      throw error;
    }
  }
}
