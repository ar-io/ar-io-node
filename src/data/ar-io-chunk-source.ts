/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { ReadThroughPromiseCache } from '@ardrive/ardrive-promise-cache';
import { headerNames } from '../constants.js';
import * as config from '../config.js';
import { ArIODataSource } from './ar-io-data-source.js';
import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  ChunkMetadata,
  ChunkMetadataByAnySource,
  Chunk,
} from '../types.js';

// Local constants (no configuration needed)
const CHUNK_CACHE_CAPACITY = 100;
const CHUNK_CACHE_TTL_SECONDS = 60;
const MAX_CHUNK_HOPS_ALLOWED = 1;

export class ArIOChunkSource
  implements ChunkDataByAnySource, ChunkMetadataByAnySource
{
  private log: winston.Logger;
  private arIODataSource: ArIODataSource;
  private chunkPromiseCache: ReadThroughPromiseCache<string, Chunk>;

  constructor({
    log,
    arIODataSource,
  }: {
    log: winston.Logger;
    arIODataSource: ArIODataSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arIODataSource = arIODataSource;

    // Initialize promise cache with read-through function
    this.chunkPromiseCache = new ReadThroughPromiseCache<string, Chunk>({
      cacheParams: {
        cacheCapacity: CHUNK_CACHE_CAPACITY,
        cacheTTL: CHUNK_CACHE_TTL_SECONDS * 1000,
      },
      readThroughFunction: async (cacheKey: string) => {
        // Parse the cache key back to basic parameters
        // Note: We lose request attributes in this approach, but that's acceptable
        // since hop tracking is more important at the entry point
        const [dataRoot, absoluteOffsetStr, txSizeStr, relativeOffsetStr] =
          cacheKey.split(':');
        const params: ChunkDataByAnySourceParams = {
          dataRoot,
          absoluteOffset: parseInt(absoluteOffsetStr),
          txSize: parseInt(txSizeStr),
          relativeOffset: parseInt(relativeOffsetStr),
        };
        return this.fetchChunkFromArIOPeer(params);
      },
    });
  }

  private getCacheKey(params: ChunkDataByAnySourceParams): string {
    // Include all parameters needed for cache reconstruction
    return `${params.dataRoot}:${params.absoluteOffset}:${params.txSize}:${params.relativeOffset}`;
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    const cacheKey = this.getCacheKey(params);

    // The read-through cache will handle calling fetchChunkFromArIOPeer via the readThroughFunction
    // Note: Request attributes from the first call are lost in cached responses, but hop tracking
    // is most important at the entry point to prevent infinite loops
    return this.chunkPromiseCache.get(cacheKey);
  }

  private async fetchChunkFromArIOPeer(
    params: ChunkDataByAnySourceParams,
    retryCount = 5,
    peerSelectionCount = 3,
  ): Promise<Chunk> {
    const log = this.log.child({ method: 'fetchChunkFromArIOPeer' });

    log.debug('Fetching chunk from AR.IO peer', {
      dataRoot: params.dataRoot,
      absoluteOffset: params.absoluteOffset,
    });

    // Determine hop count and origin from request attributes
    const currentHops = params.requestAttributes?.hops ?? 0;
    const nextHops = currentHops + 1;

    // Check if we've exceeded the maximum allowed hops
    if (nextHops > MAX_CHUNK_HOPS_ALLOWED) {
      throw new Error(
        `Maximum hops (${MAX_CHUNK_HOPS_ALLOWED}) exceeded for chunk request`,
      );
    }

    const origin =
      params.requestAttributes?.origin ?? config.ARNS_ROOT_HOST ?? 'unknown';

    const headers = {
      [headerNames.hops]: nextHops.toString(),
      [headerNames.origin]: origin,
    };

    // Retry with different peers on failure
    for (let attempt = 0; attempt < retryCount; attempt++) {
      let selectedPeers: string[];
      try {
        selectedPeers = this.arIODataSource.selectPeers(peerSelectionCount);
      } catch (error) {
        throw new Error(
          `No AR.IO peers available for chunk retrieval: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      log.debug('Selected peers for chunk retrieval attempt', {
        attempt: attempt + 1,
        peers: selectedPeers,
        totalPeers: Object.keys(this.arIODataSource.peers).length,
      });

      // Try each selected peer
      for (const selectedPeer of selectedPeers) {
        try {
          const response = await fetch(
            `${selectedPeer}/chunk/${params.absoluteOffset}`,
            {
              method: 'GET',
              headers,
              signal: AbortSignal.timeout(10000), // 10 second timeout
            },
          );

          if (!response.ok) {
            log.debug('Peer returned non-200 response', {
              peer: selectedPeer,
              status: response.status,
              statusText: response.statusText,
            });
            // Report failure to update peer weights
            this.arIODataSource.handlePeerFailure(selectedPeer);
            continue; // Try next peer
          }

          const chunkResponse = await response.json();

          // Validate response format
          if (!chunkResponse.chunk || !chunkResponse.data_path) {
            log.debug('Peer returned invalid chunk response format', {
              peer: selectedPeer,
            });
            this.arIODataSource.handlePeerFailure(selectedPeer);
            continue; // Try next peer
          }

          // Convert base64url to Buffer
          const chunkBuffer = Buffer.from(chunkResponse.chunk, 'base64url');
          const dataPathBuffer = Buffer.from(
            chunkResponse.data_path,
            'base64url',
          );

          // Calculate hash for validation
          const crypto = await import('node:crypto');
          const hash = crypto.createHash('sha256').update(chunkBuffer).digest();

          log.debug('Successfully fetched chunk from AR.IO peer', {
            peer: selectedPeer,
            chunkSize: chunkBuffer.length,
            dataPathSize: dataPathBuffer.length,
            attempt: attempt + 1,
          });

          // Report success to update peer weights
          // Note: We don't have timing info here, so we'll use placeholder values
          this.arIODataSource.handlePeerSuccess(selectedPeer, 0, 0);

          return {
            chunk: chunkBuffer,
            hash,
            data_path: dataPathBuffer,
            data_root: Buffer.from(params.dataRoot, 'base64url'),
            data_size: params.txSize,
            offset: params.relativeOffset,
            tx_path: undefined, // Not provided by /chunk endpoint
          };
        } catch (error: any) {
          log.debug('Failed to fetch chunk from peer', {
            peer: selectedPeer,
            error: error.message,
            attempt: attempt + 1,
          });
          // Report failure to update peer weights
          this.arIODataSource.handlePeerFailure(selectedPeer);
          // Continue to next peer
        }
      }

      // If we get here, all peers in this attempt failed
      log.debug('All peers failed for attempt', {
        attempt: attempt + 1,
        peersAttempted: selectedPeers.length,
      });
    }

    // All retry attempts failed
    throw new Error(
      `Failed to fetch chunk from AR.IO peers after ${retryCount} attempts`,
    );
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    const chunk = await this.getChunkByAny(params);
    return {
      hash: chunk.hash,
      chunk: chunk.chunk,
    };
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkMetadata> {
    const chunk = await this.getChunkByAny(params);
    return {
      data_root: chunk.data_root,
      data_size: chunk.data_size,
      data_path: chunk.data_path,
      offset: chunk.offset,
      chunk_size: chunk.chunk?.length,
      hash: chunk.hash,
    };
  }
}
