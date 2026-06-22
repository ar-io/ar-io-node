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
}

export class IpfsService {
  private log: winston.Logger;
  private dataSource: KuboDataSource;
  private cache: IpfsFsCache;
  private blockListValidator: DataBlockListValidator;
  private maxResponseSizeBytes: number;

  constructor({
    log,
    dataSource,
    cache,
    blockListValidator,
    maxResponseSizeBytes,
  }: {
    log: winston.Logger;
    dataSource: KuboDataSource;
    cache: IpfsFsCache;
    blockListValidator: DataBlockListValidator;
    maxResponseSizeBytes: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSource = dataSource;
    this.cache = cache;
    this.blockListValidator = blockListValidator;
    this.maxResponseSizeBytes = maxResponseSizeBytes;
  }

  async getContent({
    cidString,
    path,
    signal,
    parentSpan,
  }: {
    cidString: string;
    path?: string;
    signal?: AbortSignal;
    parentSpan?: Span;
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

      // Reject path traversal attempts
      if (path !== undefined && (path.includes('..') || path.startsWith('/'))) {
        throw new IpfsNotFoundError('Invalid IPFS path');
      }

      // Check cache
      const cached = await this.cache.get(normalizedCid, path);
      if (cached) {
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
        };
      }

      metrics.ipfsCacheMissTotal.inc();
      span.setAttribute('ipfs.cache', 'miss');

      // Fetch from Kubo
      const result = await this.dataSource.getContent({
        cidString: normalizedCid,
        path,
        signal,
        parentSpan: span,
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

      // Stream directly to the client while writing to a temp file on disk
      // for caching. No memory buffering — handles files of any size.
      this.streamToCache(
        normalizedCid,
        path,
        result.stream,
        result.contentType,
      );

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
      };
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
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

      writeStream.write(chunk);
    });

    stream.on('end', () => {
      if (failed) {
        cleanup();
        return;
      }
      writeStream.end(() => {
        // Finalize: move temp file into cache
        this.cache
          .putFromFile(cidString, tempPath, bytesWritten, contentType, path)
          .catch((error) => {
            this.log.error('Failed to finalize IPFS cache entry', {
              cid: cidString,
              path,
              message: error.message,
            });
            cleanup();
          });
      });
    });

    stream.on('error', () => {
      failed = true;
      cleanup();
    });
  }
}
