import { Readable } from 'stream';
import winston from 'winston';

import {
  ChainSource,
  ChunkData,
  ChunkDataByAnySource,
  ContiguousData,
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
    this.log = log.child({ class: 'TxChunksDataSource' });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getData(txId: string): Promise<ContiguousData> {
    this.log.info('Fetching chunk data for TX', { txId });

    const [txDataRoot, txOffset] = await Promise.all([
      this.chainSource.getTxField(txId, 'data_root'),
      this.chainSource.getTxOffset(txId),
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
  }
}
