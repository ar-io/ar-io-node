/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import { Readable } from 'node:stream';
import winston from 'winston';
import { Span } from '@opentelemetry/api';

import { attachStallTimeout } from '../lib/stream.js';
import { startChildSpan } from '../tracing.js';

export interface IpfsContentResult {
  stream: Readable;
  size: number;
  contentType: string;
  // 200 for a full response, 206 for a partial (Range) response.
  statusCode: number;
  // Present on 206 responses: the upstream Content-Range header value.
  contentRange?: string;
}

export class KuboDataSource {
  private log: winston.Logger;
  private kuboUrl: string;
  private requestTimeoutMs: number;
  private streamStallTimeoutMs: number;
  private maxConcurrent: number;
  private maxRequestMs: number;
  private inFlight = 0;

  constructor({
    log,
    kuboUrl,
    requestTimeoutMs,
    streamStallTimeoutMs,
    maxConcurrent = 0,
    maxRequestMs = 0,
  }: {
    log: winston.Logger;
    kuboUrl: string;
    requestTimeoutMs: number;
    streamStallTimeoutMs: number;
    maxConcurrent?: number;
    maxRequestMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kuboUrl = kuboUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxRequestMs = maxRequestMs;
  }

  async getContent({
    cidString,
    path,
    signal,
    parentSpan,
    range,
    format,
  }: {
    cidString: string;
    path?: string;
    signal?: AbortSignal;
    parentSpan?: Span;
    range?: string;
    // Trustless response format passed through to Kubo: a single verifiable
    // block (`raw`) or a verifiable DAG archive (`car`). Absent = UnixFS proxy.
    format?: 'raw' | 'car';
  }): Promise<IpfsContentResult> {
    signal?.throwIfAborted();

    // Concurrency cap: bound in-flight Kubo fetches so cheap-to-issue requests
    // (HEAD, tiny Range) can't amplify into unbounded upstream/DHT load — excess
    // requests fail fast instead of piling onto Kubo. The slot is released when
    // the returned stream closes (below) or on any error (catch).
    if (this.maxConcurrent > 0 && this.inFlight >= this.maxConcurrent) {
      throw new IpfsUnavailableError(
        `Too many concurrent IPFS fetches (${this.inFlight}/${this.maxConcurrent})`,
      );
    }
    this.inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };

    // URL-encode path segments to prevent breaking the upstream request
    const encodedPath =
      path !== undefined && path !== ''
        ? path
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/')
        : undefined;
    const ipfsPath =
      encodedPath !== undefined ? `${cidString}/${encodedPath}` : cidString;
    const url = `${this.kuboUrl}/ipfs/${ipfsPath}${
      format !== undefined ? `?format=${format}` : ''
    }`;

    const span = startChildSpan(
      'KuboDataSource.getContent',
      {
        attributes: {
          'ipfs.cid': cidString,
          'ipfs.path': path ?? '',
          'ipfs.url': url,
        },
      },
      parentSpan,
    );

    this.log.debug('Fetching IPFS content from Kubo', {
      cidString,
      path,
      url,
    });

    // Connection-phase timeout
    const controller = new AbortController();
    const connectionTimer = setTimeout(() => {
      controller.abort(new Error('Kubo connection timeout'));
    }, this.requestTimeoutMs);

    // Forward client abort to our controller
    const onClientAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onClientAbort();
    } else if (signal) {
      signal.addEventListener('abort', onClientAbort, { once: true });
    }

    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        signal: controller.signal,
        headers: {
          'Accept-Encoding': 'identity',
          // Forward a client Range to Kubo (its gateway supports Range and
          // returns 206 + Content-Range). Enables media seeking and the
          // observer's ranged sampling of large content.
          ...(range !== undefined ? { Range: range } : {}),
          // Trustless retrieval: ask Kubo for a raw block or CAR by IPLD media
          // type (belt-and-suspenders with the ?format= query above).
          ...(format !== undefined
            ? { Accept: `application/vnd.ipld.${format}` }
            : {}),
        },
        maxRedirects: 5,
        // Accept non-2xx so we can handle 404/408/504 ourselves
        validateStatus: (status) => status < 500 || status === 504,
      });

      clearTimeout(connectionTimer);
      signal?.removeEventListener('abort', onClientAbort);

      if (response.status === 404) {
        (response.data as Readable).destroy();
        throw new IpfsNotFoundError(
          `IPFS content not found: /ipfs/${ipfsPath}`,
        );
      }

      if (response.status === 408 || response.status === 504) {
        (response.data as Readable).destroy();
        throw new IpfsTimeoutError(
          `Kubo timed out resolving: /ipfs/${ipfsPath}`,
        );
      }

      if (response.status === 416) {
        (response.data as Readable).destroy();
        throw new IpfsRangeNotSatisfiableError(
          `Range not satisfiable for /ipfs/${ipfsPath}`,
        );
      }

      if (response.status !== 200 && response.status !== 206) {
        const stream = response.data as Readable;
        stream.destroy();
        throw new Error(
          `Unexpected Kubo response status: ${response.status} for /ipfs/${ipfsPath}`,
        );
      }

      const stream = response.data as Readable;
      const rawContentLength = parseInt(
        response.headers['content-length'] ?? '0',
        10,
      );
      const contentLength = Number.isFinite(rawContentLength)
        ? rawContentLength
        : 0;
      const contentType =
        response.headers['content-type'] ?? 'application/octet-stream';

      // Switch from connection timeout to stall timeout
      attachStallTimeout(stream, this.streamStallTimeoutMs, this.maxRequestMs);

      span.setAttributes({
        'ipfs.content_length': contentLength,
        'ipfs.content_type': contentType,
      });
      span.addEvent('Kubo fetch successful');

      this.log.debug('Kubo fetch successful', {
        cidString,
        path,
        contentLength,
        contentType,
      });

      // End span when stream finishes or errors
      stream.on('end', () => span.end());
      stream.on('error', (err) => {
        span.recordException(err);
        span.end();
      });

      // Release the concurrency slot when the response stream is fully consumed
      // or destroyed (covers success, client abort, and downstream errors).
      stream.once('close', release);

      return {
        stream,
        size: contentLength,
        contentType,
        statusCode: response.status,
        contentRange: response.headers['content-range'],
      };
    } catch (error: any) {
      release();
      clearTimeout(connectionTimer);
      signal?.removeEventListener('abort', onClientAbort);
      // axios rejects for 5xx (validateStatus accepts <500 or 504). With
      // responseType 'stream', error.response.data is an open Readable — destroy
      // it so the socket/fd isn't leaked while Kubo returns 500/502/503.
      const errStream = error?.response?.data;
      if (errStream !== undefined && typeof errStream.destroy === 'function') {
        errStream.destroy();
      }

      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();

      if (error instanceof IpfsNotFoundError) throw error;
      if (error instanceof IpfsTimeoutError) throw error;
      if (error instanceof IpfsRangeNotSatisfiableError) throw error;

      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        if (signal?.aborted) {
          throw error; // Client disconnected
        }
        throw new IpfsTimeoutError(
          `Kubo request timed out for /ipfs/${ipfsPath}`,
        );
      }

      if (error.code === 'ECONNREFUSED') {
        throw new IpfsUnavailableError(
          `Kubo service unavailable at ${this.kuboUrl}`,
        );
      }

      this.log.error('Failed to fetch from Kubo', {
        cidString,
        path,
        message: error.message,
      });
      throw error;
    }
  }
}

export class IpfsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsNotFoundError';
  }
}

export class IpfsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsTimeoutError';
  }
}

export class IpfsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsUnavailableError';
  }
}

export class IpfsBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsBlockedError';
  }
}

export class IpfsRangeNotSatisfiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsRangeNotSatisfiableError';
  }
}

export class IpfsSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsSizeLimitError';
  }
}
