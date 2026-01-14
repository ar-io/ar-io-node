/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import winston from 'winston';
import { Chunk, ChunkWithValidationParams } from '../types.js';
import { parseDataPath } from './merkle-path-parser.js';

export interface StreamRangeDataParams {
  txId: string;
  txSize: number;
  txAbsoluteStart: number;
  dataRoot: string;
  rangeStart: number;
  rangeEnd: number;
  getChunkByAny: (params: ChunkWithValidationParams) => Promise<Chunk>;
  log: winston.Logger;
  signal?: AbortSignal;
}

export interface StreamRangeDataResult {
  stream: AsyncGenerator<Buffer>;
  chunksFetched: number;
}

/**
 * Stream data for a specific byte range by fetching only the required chunks.
 * Uses Arweave's offset resolution to directly seek to chunks containing the range.
 * Returns a wrapper object containing the stream generator and chunk count tracker.
 */
export function streamRangeData(params: StreamRangeDataParams): {
  stream: AsyncGenerator<Buffer>;
  getChunksFetched: () => number;
} {
  let chunksFetched = 0;

  async function* generateStream(): AsyncGenerator<Buffer> {
    const {
      txId,
      txSize,
      txAbsoluteStart,
      dataRoot,
      rangeStart,
      rangeEnd,
      getChunkByAny,
      log,
      signal,
    } = params;
    // Validate range
    if (rangeStart >= rangeEnd || rangeStart < 0 || rangeEnd > txSize) {
      log.warn('Invalid range requested', {
        txId,
        rangeStart,
        rangeEnd,
        txSize,
      });
      return;
    }

    // Calculate absolute offset for the first byte of the range
    let currentAbsoluteOffset = txAbsoluteStart + rangeStart;
    let totalBytesYielded = 0;
    const targetBytes = rangeEnd - rangeStart;

    log.debug('Starting range stream', {
      txId,
      rangeStart,
      rangeEnd,
      targetBytes,
      firstChunkAbsoluteOffset: currentAbsoluteOffset,
    });

    while (totalBytesYielded < targetBytes) {
      // Check for abort before fetching each chunk
      signal?.throwIfAborted();

      try {
        // Fetch chunk containing current offset
        const chunk = await getChunkByAny({
          txSize,
          absoluteOffset: currentAbsoluteOffset,
          dataRoot,
          relativeOffset: currentAbsoluteOffset - txAbsoluteStart,
        });

        // Increment chunk counter
        chunksFetched++;

        // Parse data_path to get chunk boundaries
        const parsed = await parseDataPath({
          dataRoot: Buffer.from(dataRoot, 'base64url'),
          dataSize: txSize,
          dataPath: chunk.data_path,
          offset: currentAbsoluteOffset - txAbsoluteStart,
        });

        if (!parsed.validated) {
          throw new Error('Failed to validate chunk data_path');
        }

        const { startOffset, endOffset, chunkSize } = parsed.boundaries;

        // Calculate what portion of this chunk we need
        const chunkStartInRange = Math.max(0, rangeStart - startOffset);
        const chunkEndInRange = Math.min(chunkSize, rangeEnd - startOffset);
        const bytesToYield = chunkEndInRange - chunkStartInRange;

        log.debug('Processing chunk for range', {
          txId,
          chunkBoundaries: { startOffset, endOffset, chunkSize },
          chunkStartInRange,
          chunkEndInRange,
          bytesToYield,
          chunkNumber: chunksFetched,
        });

        // Yield the needed portion of the chunk
        if (bytesToYield > 0) {
          yield chunk.chunk.slice(chunkStartInRange, chunkEndInRange);
          totalBytesYielded += bytesToYield;
        }

        // Move to next chunk if we need more data
        if (totalBytesYielded < targetBytes && endOffset < txSize) {
          // Next chunk starts at current chunk's end
          currentAbsoluteOffset = txAbsoluteStart + endOffset;
        } else {
          // We've got all the data we need
          break;
        }
      } catch (error) {
        log.error('Error streaming chunk for range', {
          txId,
          currentAbsoluteOffset,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    log.debug('Range stream complete', {
      txId,
      totalBytesYielded,
      targetBytes,
      chunksFetched,
    });
  }

  return {
    stream: generateStream(),
    getChunksFetched: () => chunksFetched,
  };
}
