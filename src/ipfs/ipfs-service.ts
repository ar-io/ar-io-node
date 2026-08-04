/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import winston from 'winston';
import { Span } from '@opentelemetry/api';

import { cidToV1Base32 } from '../lib/ipfs-cid.js';
import { startChildSpan } from '../tracing.js';
import { IpfsFsCache } from './ipfs-cache.js';
import { DataBlockListValidator } from '../types.js';
import { NegativeDataCache } from '../data/negative-data-cache.js';
import {
  KuboDataSource,
  IpfsBlockedError,
  IpfsNotFoundError,
  IpfsSizeLimitError,
} from './kubo-data-source.js';
import * as metrics from '../metrics.js';

export interface IpfsGetContentResult {
  stream: Readable;
  size: number;
  contentType: string;
  cached: boolean;
  /**
   * base64url SHA-256 of the served bytes, present on cache hits (computed at
   * cache-write time). Used to emit an RFC 9530 Content-Digest. Absent on cache
   * misses (the body streams straight from Kubo without being hashed inline).
   */
  digest?: string;
  // 200 for a full response, 206 for a partial (Range) response.
  statusCode: number;
  // Present on 206 responses: the upstream Content-Range header value.
  contentRange?: string;
}

export class IpfsService {
  private log: winston.Logger;
  private dataSource: KuboDataSource;
  private cache: IpfsFsCache;
  private blockListValidator: DataBlockListValidator;
  private maxResponseSizeBytes: number;
  private negativeCache?: NegativeDataCache;
  // CIDs whose served bytes were found to be blocked-by-hash. IPFS content is
  // streamed before its SHA-256 is known, so the very first (uncached) fetch of
  // never-seen hash-blocked content cannot be stopped pre-serve — but once its
  // hash is known we remember the CID and block every later request pre-serve,
  // without persisting the bytes. CID-level blocking (isIdBlocked) remains the
  // deterministic pre-serve primitive for IPFS. Bounded, FIFO-evicted, in-memory
  // (re-learned after restart).
  private readonly knownHashBlockedCids = new Set<string>();
  private static readonly MAX_KNOWN_HASH_BLOCKED = 10_000;

