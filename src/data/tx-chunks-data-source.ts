import { Readable } from 'stream';
import winston from 'winston';

import {
  ChainSource,
  ChunkData,
  ChunkDataByAnySource,
  ContiguousDataResponse,
  ContiguousDataSource,
} from '../types.js';

export class TxChunksDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chunkSource: ChunkDataByAnySource;

  constructor({
    log,
    chainSource,
    chunkSource,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chunkSource: ChunkDataByAnySource;
  }) {
    this.log = log.child({ class: 'TxDataChunksRetriever' });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getContiguousData(id: string): Promise<ContiguousDataResponse> {
    this.log.info('Fetching chunk data for tx', { txId: id });

    try {
      const [txDataRoot, txOffset] = await Promise.all([
        this.chainSource.getTxField(id, 'data_root'),
        this.chainSource.getTxOffset(id),
      ]);
      const size = +txOffset.size;
      const offset = +txOffset.offset;
      const startOffset = offset - size + 1;
      let bytes = 0;
      // we lose scope in the readable, so set to internal function
      const getChunkDataByAny = (
        absoluteOffset: number,
        dataRoot: string,
        relativeOffset: number,
      ) =>
        this.chunkSource.getChunkDataByAny(
          size,
          absoluteOffset,
          dataRoot,
          relativeOffset,
        );
      let chunkDataPromise: Promise<ChunkData> | undefined = getChunkDataByAny(
        startOffset,
        txDataRoot,
        bytes,
      );
      const stream = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
            if (!chunkDataPromise) {
              this.push(null);
              return;
            }

            const chunkData = await chunkDataPromise;
            this.push(chunkData.chunk);
            bytes += chunkData.chunk.length;

            if (bytes < size) {
              chunkDataPromise = getChunkDataByAny(
                startOffset + bytes,
                txDataRoot,
                bytes,
              );
            } else {
              chunkDataPromise = undefined;
            }
          } catch (error: any) {
            this.destroy(error);
          }
        },
      });
      return {
        stream,
        size,
        verified: true,
      };
    } catch (error: any) {
      this.log.error('Failed to retrieve transaction data:', {
        txId: id,
        messag: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
