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
import { isValidationParams, validateChunk } from '../lib/validation.js';
import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  ChunkMetadata,
  ChunkMetadataByAnySource,
  Chunk,
  ChunkWithValidationParams,
  RequestAttributes,
  UnvalidatedChunk,
  UnvalidatedChunkSource,
} from '../types.js';

// Local constants (no configuration needed)
const CHUNK_CACHE_CAPACITY = 100;
const CHUNK_CACHE_TTL_SECONDS = 60;
const MAX_CHUNK_HOPS = 1;
const CHUNK_CATEGORY = 'chunk';

// Peer chunk retrieval constants
const PEER_REQUEST_TIMEOUT_MS = 1000; // 1 second timeout per peer request
const PEER_SELECTION_COUNT = 2; // Number of peers to try in parallel
const MAX_RETRY_COUNT = 2; // Total attempts (initial + 1 retry)

/**
 * Races a promise against an abort signal.
 * Allows each caller to respect their own abort signal when sharing a cached promise.
 */
function withAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      })
      .catch((error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
  });
}

/**
 * Options for fetching chunks from AR.IO peers.
 * If validationParams is provided, the chunk will be validated and returned as Chunk.
 * Otherwise, the chunk is returned as UnvalidatedChunk.
 */
interface FetchChunkOptions {
  absoluteOffset: number;
  requestAttributes?: RequestAttributes;
  retryCount?: number;
  peerSelectionCount?: number;
  /** If provided, validates chunk and returns Chunk; otherwise returns UnvalidatedChunk */
  validationParams?: {
    txSize: number;
    dataRoot: string;
    relativeOffset: number;
  };
  /** Optional abort signal from client request to cancel operations */
  clientSignal?: AbortSignal;
}