  constructor({
    log,
    dataSource,
    cache,
    blockListValidator,
    maxResponseSizeBytes,
    negativeCache,
  }: {
    log: winston.Logger;
    dataSource: KuboDataSource;
    cache: IpfsFsCache;
    blockListValidator: DataBlockListValidator;
    maxResponseSizeBytes: number;
    negativeCache?: NegativeDataCache;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.cache = cache;
    this.blockListValidator = blockListValidator;
    this.maxResponseSizeBytes = maxResponseSizeBytes;
    this.negativeCache = negativeCache;
  }

  async getContent({
    cidString,
    path,
    signal,
    parentSpan,
    range,
  }: {
    cidString: string;
    path?: string;
    signal?: AbortSignal;
    parentSpan?: Span;
    range?: string;
  }): Promise<IpfsGetContentResult> {
    const span = startChildSpan(
      'IpfsService.getContent',
      {
        attributes: {
          'ipfs.cid': cidString,
          'ipfs.path': path ?? '',
        },
      },
      parentSpan,
    );

    try {
      // Normalize CID to v1 base32 for consistent caching
      const normalizedCid = cidToV1Base32(cidString);
      span.setAttribute('ipfs.cid_normalized', normalizedCid);

      // Check blocklist (uses the same admin API as Arweave data moderation)
      if (await this.blockListValidator.isIdBlocked(normalizedCid)) {
        metrics.ipfsBlockedTotal.inc();
        span.setAttribute('ipfs.blocked', true);
        throw new IpfsBlockedError(`CID is blocked: ${normalizedCid}`);
      }

      // Pre-serve block for CIDs previously found to carry hash-blocked bytes
      // (see knownHashBlockedCids). Covers full and range requests, cached or
      // not, without re-fetching.
      if (this.knownHashBlockedCids.has(normalizedCid)) {
        metrics.ipfsBlockedTotal.inc();
        span.setAttribute('ipfs.blocked', true);
        throw new IpfsBlockedError(`Content hash is blocked: ${normalizedCid}`);
      }

      // Reject path traversal attempts
      if (path !== undefined && (path.includes('..') || path.startsWith('/'))) {
        throw new IpfsNotFoundError('Invalid IPFS path');
      }

      // Range requests bypass the positive read cache below, so also honor a
      // block-by-hash here using the cached digest (available once the object
      // has been cached). Without this, a `Range: bytes=0-` request could serve
      // hash-blocked bytes that a full GET refuses.
      if (range !== undefined) {
        const cachedDigest = await this.cache.getDigest(normalizedCid, path);
        if (
          cachedDigest !== undefined &&
          (await this.blockListValidator.isHashBlocked(cachedDigest))
        ) {
          metrics.ipfsBlockedTotal.inc();
          span.setAttribute('ipfs.blocked', true);
          span.end();
          throw new IpfsBlockedError(`Content hash is blocked: ${normalizedCid}`);
        }
      }

      // Negative cache: short-circuit CIDs we've repeatedly failed to fetch
      // (absent or unpinned) so they don't re-hit Kubo on every request
      // (latency / DoS amplification) — mirrors the Arweave path's negative data
      // cache. Only trips after repeated misses (count + duration thresholds).
      if (this.negativeCache?.isNegativelyCached(normalizedCid) === true) {
        span.setAttribute('ipfs.negative_cache', 'hit');
        span.end();
        throw new IpfsNotFoundError(
          `CID not found (negatively cached): ${normalizedCid}`,
        );
      }

      // Check cache. Range requests bypass the positive cache: we don't serve a
      // partial from a full cached object here, and we must never cache a
      // partial body — they're forwarded straight to Kubo (which supports Range)
      // below.
      const cached =
        range === undefined ? await this.cache.get(normalizedCid, path) : null;
      if (cached) {
        // Content-hash moderation. The cache stores the base64url SHA-256 of the
        // served bytes (the same format as Arweave's data hash), so once content
        // is cached we honor a block-by-hash entry too — matching the Arweave
        // path's isHashBlocked enforcement — not just block-by-CID. This catches
        // the same bytes blocked under an Arweave id or another identifier.
        if (
          cached.digest !== undefined &&
          (await this.blockListValidator.isHashBlocked(cached.digest))
        ) {
          cached.stream.destroy();
          metrics.ipfsBlockedTotal.inc();
          span.setAttribute('ipfs.blocked', true);
          span.end();
          throw new IpfsBlockedError(`Content hash is blocked: ${normalizedCid}`);
        }
        // Content is available — clear any negative-cache entry and record a
        // success so a transiently-unavailable CID that later pins isn't kept in
        // a negative-cache blackout, and IPFS health isn't skewed miss-only.
        this.negativeCache?.evict(normalizedCid);
        this.negativeCache?.recordSuccess();
        this.log.debug('IPFS cache hit', { cid: normalizedCid, path });
        metrics.ipfsCacheHitTotal.inc();
        span.setAttributes({
          'ipfs.cache': 'hit',
          'ipfs.size': cached.size,
        });
        span.end();
        return {
          stream: cached.stream,
          size: cached.size,
          contentType: cached.contentType,
          cached: true,
          digest: cached.digest,
          statusCode: 200,
        };
      }

      metrics.ipfsCacheMissTotal.inc();
      span.setAttribute('ipfs.cache', 'miss');

      // Fetch from Kubo. Record absent/unpinned CIDs in the negative cache so
      // repeat requests short-circuit above instead of re-hitting Kubo.
      const result = await this.dataSource
        .getContent({
          cidString: normalizedCid,
          path,
          signal,
          parentSpan: span,
          range,
        })
        .catch((err) => {
          if (err instanceof IpfsNotFoundError) {
            this.negativeCache?.recordMiss(normalizedCid);
          }
          throw err;
        });

      span.setAttributes({
        'ipfs.size': result.size,
        'ipfs.content_type': result.contentType,
      });

      // Enforce size limit when Content-Length is known
      if (
        this.maxResponseSizeBytes > 0 &&
        result.size > 0 &&
        result.size > this.maxResponseSizeBytes
      ) {
        result.stream.destroy();
        throw new IpfsSizeLimitError(
          `IPFS content size ${result.size} exceeds limit ${this.maxResponseSizeBytes}`,
        );
      }

      // A successful fetch means the content is available — clear any
      // negative-cache entry and record health (see the cache-hit path).
      this.negativeCache?.evict(normalizedCid);
      this.negativeCache?.recordSuccess();

      // Stream directly to the client while writing to a temp file on disk for
      // caching. No memory buffering — handles files of any size. Partial (206)
      // responses are NOT cached — only full objects.
      if (range === undefined && result.statusCode === 200) {
        this.streamToCache(
          normalizedCid,
          path,
          result.stream,
          result.contentType,
        );
      }

      // End span when stream completes
      result.stream.on('end', () => span.end());
      result.stream.on('error', (err) => {
        span.recordException(err);
        span.end();
      });

      return {
        stream: result.stream,
        size: result.size,
        contentType: result.contentType,
        cached: false,
        statusCode: result.statusCode,
        contentRange: result.contentRange,
      };
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
  }

  /** Remember a CID whose bytes are hash-blocked (bounded, FIFO-evicted). */
  private rememberHashBlocked(cidString: string): void {
    if (this.knownHashBlockedCids.has(cidString)) return;
    if (this.knownHashBlockedCids.size >= IpfsService.MAX_KNOWN_HASH_BLOCKED) {
      const oldest = this.knownHashBlockedCids.values().next().value;
      if (oldest !== undefined) this.knownHashBlockedCids.delete(oldest);
    }
    this.knownHashBlockedCids.add(cidString);
  }

  /**
   * Writes stream data to a temp cache file as it flows to the client.
   * Non-blocking — errors are logged but don't affect the response.
   * Buffers early chunks in memory until the write stream is ready,
   * then flushes them to disk.
   */
  private streamToCache(
    cidString: string,
    path: string | undefined,
    stream: Readable,
    contentType: string,
  ): void {
    const tempPath = `${this.cache.getCachePath()}/tmp/${crypto
      .randomBytes(16)
      .toString('hex')}`;
    let bytesWritten = 0;
    let failed = false;
    let finalized = false;
    // Hash the bytes as they're written so cache hits can emit an RFC 9530
    // Content-Digest (body binding) without a re-read.
    const hash = crypto.createHash('sha256');

    // Create the write stream synchronously. The temp directory is created
    // eagerly in the IpfsFsCache constructor, so there is no async mkdir to
    // race against the stream's 'end' event. (A previous async-mkdir version
    // dropped the cache entry whenever a small/fast response ended before the
    // mkdir resolved — leaving writeStream null — so small objects never
    // cached.) createWriteStream opens the fd lazily and buffers writes until
    // it is ready, so synchronous creation is safe.
    let writeStream: fs.WriteStream;
    try {
      writeStream = fs.createWriteStream(tempPath);
    } catch (error: any) {
      this.log.error('Failed to open IPFS cache write stream', {
        cid: cidString,
        message: error.message,
      });
      return;
    }

    const cleanup = () => {
      writeStream.destroy();
      fs.promises.unlink(tempPath).catch(() => {});
    };

    writeStream.on('error', (error) => {
      failed = true;
      this.log.error('Cache write stream error', {
        cid: cidString,
        message: error.message,
      });
      cleanup();
    });

    stream.on('data', (chunk: Buffer) => {
      if (failed) return;
      bytesWritten += chunk.length;

      // Enforce size limit during streaming (catches chunked responses
      // that lack Content-Length)
      if (
        this.maxResponseSizeBytes > 0 &&
        bytesWritten > this.maxResponseSizeBytes
      ) {
        failed = true;
        stream.destroy(
          new IpfsSizeLimitError(
            `IPFS content exceeds limit during streaming: ${bytesWritten} > ${this.maxResponseSizeBytes}`,
          ),
        );
        cleanup();
        return;
      }

      hash.update(chunk);
      writeStream.write(chunk);
    });

    stream.on('end', () => {
      if (failed) {
        cleanup();
        return;
      }
      finalized = true;
      const digest = hash.digest('base64url');
      writeStream.end(() => {
        void (async () => {
          // Don't persist content whose served bytes are blocked-by-hash — the
          // digest is only known now, at end of stream. Mirrors the Arweave path
          // refusing to cache blocked content, and prevents a subsequent request
          // from serving the blocked bytes out of cache.
          try {
            if (await this.blockListValidator.isHashBlocked(digest)) {
              this.rememberHashBlocked(cidString);
              this.log.info('Refusing to cache hash-blocked IPFS content', {
                cid: cidString,
                path,
              });
              cleanup();
              return;
            }
          } catch {
            // If the block check itself fails, fall through and cache as before.
          }
          // Finalize: move temp file into cache
          this.cache
            .putFromFile(
              cidString,
              tempPath,
              bytesWritten,
              contentType,
              path,
              digest,
            )
            .catch((error) => {
              this.log.error('Failed to finalize IPFS cache entry', {
                cid: cidString,
                path,
                message: error.message,
              });
              cleanup();
            });
        })();
      });
    });

    stream.on('error', () => {
      failed = true;
      cleanup();
    });

    // Premature close without 'end'/'error' — e.g. a HEAD request destroys the
    // stream after reading headers, or the client aborts mid-body. Node emits
    // 'close' (not 'error'/'end') on destroy(), so without this the write stream
    // and temp file leak (fd/disk exhaustion under repeated HEADs).
    stream.on('close', () => {
      if (!failed && !finalized) {
        cleanup();
      }
    });
  }
}
