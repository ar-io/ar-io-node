/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosInstance } from 'axios';
import { LRUCache } from 'lru-cache';
import winston from 'winston';

import { TxBoundary, TxBoundarySource } from '../types.js';
import * as metrics from '../metrics.js';
import { parseChunkHeaderMetadata } from '../lib/chunk-header-parser.js';
import {
  AnchoredChunkMetadata,
  ChainAnchorMismatchError,
  anchorChunkMetadata,
} from '../lib/chunk-metadata-anchor.js';

/**
 * Outcome label for {@link metrics.chunkMetadataAnchorTotal}. Mirrors
 * the observer's `observer_chunk_metadata_anchor_total` so dashboards
 * stay consistent across the two services.
 *
 * - `hit`              — peer headers parsed AND cross-checked against chain
 * - `cache_hit`        — same tx already anchored this run; offset in range
 * - `metadata_missing` — peer didn't return required headers
 * - `mismatch`         — chain disagreed with peer headers (caught + falls through)
 * - `error`            — HTTP/network/abort failure (falls through)
 */
type AnchorResult =
  | 'hit'
  | 'cache_hit'
  | 'metadata_missing'
  | 'mismatch'
  | 'error';

/**
 * Resolves `offset → tx + data_root` by HEAD-ing a reference peer's
 * `/chunk/{offset}/data`, parsing the `X-Arweave-Chunk-*` headers, and
 * cross-checking the values against the chain (`/tx/{id}/offset` and
 * `/tx/{id}`). Drops the typical fallback cost from log₂(height) block
 * fetches plus per-block tx search to one HEAD per offset and two chain
 * lookups per unique tx (cached in an LRU keyed by tx-id).
 *
 * Slots into {@link CompositeTxBoundarySource} between the local DB
 * source and the existing tx_path / chain-binary-search fallbacks.
 *
 * Trust model: peer headers are **untrusted input**. Only values
 * returned after cross-check via {@link anchorChunkMetadata} are safe
 * to feed merkle proof validation. On any disagreement
 * ({@link ChainAnchorMismatchError}) this source returns `null` so the
 * composite falls through to the canonical chain binary search — never
 * trust the peer over the node.
 *
 * See architect-handoff/retrieval-hints.md and ar-io/ar-io-node#681.
 */
