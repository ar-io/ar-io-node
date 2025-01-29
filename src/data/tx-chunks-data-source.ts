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
import { generateRequestAttributes } from '../lib/request-attributes.js';

import {
  ChainSource,
  ChunkData,
  ChunkDataByAnySource,
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import * as metrics from '../metrics.js';
import { ByteRangeTransform } from '../lib/stream.js';

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
    this.log = log.child({ class: this.constructor.name });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getData({
    id,
    requestAttributes,
    region,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    this.log.debug('Fetching chunk data for TX', { id });

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

      stream.on('error', () => {
        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 'chunks',
        });
      });

      stream.on('end', () => {
        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 'chunks',
        });
      });

      if (region) {
        const byteRangeStream = new ByteRangeTransform(
          region.offset,
          region.size,
        );
        return {
          stream: stream.pipe(byteRangeStream),
          size: region.size,
          verified: true,
          cached: false,
          requestAttributes:
            generateRequestAttributes(requestAttributes)?.attributes,
        };
      }

      return {
        stream,
        size,
        verified: true,
        cached: false,
        requestAttributes:
          generateRequestAttributes(requestAttributes)?.attributes,
      };
    } catch (error) {
      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 'chunks',
      });
      throw error;
    }
  }
}
