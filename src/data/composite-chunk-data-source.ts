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
    const limit = pLimit(this.parallelism);
    let successResult: ChunkData | undefined;

    // Create all promises at once, controlled by pLimit
    const promises = this.sources.map((source) =>
      limit(async () => {
        // Check if we already have a success before starting
        if (successResult) {
          return null;
        }

        try {
          const result = await source.getChunkDataByAny(params);

          // Check again after async operation
          if (successResult !== undefined) {
            return null;
          }

          this.log.debug('Successfully fetched chunk data from source', {
            source: source.constructor.name,
            dataRoot: params.dataRoot,
            relativeOffset: params.relativeOffset,
          });

          // Store success result
          successResult = result;
          return result;
        } catch (error: any) {
          // Check again if we got a success while this was running
          if (successResult) {
            return null;
          }

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

    // Wait for all promises to complete
    await Promise.all(promises);

    // Return success if we got one
    if (successResult) {
      return successResult;
    }

    // All sources failed
    const errorMessage = `Failed to fetch chunk data from any source. Errors: ${errors
      .map((e) => e.message)
      .join('; ')}`;
    throw new Error(errorMessage);
  }
}