export class ChunkMetadataAnchorSource implements TxBoundarySource {
  private log: winston.Logger;
  private peerUrls: string[];
  private requestTimeoutMs: number;
  private axiosInstance: AxiosInstance;
  private cache: LRUCache<string, AnchoredChunkMetadata>;
  private fetchTxOffset: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ size: string; offset: string }>;
  private fetchTransaction: (
    txId: string,
    signal?: AbortSignal,
  ) => Promise<{ data_root: string }>;

  constructor({
    log,
    peerUrls,
    requestTimeoutMs,
    cacheSize,
    cacheTtlMs,
    fetchTxOffset,
    fetchTransaction,
    axiosInstance,
  }: {
    log: winston.Logger;
    /**
     * Reference peers to query, in priority order. Only the first entry
     * is used today; future passes can rotate / bias toward peers
     * recently returning valid headers.
     */
    peerUrls: string[];
    requestTimeoutMs: number;
    cacheSize: number;
    cacheTtlMs: number;
    /**
     * Chain `/tx/{id}/offset` fetcher. Returns `{ size, offset }` as
     * strings so they can round-trip through {@link BigInt} without
     * `Number.MAX_SAFE_INTEGER` loss for weave-scale offsets.
     */
    fetchTxOffset: (
      txId: string,
      signal?: AbortSignal,
    ) => Promise<{ size: string; offset: string }>;
    /** Chain `/tx/{id}` fetcher. Only `data_root` is consulted. */
    fetchTransaction: (
      txId: string,
      signal?: AbortSignal,
    ) => Promise<{ data_root: string }>;
    axiosInstance?: AxiosInstance;
  }) {
    if (peerUrls.length === 0) {
      throw new Error(
        'ChunkMetadataAnchorSource requires at least one peer URL',
      );
    }
    this.log = log.child({ class: this.constructor.name });
    this.peerUrls = peerUrls;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchTxOffset = fetchTxOffset;
    this.fetchTransaction = fetchTransaction;
    this.cache = new LRUCache<string, AnchoredChunkMetadata>({
      max: cacheSize,
      ttl: cacheTtlMs,
    });
    this.axiosInstance =
      axiosInstance ??
      axios.create({
        timeout: requestTimeoutMs,
        // Don't throw on 4xx/5xx — let the parser decide whether the
        // headers are usable. Some peers may return 200 + headers even
        // when the chunk body itself is unavailable.
        validateStatus: () => true,
      });
  }

  async getTxBoundary(
    absoluteOffset: bigint,
    signal?: AbortSignal,
  ): Promise<TxBoundary | null> {
    signal?.throwIfAborted();
    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    const peer = this.peerUrls[0];
    const url = `${peer}/chunk/${absoluteOffset}/data`;

    let headers: Record<string, string | string[] | undefined>;
    try {
      headers = await this.fetchPeerChunkHeaders(url, signal);
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      this.recordResult('error');
      log.debug('Peer chunk-header fetch failed', {
        url,
        message: err?.message,
      });
      return null;
    }

    const headerMetadata = parseChunkHeaderMetadata(headers);
    if (headerMetadata === null) {
      this.recordResult('metadata_missing');
      log.debug('Peer did not return required chunk headers', { url });
      return null;
    }

    // Cache hit: tx already anchored — just confirm the probed offset
    // lives inside the chain-derived range. A peer that lies on this
    // call is caught here without a chain round-trip.
    const cached = this.cache.get(headerMetadata.txId);
    if (cached !== undefined) {
      const offsetNum = Number(absoluteOffset);
      if (offsetNum < cached.txStartOffset || offsetNum > cached.txEndOffset) {
        this.recordResult('mismatch');
        log.debug('Cache offset-range mismatch', {
          txId: cached.txId,
          offsetNum,
          txStartOffset: cached.txStartOffset,
          txEndOffset: cached.txEndOffset,
        });
        return null;
      }
      this.recordResult('cache_hit');
      return this.toBoundary(cached);
    }

    let anchored: AnchoredChunkMetadata;
    try {
      anchored = await anchorChunkMetadata({
        headerMetadata,
        offset: Number(absoluteOffset),
        fetchTxOffset: (txId) => this.fetchTxOffset(txId, signal),
        fetchTransaction: (txId) => this.fetchTransaction(txId, signal),
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (err instanceof ChainAnchorMismatchError) {
        this.recordResult('mismatch');
        log.warn('Chain anchor mismatch — falling through', {
          field: err.field,
          headerValue: err.headerValue,
          chainValue: err.chainValue,
          txId: headerMetadata.txId,
        });
        return null;
      }
      this.recordResult('error');
      log.debug('Chain anchor cross-check failed', {
        message: err?.message,
        txId: headerMetadata.txId,
      });
      return null;
    }

    this.cache.set(headerMetadata.txId, anchored);
    this.recordResult('hit');
    return this.toBoundary(anchored);
  }

  /**
   * HEAD `/chunk/{offset}/data` first; if the peer rejects HEAD (some
   * non-ar-io peers don't implement it on this route) fall back to a
   * zero-byte range GET so we still get the response headers without
   * pulling the body. Returns the raw header bag for the parser.
   *
   * Three "HEAD didn't work" cases all funnel into the same fallback:
   * - HEAD threw (network error, peer down, peer doesn't support HEAD)
   * - HEAD returned a non-2xx status (e.g. 405 Method Not Allowed)
   * - HEAD returned 2xx but stripped the X-Arweave-Chunk-* headers
   *   (some proxies do this on HEAD even though GET sets them)
   *
   * GET errors propagate up — both methods failing means the peer is
   * unreachable and the composite should fall through to the next
   * source.
   */
  private async fetchPeerChunkHeaders(
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[] | undefined>> {
    try {
      const headResponse = await this.axiosInstance.head(url, {
        signal,
        timeout: this.requestTimeoutMs,
      });
      if (
        headResponse.status >= 200 &&
        headResponse.status < 300 &&
        hasAnyChunkHeader(headResponse.headers)
      ) {
        return headResponse.headers as Record<
          string,
          string | string[] | undefined
        >;
      }
    } catch (err: any) {
      // Re-throw aborts so the caller's signal handling stays correct.
      if (err?.name === 'AbortError') throw err;
      // Otherwise fall through to the GET fallback below.
    }

    // `bytes=0-0` is the smallest legal range; the server returns a 1-
    // byte body which we discard. Headers are the only thing we want.
    const getResponse = await this.axiosInstance.get(url, {
      signal,
      timeout: this.requestTimeoutMs,
      headers: { Range: 'bytes=0-0' },
      responseType: 'arraybuffer',
    });
    return getResponse.headers as Record<string, string | string[] | undefined>;
  }

  private recordResult(result: AnchorResult): void {
    metrics.chunkMetadataAnchorTotal.inc({ result });
  }

  private toBoundary(anchored: AnchoredChunkMetadata): TxBoundary {
    return {
      id: anchored.txId,
      dataRoot: anchored.dataRoot.toString('base64url'),
      dataSize: anchored.txEndOffset - anchored.txStartOffset + 1,
      weaveOffset: anchored.txEndOffset,
    };
  }
}

function hasAnyChunkHeader(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object') return false;
  const lowered = Object.keys(headers as Record<string, unknown>).map((k) =>
    k.toLowerCase(),
  );
  return lowered.some((k) => k.startsWith('x-arweave-chunk-'));
}
