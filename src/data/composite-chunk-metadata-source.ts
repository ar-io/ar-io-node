/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import pLimit from 'p-limit';

import {
  ChunkMetadata,
  ChunkMetadataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';

export class CompositeChunkMetadataSource implements ChunkMetadataByAnySource {
  private log: winston.Logger;
  private sources: ChunkMetadataByAnySource[];
  private parallelism: number;

  constructor({
    log,
    sources,
    parallelism = 1,
  }: {
    log: winston.Logger;
    sources: ChunkMetadataByAnySource[];
    parallelism?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.parallelism = Math.max(1, Math.min(parallelism, sources.length));
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkMetadata> {
    // Check for abort before starting
    signal?.throwIfAborted();

    if (this.sources.length === 0) {
      throw new Error('No chunk metadata sources configured');
    }

    const errors: Error[] = [];
    const limit = pLimit(this.parallelism);
    let successResult: ChunkMetadata | undefined;

    // Create all promises at once, controlled by pLimit
    const promises = this.sources.map((source) =>
      limit(async () => {
        // Check if we already have a success or abort before starting
        if (successResult || signal?.aborted) {
          return null;
        }

        try {
          const result = await source.getChunkMetadataByAny(params, signal);

          // Check again after async operation
          if (successResult !== undefined) {
            return null;
          }

          this.log.debug('Successfully fetched chunk metadata from source', {
            source: source.constructor.name,
            dataRoot: params.dataRoot,
            relativeOffset: params.relativeOffset,
          });

          // Store success result
          successResult = result;
          return result;
        } catch (error: any) {
          // Re-throw AbortError to propagate cancellation
          if (error.name === 'AbortError') {
            throw error;
          }

          // Check again if we got a success while this was running
          if (successResult) {
            return null;
          }

          this.log.debug('Failed to fetch chunk metadata from source', {
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

    // Check if aborted after all promises complete
    signal?.throwIfAborted();

    // Return success if we got one
    if (successResult) {
      return successResult;
    }

    // All sources failed
    const errorMessage = `Failed to fetch chunk metadata from any source. Errors: ${errors
      .map((e) => e.message)
      .join('; ')}`;
    throw new Error(errorMessage);
  }
}
