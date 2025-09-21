/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { release } from '../version.js';
import { tracer } from '../tracing.js';
import {
  ArIOPeerManager,
  PeerSuccessMetrics,
} from '../peers/ar-io-peer-manager.js';
import {
  generateRequestAttributes,
  validateHopCount,
} from '../lib/request-attributes.js';
import { validateChunk } from '../lib/validation.js';
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
const MAX_CHUNK_HOPS = 1;
const CHUNK_CATEGORY = 'chunk';

export class ArIOChunkSource
  implements ChunkDataByAnySource, ChunkMetadataByAnySource
{
  private log: winston.Logger;
  private peerManager: ArIOPeerManager;
  private chunkPromiseCache: LRUCache<string, Promise<Chunk>>;

  constructor({
    log,
    peerManager,
  }: {
    log: winston.Logger;
    peerManager: ArIOPeerManager;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.peerManager = peerManager;

    // Initialize promise cache with capacity and TTL
    this.chunkPromiseCache = new LRUCache<string, Promise<Chunk>>({
      max: CHUNK_CACHE_CAPACITY,
      ttl: CHUNK_CACHE_TTL_SECONDS * 1000, // Convert to milliseconds
    });
  }

  private selectChunkPeers(peerCount: number): string[] {
    return this.peerManager.selectPeers(CHUNK_CATEGORY, peerCount);
  }

  private handleChunkPeerSuccess(peer: string, responseTimeMs: number): void {
    metrics.getChunkTotal.inc({
      status: 'success',
      method: 'ar-io-network',
      class: this.constructor.name,
    });

    const successMetrics: PeerSuccessMetrics = {
      responseTimeMs,
    };

    this.peerManager.reportSuccess(CHUNK_CATEGORY, peer, successMetrics);
  }

  private handleChunkPeerFailure(peer: string): void {
    metrics.getChunkTotal.inc({
      status: 'error',
      method: 'ar-io-network',
      class: this.constructor.name,
    });

    this.peerManager.reportFailure(CHUNK_CATEGORY, peer);
  }

  private getCacheKey(params: ChunkDataByAnySourceParams): string {
    // Include all parameters needed for cache reconstruction
    return `${params.dataRoot}:${params.absoluteOffset}:${params.txSize}:${params.relativeOffset}`;
  }

  private validateRequestHops(params: ChunkDataByAnySourceParams): void {
    const currentHops = params.requestAttributes?.hops ?? 0;
    validateHopCount(currentHops, MAX_CHUNK_HOPS);
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    const span = tracer.startSpan('ArIOChunkSource.getChunkByAny', {
      attributes: {
        'chunk.data_root': params.dataRoot,
        'chunk.absolute_offset': params.absoluteOffset,
        'chunk.relative_offset': params.relativeOffset,
        'chunk.tx_size': params.txSize,
      },
    });

    try {
      const cacheKey = this.getCacheKey(params);

      // Check for existing promise (either in-flight or resolved)
      const existingPromise = this.chunkPromiseCache.get(cacheKey);
      if (existingPromise) {
        span.setAttribute('chunk.cache_hit', true);
        span.addEvent('Using cached promise');
        const result = await existingPromise;
        span.setAttribute('chunk.source', result.source ?? 'unknown');
        span.setAttribute('chunk.source_host', result.sourceHost ?? 'unknown');
        return result;
      }

      span.setAttribute('chunk.cache_hit', false);
      span.addEvent('Creating new fetch promise');

      // Create new promise that fetches with FULL params including request attributes
      const chunkPromise = this.fetchChunkFromArIOPeer(params);

      // Store promise in cache
      this.chunkPromiseCache.set(cacheKey, chunkPromise);

      const result = await chunkPromise;
      span.setAttribute('chunk.source', result.source ?? 'unknown');
      span.setAttribute('chunk.source_host', result.sourceHost ?? 'unknown');
      return result;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async fetchChunkFromArIOPeer(
    params: ChunkDataByAnySourceParams,
    retryCount = 5,
    peerSelectionCount = 3,
  ): Promise<Chunk> {
    const span = tracer.startSpan('ArIOChunkSource.fetchChunkFromArIOPeer', {
      attributes: {
        'chunk.data_root': params.dataRoot,
        'chunk.absolute_offset': params.absoluteOffset,
        'chunk.retry_count': retryCount,
        'chunk.peer_selection_count': peerSelectionCount,
        'chunk.current_hops': params.requestAttributes?.hops ?? 0,
      },
    });

    const log = this.log.child({ method: 'fetchChunkFromArIOPeer' });

    try {
      log.debug('Fetching chunk from AR.IO peer', {
        dataRoot: params.dataRoot,
        absoluteOffset: params.absoluteOffset,
      });

      // Validate hop count before proceeding
      this.validateRequestHops(params);

      // Generate request attributes with hop increment and headers
      const currentHops = params.requestAttributes?.hops ?? 0;
      const requestAttributesHeaders = generateRequestAttributes({
        hops: currentHops,
        // Initialize origin and originNodeRelease if both are missing
        origin:
          params.requestAttributes?.origin ??
          (params.requestAttributes?.originNodeRelease == null &&
          config.ARNS_ROOT_HOST != null
            ? config.ARNS_ROOT_HOST
            : undefined),
        originNodeRelease:
          params.requestAttributes?.originNodeRelease ??
          (params.requestAttributes?.origin == null &&
          config.ARNS_ROOT_HOST != null
            ? release
            : undefined),
        arnsName: params.requestAttributes?.arnsName,
        arnsBasename: params.requestAttributes?.arnsBasename,
        arnsRecord: params.requestAttributes?.arnsRecord,
        clientIp: params.requestAttributes?.clientIp,
        clientIps: params.requestAttributes?.clientIps || [],
      });

      const headers = requestAttributesHeaders?.headers || {};

      // Retry with different peers on failure
      for (let attempt = 0; attempt < retryCount; attempt++) {
        span.addEvent('Starting retry attempt', {
          attempt: attempt + 1,
          max_attempts: retryCount,
        });

        let selectedPeers: string[];
        try {
          selectedPeers = this.selectChunkPeers(peerSelectionCount);
        } catch (error: any) {
          span.recordException(error);
          throw new Error(
            `No AR.IO peers available for chunk retrieval: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }

        span.setAttributes({
          'chunk.selected_peers_count': selectedPeers.length,
          'chunk.total_peers_available': this.peerManager.getPeerUrls().length,
        });

        log.debug('Selected peers for chunk retrieval attempt', {
          attempt: attempt + 1,
          peers: selectedPeers,
          totalPeers: this.peerManager.getPeerUrls().length,
        });

        // Try each selected peer
        for (const selectedPeer of selectedPeers) {
          const startTime = Date.now();
          const peerHost = new URL(selectedPeer).hostname;

          span.addEvent('Trying peer', {
            peer_host: peerHost,
            attempt: attempt + 1,
          });

          try {
            const response = await fetch(
              `${selectedPeer}/chunk/${params.absoluteOffset}`,
              {
                method: 'GET',
                headers: {
                  ...(config.AR_IO_NODE_RELEASE !== undefined
                    ? { 'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE }
                    : {}),
                  ...headers,
                },
                signal: AbortSignal.timeout(10000), // 10 second timeout
              },
            );

            const responseTime = Date.now() - startTime;

            if (!response.ok) {
              span.addEvent('Peer returned error response', {
                peer_host: peerHost,
                status_code: response.status,
                response_time_ms: responseTime,
              });

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
              span.addEvent('Peer returned invalid chunk format', {
                peer_host: peerHost,
                response_time_ms: responseTime,
              });

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
            const hash = crypto
              .createHash('sha256')
              .update(chunkBuffer)
              .digest();

            const responseTimeMs = Date.now() - startTime;

            span.addEvent('Chunk retrieval successful', {
              peer_host: peerHost,
              chunk_size: chunkBuffer.length,
              data_path_size: dataPathBuffer.length,
              response_time_ms: responseTimeMs,
              attempt: attempt + 1,
            });

            log.debug('Successfully fetched chunk from AR.IO peer', {
              peer: selectedPeer,
              chunkSize: chunkBuffer.length,
              dataPathSize: dataPathBuffer.length,
              responseTimeMs,
              attempt: attempt + 1,
            });

            // Report success to update chunk-specific peer weights
            this.handleChunkPeerSuccess(selectedPeer, responseTimeMs);

            // Extract hostname from peer URL for source tracking
            const sourceHost = new URL(selectedPeer).hostname;

            const chunk = {
              chunk: chunkBuffer,
              hash,
              data_path: dataPathBuffer,
              data_root: Buffer.from(params.dataRoot, 'base64url'),
              data_size: params.txSize,
              offset: params.relativeOffset,
              tx_path: undefined, // Not provided by /chunk endpoint
              source: 'ar-io-network',
              sourceHost,
            };

            span.setAttributes({
              'chunk.successful_peer': peerHost,
              'chunk.final_attempt': attempt + 1,
              'chunk.response_time_ms': responseTimeMs,
              'chunk.size': chunkBuffer.length,
            });

            // Validate chunk integrity against Merkle tree structure
            await validateChunk(
              params.txSize,
              chunk,
              Buffer.from(params.dataRoot, 'base64url'),
              params.relativeOffset,
            );

            span.addEvent('Chunk validation successful');
            return chunk;
          } catch (error: any) {
            const responseTime = Date.now() - startTime;
            span.addEvent('Peer request failed', {
              peer_host: peerHost,
              error: error.message,
              response_time_ms: responseTime,
              attempt: attempt + 1,
            });

            log.debug('Failed to fetch chunk from peer', {
              peer: selectedPeer,
              error: error.message,
              attempt: attempt + 1,
              responseTimeMs: responseTime,
            });
            // Report failure to update chunk-specific peer weights
            this.handleChunkPeerFailure(selectedPeer);
            // Continue to next peer
          }
        }

        // If we get here, all peers in this attempt failed
        span.addEvent('All peers failed for attempt', {
          attempt: attempt + 1,
          peers_attempted: selectedPeers.length,
        });

        log.debug('All peers failed for attempt', {
          attempt: attempt + 1,
          peersAttempted: selectedPeers.length,
        });
      }

      // All retry attempts failed
      span.addEvent('All retry attempts failed', {
        total_attempts: retryCount,
      });

      const error = new Error(
        `Failed to fetch chunk from AR.IO peers after ${retryCount} attempts`,
      );
      span.recordException(error);
      throw error;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    const chunk = await this.getChunkByAny(params);
    return {
      hash: chunk.hash,
      chunk: chunk.chunk,
      source: chunk.source,
      sourceHost: chunk.sourceHost,
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
