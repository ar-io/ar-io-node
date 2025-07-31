/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import pLimit from 'p-limit';

import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';

export class CompositeChunkDataSource implements ChunkDataByAnySource {
  private log: winston.Logger;
  private sources: ChunkDataByAnySource[];
  private parallelism: number;

  constructor({
    log,
    sources,
    parallelism = 1,
  }: {
    log: winston.Logger;
    sources: ChunkDataByAnySource[];
    parallelism?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.parallelism = Math.max(1, Math.min(parallelism, sources.length));
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    if (this.sources.length === 0) {
      throw new Error('No chunk data sources configured');
    }

    const errors: Error[] = [];

    if (this.parallelism === 1) {
      // Sequential execution
      for (const source of this.sources) {
        try {
          const result = await source.getChunkDataByAny(params);
          this.log.debug('Successfully fetched chunk data from source', {
            source: source.constructor.name,
            dataRoot: params.dataRoot,
            relativeOffset: params.relativeOffset,
          });
          return result;
        } catch (error: any) {
          this.log.debug('Failed to fetch chunk data from source', {
            source: source.constructor.name,
            error: error.message,
            dataRoot: params.dataRoot,
            relativeOffset: params.relativeOffset,
          });
          errors.push(error);
        }
      }
    } else {
      // Parallel execution with early termination
      let sourceIndex = 0;
      const limit = pLimit(this.parallelism);

      while (sourceIndex < this.sources.length) {
        // Create a batch of promises up to the parallelism limit
        const batchPromises: Promise<ChunkData | null>[] = [];
        const batchSources: ChunkDataByAnySource[] = [];

        for (
          let i = 0;
          i < this.parallelism && sourceIndex < this.sources.length;
          i++
        ) {
          const source = this.sources[sourceIndex];
          batchSources.push(source);
          sourceIndex++;

          batchPromises.push(
            limit(async () => {
              try {
                const result = await source.getChunkDataByAny(params);
                this.log.debug('Successfully fetched chunk data from source', {
                  source: source.constructor.name,
                  dataRoot: params.dataRoot,
                  relativeOffset: params.relativeOffset,
                });
                return result;
              } catch (error: any) {
                this.log.debug('Failed to fetch chunk data from source', {
                  source: source.constructor.name,
                  error: error.message,
                  dataRoot: params.dataRoot,
                  relativeOffset: params.relativeOffset,
                });
                errors.push(error);
                return null;
              }
            }),
          );
        }

        // Use Promise.race to get the first successful result
        const results = await Promise.all(batchPromises);
        for (const result of results) {
          if (result !== null) {
            // Cancel any remaining tasks
            limit.clearQueue();
            return result;
          }
        }
      }
    }

    // All sources failed
    const errorMessage = `Failed to fetch chunk data from any source. Errors: ${errors
      .map((e) => e.message)
      .join('; ')}`;
    throw new Error(errorMessage);
  }
}
