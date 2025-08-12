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
import * as metrics from '../metrics.js';
import { ArIODataSource } from './ar-io-data-source.js';
import { shuffleArray } from '../lib/random.js';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
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

  // Independent peer weights for chunk retrieval performance
  private chunkWeightedPeers: WeightedElement<string>[] = [];
  private previousChunkPeerResponseTimes: number[] = [];

  // Memoized random weighted choice function for chunk peers
  private getRandomWeightedChunkPeers: (
    table: WeightedElement<string>[],
    peerCount: number,
  ) => string[];

  constructor({
    log,
    arIODataSource,
  }: {
    log: winston.Logger;
    arIODataSource: ArIODataSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arIODataSource = arIODataSource;

    // Initialize random weighted choice function for chunk peers
    this.getRandomWeightedChunkPeers = (
      table: WeightedElement<string>[],
      peerCount: number,
    ) => {
      return randomWeightedChoices({
        table,
        count: peerCount,
      });
    };

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

    // Initialize chunk peer weights from available peers
    this.updateChunkPeerWeights();
  }

  private updateChunkPeerWeights(): void {
    const peers = this.arIODataSource.peers;
    this.chunkWeightedPeers = Object.values(peers).map((id) => {
      const previousWeight =
        this.chunkWeightedPeers.find((peer) => peer.id === id)?.weight ??
        undefined;
      return {
        id,
        weight: previousWeight === undefined ? 50 : previousWeight,
      };
    });
  }

  private selectChunkPeers(peerCount: number): string[] {
    const log = this.log.child({ method: 'selectChunkPeers' });

    // Update weights from latest peer list
    this.updateChunkPeerWeights();

    if (this.chunkWeightedPeers.length === 0) {
      log.warn('No weighted chunk peers available');
      throw new Error('No weighted chunk peers available');
    }

    return shuffleArray([
      ...this.getRandomWeightedChunkPeers(this.chunkWeightedPeers, peerCount),
    ]);
  }

  private handleChunkPeerSuccess(peer: string, responseTimeMs: number): void {
    metrics.getChunkTotal.inc({
      status: 'success',
      method: 'ar-io-network',
      class: this.constructor.name,
    });

    this.previousChunkPeerResponseTimes.push(responseTimeMs);
    if (
      this.previousChunkPeerResponseTimes.length >
      config.GATEWAY_PEERS_REQUEST_WINDOW_COUNT
    ) {
      this.previousChunkPeerResponseTimes.shift();
    }

    const currentAverageResponseTime =
      this.previousChunkPeerResponseTimes.length === 0
        ? 0
        : this.previousChunkPeerResponseTimes.reduce(
            (acc, value) => acc + value,
            0,
          ) / this.previousChunkPeerResponseTimes.length;

    const additionalWeightFromResponseTime =
      responseTimeMs > currentAverageResponseTime
        ? 0
        : config.WEIGHTED_PEERS_TEMPERATURE_DELTA;

    // Warm the succeeding chunk peer
    this.chunkWeightedPeers.forEach((weightedPeer) => {
      if (weightedPeer.id === peer) {
        weightedPeer.weight = Math.min(
          weightedPeer.weight +
            config.WEIGHTED_PEERS_TEMPERATURE_DELTA +
            additionalWeightFromResponseTime,
          100,
        );
      }
    });
  }

  private handleChunkPeerFailure(peer: string): void {
    metrics.getChunkTotal.inc({
      status: 'error',
      method: 'ar-io-network',
      class: this.constructor.name,
    });

    // Cool the failing chunk peer
    this.chunkWeightedPeers.forEach((weightedPeer) => {
      if (weightedPeer.id === peer) {
        weightedPeer.weight = Math.max(
          weightedPeer.weight - config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
          1,
        );
      }
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
        selectedPeers = this.selectChunkPeers(peerSelectionCount);
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
        const startTime = Date.now();
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
            // Report failure to update chunk-specific peer weights
            this.handleChunkPeerFailure(selectedPeer);
            continue; // Try next peer
          }

          const chunkResponse = await response.json();

          // Validate response format
          if (!chunkResponse.chunk || !chunkResponse.data_path) {
            log.debug('Peer returned invalid chunk response format', {
              peer: selectedPeer,
            });
            this.handleChunkPeerFailure(selectedPeer);
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

          const responseTimeMs = Date.now() - startTime;

          log.debug('Successfully fetched chunk from AR.IO peer', {
            peer: selectedPeer,
            chunkSize: chunkBuffer.length,
            dataPathSize: dataPathBuffer.length,
            responseTimeMs,
            attempt: attempt + 1,
          });

          // Report success to update chunk-specific peer weights
          this.handleChunkPeerSuccess(selectedPeer, responseTimeMs);

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
            responseTimeMs: Date.now() - startTime,
          });
          // Report failure to update chunk-specific peer weights
          this.handleChunkPeerFailure(selectedPeer);
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
