/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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

      // Rebind getChunkDataByAny to preserve access to it in the stream read
      // function since 'this' is assigned to the stream as opposed to the
      // TxChunksDataSource instance there.
      const getChunkDataByAny = (
        absoluteOffset: number,
        dataRoot: string,
        relativeOffset: number,
      ) =>
        this.chunkSource.getChunkDataByAny({
          txSize: size,
          absoluteOffset,
          dataRoot,
          relativeOffset,
        });
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

      // await the first chunk promise so that it throws and returns 404 if no
      // chunk data is found.
      await chunkDataPromise;

      if (region) {
        // TODO: seek to chunks by offset instead of streaming all the chunks
        const byteRangeStream = new ByteRangeTransform(
          region.offset,
          region.size,
        );
        return {
          stream: stream.pipe(byteRangeStream),
          size: region.size,
          verified: true,
          trusted: true,
          cached: false,
          requestAttributes:
            generateRequestAttributes(requestAttributes)?.attributes,
        };
      }

      return {
        stream,
        size,
        verified: true,
        trusted: true,
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
