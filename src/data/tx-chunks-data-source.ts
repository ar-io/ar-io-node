/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { Readable } from 'node:stream';
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