export class ArIOChunkSource
  implements
    ChunkDataByAnySource,
    ChunkMetadataByAnySource,
    UnvalidatedChunkSource
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

  private getCacheKey(params: ChunkWithValidationParams): string {
    // Include all parameters needed for cache reconstruction
    return `${params.dataRoot}:${params.absoluteOffset}:${params.txSize}:${params.relativeOffset}`;
  }

  /**
   * Core method for fetching chunks from AR.IO peers with retry logic.
   * Uses parallel peer requests for faster retrieval.
   * If validationParams is provided, validates and returns Chunk.
   * Otherwise returns UnvalidatedChunk.
   */
  private async fetchChunkFromPeers(
    options: FetchChunkOptions,
  ): Promise<Chunk | UnvalidatedChunk> {
    const {
      absoluteOffset,
      requestAttributes,
      retryCount = MAX_RETRY_COUNT,
      peerSelectionCount = PEER_SELECTION_COUNT,
      validationParams,
      clientSignal,
    } = options;

    // Check for abort before starting
    clientSignal?.throwIfAborted();

    const isValidated = validationParams !== undefined;
    const spanName = isValidated
      ? 'ArIOChunkSource.fetchChunkFromArIOPeer'
      : 'ArIOChunkSource.fetchUnvalidatedChunkFromArIOPeer';

    const span = tracer.startSpan(spanName, {
      attributes: {
        'chunk.absolute_offset': absoluteOffset,
        'chunk.retry_count': retryCount,
        'chunk.peer_selection_count': peerSelectionCount,
        'chunk.current_hops': requestAttributes?.hops ?? 0,
        ...(isValidated && {
          'chunk.data_root': validationParams.dataRoot,
        }),
      },
    });

    const log = this.log.child({
      method: isValidated
        ? 'fetchChunkFromArIOPeer'
        : 'fetchUnvalidatedChunkFromArIOPeer',
    });

    try {
      log.debug(
        isValidated
          ? 'Fetching chunk from AR.IO peer'
          : 'Fetching unvalidated chunk from AR.IO peer',
        {
          absoluteOffset,
          ...(isValidated && { dataRoot: validationParams.dataRoot }),
        },
      );

      // Validate hop count before proceeding
      const currentHops = requestAttributes?.hops ?? 0;
      validateHopCount(currentHops, MAX_CHUNK_HOPS);

      // Generate request attributes with hop increment and headers
      const requestAttributesHeaders = generateRequestAttributes({
        hops: currentHops,
        origin:
          requestAttributes?.origin ??
          (requestAttributes?.originNodeRelease == null &&
          config.ARNS_ROOT_HOST != null
            ? config.ARNS_ROOT_HOST
            : undefined),
        originNodeRelease:
          requestAttributes?.originNodeRelease ??
          (requestAttributes?.origin == null && config.ARNS_ROOT_HOST != null
            ? release
            : undefined),
        arnsName: requestAttributes?.arnsName,
        arnsBasename: requestAttributes?.arnsBasename,
        arnsRecord: requestAttributes?.arnsRecord,
        clientIp: requestAttributes?.clientIp,
        clientIps: requestAttributes?.clientIps || [],
      });

      const headers = requestAttributesHeaders?.headers || {};

      // Select all peers upfront to ensure different peers are used for each attempt
      // (peer selection is cached, so selecting per-attempt would return the same peers)
      const totalPeersNeeded = peerSelectionCount * retryCount;
      let allSelectedPeers: string[];
      try {
        allSelectedPeers = this.selectChunkPeers(totalPeersNeeded);
      } catch (error: any) {
        span.recordException(error);
        throw new Error(
          `No AR.IO peers available for chunk retrieval: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      span.setAttributes({
        'chunk.total_selected_peers': allSelectedPeers.length,
        'chunk.total_peers_available': this.peerManager.getPeerUrls().length,
      });

      log.debug('Selected peers for all chunk retrieval attempts', {
        peers: allSelectedPeers,
        totalPeers: this.peerManager.getPeerUrls().length,
      });

      // Retry with different peers on failure (try peers in parallel each attempt)
      for (let attempt = 0; attempt < retryCount; attempt++) {
        // Get the peers for this attempt
        const startIdx = attempt * peerSelectionCount;
        const endIdx = startIdx + peerSelectionCount;
        const selectedPeers = allSelectedPeers.slice(startIdx, endIdx);

        // Skip if no peers available for this attempt
        if (selectedPeers.length === 0) {
          log.debug('No peers available for attempt', { attempt: attempt + 1 });
          continue;
        }

        span.addEvent('Starting retry attempt', {
          attempt: attempt + 1,
          max_attempts: retryCount,
          peer_count: selectedPeers.length,
        });

        log.debug(
          isValidated
            ? 'Trying peers for chunk retrieval attempt'
            : 'Trying peers for unvalidated chunk retrieval attempt',
          {
            attempt: attempt + 1,
            peers: selectedPeers,
          },
        );

        span.addEvent('Trying peers in parallel', {
          peer_count: selectedPeers.length,
          peers: selectedPeers.map((p) => new URL(p).hostname).join(', '),
          attempt: attempt + 1,
        });

        // Create AbortController to cancel losing requests when one succeeds
        const controller = new AbortController();

        // Try all selected peers in parallel, return first success
        try {
          const result = await Promise.any(
            selectedPeers.map((peer) =>
              this.fetchFromSinglePeer(
                peer,
                absoluteOffset,
                headers,
                validationParams,
                controller.signal,
                clientSignal,
              ),
            ),
          );

          // Abort remaining in-flight requests to free resources
          controller.abort();

          span.setAttributes({
            'chunk.successful_peer': result.sourceHost ?? 'unknown',
            'chunk.final_attempt': attempt + 1,
            'chunk.size': result.chunk?.length ?? 0,
          });

          span.addEvent(
            isValidated
              ? 'Chunk retrieval successful'
              : 'Unvalidated chunk retrieval successful',
            {
              source_host: result.sourceHost ?? 'unknown',
              chunk_size: result.chunk?.length ?? 0,
              attempt: attempt + 1,
            },
          );

          return result;
        } catch (error: any) {
          // Abort any stragglers before retrying with new peers
          controller.abort();

          // AggregateError means all promises rejected
          span.addEvent('All peers failed for attempt', {
            attempt: attempt + 1,
            peers_attempted: selectedPeers.length,
          });

          log.debug('All peers failed for attempt', {
            attempt: attempt + 1,
            peersAttempted: selectedPeers.length,
          });
        }
      }

      // All retry attempts failed
      span.addEvent('All retry attempts failed', {
        total_attempts: retryCount,
      });

      const error = new Error(
        isValidated
          ? `Failed to fetch chunk from AR.IO peers after ${retryCount} attempts`
          : `Failed to fetch unvalidated chunk from AR.IO peers after ${retryCount} attempts`,
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

  async getChunkByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<Chunk> {
    // Check for abort before starting
    signal?.throwIfAborted();

    // This source only supports validation params (txSize, dataRoot, relativeOffset)
    if (!isValidationParams(params)) {
      throw new Error(
        'ArIOChunkSource requires validation params (txSize, dataRoot, relativeOffset)',
      );
    }

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
        const result = await withAbortSignal(existingPromise, signal);
        span.setAttribute('chunk.source', result.source ?? 'unknown');
        span.setAttribute('chunk.source_host', result.sourceHost ?? 'unknown');
        return result;
      }

      span.setAttribute('chunk.cache_hit', false);
      span.addEvent('Creating new fetch promise');

      // Create new promise that fetches with FULL params including request attributes
      // Remove cache entry on abort to prevent polluting subsequent requests
      const chunkPromise = this.fetchChunkFromArIOPeer(params, signal).catch(
        (error) => {
          if (error.name === 'AbortError') {
            this.chunkPromiseCache.delete(cacheKey);
          }
          throw error;
        },
      );

      // Store promise in cache
      this.chunkPromiseCache.set(cacheKey, chunkPromise);

      const result = await chunkPromise;
      span.setAttribute('chunk.source', result.source ?? 'unknown');
      span.setAttribute('chunk.source_host', result.sourceHost ?? 'unknown');
      return result;
    } catch (error: any) {
      // Don't record AbortError as an exception
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Fetches a chunk from a single peer with timeout handling.
   * If validationParams is provided, validates and returns Chunk.
   * Otherwise returns UnvalidatedChunk.
   * Throws on failure.
   *
   * @param internalSignal - Optional AbortSignal to cancel the request early
   *                         (e.g., when another peer succeeds first)
   * @param clientSignal - Optional AbortSignal from client request (e.g., client disconnect)
   */
  private async fetchFromSinglePeer(
    peer: string,
    absoluteOffset: number,
    headers: Record<string, string>,
    validationParams?: {
      txSize: number;
      dataRoot: string;
      relativeOffset: number;
    },
    internalSignal?: AbortSignal,
    clientSignal?: AbortSignal,
  ): Promise<Chunk | UnvalidatedChunk> {
    const startTime = Date.now();
    const peerHost = new URL(peer).hostname;
    const isValidated = validationParams !== undefined;
    const log = this.log.child({ method: 'fetchFromSinglePeer' });

    // Combine timeout with internal abort signal (for canceling losing requests)
    // and client abort signal (for client disconnects)
    const signals: AbortSignal[] = [
      AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS),
    ];
    if (internalSignal) signals.push(internalSignal);
    if (clientSignal) signals.push(clientSignal);
    const signal = AbortSignal.any(signals);

    try {
      const response = await fetch(`${peer}/chunk/${absoluteOffset}`, {
        method: 'GET',
        headers: {
          ...(config.AR_IO_NODE_RELEASE !== undefined
            ? { 'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE }
            : {}),
          ...headers,
        },
        signal,
      });

      if (!response.ok) {
        log.debug('Peer returned non-200 response', {
          peer,
          status: response.status,
          statusText: response.statusText,
        });
        this.handleChunkPeerFailure(peer);
        throw new Error(`Peer ${peerHost} returned status ${response.status}`);
      }

      const chunkResponse = await response.json();

      // Validate response format
      if (!chunkResponse.chunk || !chunkResponse.data_path) {
        log.debug('Peer returned invalid chunk response format', { peer });
        this.handleChunkPeerFailure(peer);
        throw new Error(`Peer ${peerHost} returned invalid chunk format`);
      }

      // Convert base64url to Buffer
      const chunkBuffer = Buffer.from(chunkResponse.chunk, 'base64url');
      const dataPathBuffer = Buffer.from(chunkResponse.data_path, 'base64url');
      const txPathBuffer = chunkResponse.tx_path
        ? Buffer.from(chunkResponse.tx_path, 'base64url')
        : undefined;

      // Calculate hash
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('sha256').update(chunkBuffer).digest();

      const responseTimeMs = Date.now() - startTime;

      log.debug(
        isValidated
          ? 'Successfully fetched chunk from AR.IO peer'
          : 'Successfully fetched unvalidated chunk from AR.IO peer',
        {
          peer,
          chunkSize: chunkBuffer.length,
          dataPathSize: dataPathBuffer.length,
          ...(isValidated ? {} : { hasTxPath: txPathBuffer !== undefined }),
          responseTimeMs,
        },
      );

      // Report success to update chunk-specific peer weights
      this.handleChunkPeerSuccess(peer, responseTimeMs);

      // Extract hostname from peer URL for source tracking
      const sourceHost = new URL(peer).hostname;

      if (isValidated) {
        const chunk: Chunk = {
          chunk: chunkBuffer,
          hash,
          data_path: dataPathBuffer,
          data_root: Buffer.from(validationParams.dataRoot, 'base64url'),
          data_size: validationParams.txSize,
          offset: validationParams.relativeOffset,
          tx_path: txPathBuffer,
          source: 'ar-io-network',
          sourceHost,
        };

        // Validate chunk integrity against Merkle tree structure
        await validateChunk(
          validationParams.txSize,
          chunk,
          Buffer.from(validationParams.dataRoot, 'base64url'),
          validationParams.relativeOffset,
        );

        return chunk;
      } else {
        return {
          chunk: chunkBuffer,
          hash,
          data_path: dataPathBuffer,
          tx_path: txPathBuffer,
          source: 'ar-io-network',
          sourceHost,
        };
      }
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      log.debug(
        isValidated
          ? 'Failed to fetch chunk from peer'
          : 'Failed to fetch unvalidated chunk from peer',
        {
          peer,
          error: error.message,
          responseTimeMs: responseTime,
        },
      );
      // Only report failure for actual errors, not aborted requests
      if (error.name !== 'AbortError') {
        this.handleChunkPeerFailure(peer);
      }
      throw error;
    }
  }

  private async fetchChunkFromArIOPeer(
    params: ChunkWithValidationParams,
    signal?: AbortSignal,
  ): Promise<Chunk> {
    return this.fetchChunkFromPeers({
      absoluteOffset: params.absoluteOffset,
      requestAttributes: params.requestAttributes,
      retryCount: MAX_RETRY_COUNT,
      peerSelectionCount: PEER_SELECTION_COUNT,
      validationParams: {
        txSize: params.txSize,
        dataRoot: params.dataRoot,
        relativeOffset: params.relativeOffset,
      },
      clientSignal: signal,
    }) as Promise<Chunk>;
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkData> {
    const chunk = await this.getChunkByAny(params, signal);
    return {
      hash: chunk.hash,
      chunk: chunk.chunk,
      source: chunk.source,
      sourceHost: chunk.sourceHost,
    };
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkMetadata> {
    const chunk = await this.getChunkByAny(params, signal);
    return {
      data_root: chunk.data_root,
      data_size: chunk.data_size,
      data_path: chunk.data_path,
      offset: chunk.offset,
      chunk_size: chunk.chunk?.length,
      hash: chunk.hash,
    };
  }

  /**
   * Fetch chunk from AR.IO peers WITHOUT validation.
   * Validation is deferred to the handler level.
   */
  async getUnvalidatedChunk(
    absoluteOffset: number,
    requestAttributes?: RequestAttributes,
    signal?: AbortSignal,
  ): Promise<UnvalidatedChunk> {
    // Check for abort before starting
    signal?.throwIfAborted();

    const span = tracer.startSpan('ArIOChunkSource.getUnvalidatedChunk', {
      attributes: {
        'chunk.absolute_offset': absoluteOffset,
      },
    });

    try {
      return await this.fetchUnvalidatedChunkFromArIOPeer(
        absoluteOffset,
        requestAttributes,
        signal,
      );
    } catch (error: any) {
      // Don't record AbortError as an exception
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  private async fetchUnvalidatedChunkFromArIOPeer(
    absoluteOffset: number,
    requestAttributes?: RequestAttributes,
    signal?: AbortSignal,
  ): Promise<UnvalidatedChunk> {
    return this.fetchChunkFromPeers({
      absoluteOffset,
      requestAttributes,
      clientSignal: signal,
      // Uses default constants: MAX_RETRY_COUNT and PEER_SELECTION_COUNT
    }) as Promise<UnvalidatedChunk>;
  }
}
