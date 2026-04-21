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
}

export class KuboDataSource {
  private log: winston.Logger;
  private kuboUrl: string;
  private requestTimeoutMs: number;
  private streamStallTimeoutMs: number;

  constructor({
    log,
    kuboUrl,
    requestTimeoutMs,
    streamStallTimeoutMs,
  }: {
    log: winston.Logger;
    kuboUrl: string;
    requestTimeoutMs: number;
    streamStallTimeoutMs: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kuboUrl = kuboUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
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
  }): Promise<IpfsContentResult> {
    signal?.throwIfAborted();

    const ipfsPath =
      path !== undefined && path !== '' ? `${cidString}/${path}` : cidString;
    const url = `${this.kuboUrl}/ipfs/${ipfsPath}`;

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
        },
        maxRedirects: 5,
        // Accept non-2xx so we can handle 404/408/504 ourselves
        validateStatus: (status) => status < 500 || status === 504,
      });

      clearTimeout(connectionTimer);
      signal?.removeEventListener('abort', onClientAbort);

      if (response.status === 404) {
        throw new IpfsNotFoundError(
          `IPFS content not found: /ipfs/${ipfsPath}`,
        );
      }

      if (response.status === 408 || response.status === 504) {
        throw new IpfsTimeoutError(
          `Kubo timed out resolving: /ipfs/${ipfsPath}`,
        );
      }

      if (response.status !== 200) {
        const stream = response.data as Readable;
        stream.destroy();
        throw new Error(
          `Unexpected Kubo response status: ${response.status} for /ipfs/${ipfsPath}`,
        );
      }

      const stream = response.data as Readable;
      const contentLength = parseInt(
        response.headers['content-length'] ?? '0',
        10,
      );
      const contentType =
        response.headers['content-type'] ?? 'application/octet-stream';

      // Switch from connection timeout to stall timeout
      attachStallTimeout(stream, this.streamStallTimeoutMs);

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

      return {
        stream,
        size: contentLength,
        contentType,
      };
    } catch (error: any) {
      clearTimeout(connectionTimer);
      signal?.removeEventListener('abort', onClientAbort);

      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();

      if (error instanceof IpfsNotFoundError) throw error;
      if (error instanceof IpfsTimeoutError) throw error;

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

export class IpfsSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsSizeLimitError';
  }
}
