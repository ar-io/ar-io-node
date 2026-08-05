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

// Kubo RPC error text for an offline (local-only) read that misses the local
// blockstore. Confirmed against ipfs/kubo:v0.32.1 (§3.1a spike): block/get,
// dag/export, and cat all return HTTP 500 with a body of the form
// `{"Message":"block was not found locally (offline): ipld: could not find
// <cid>", ...}` when the content isn't held locally. We map exactly this to
// IpfsNotFoundError; any other non-200 stays an error so a real Kubo fault
// isn't masked as a benign miss.
const OFFLINE_MISS_RE =
  /not found locally|could not find|not found|key not found/i;

interface GetContentOptions {
  cidString: string;
  path?: string;
  signal?: AbortSignal;
  parentSpan?: Span;
  range?: string;
  // Trustless response format passed through to Kubo: a single verifiable
  // block (`raw`) or a verifiable DAG archive (`car`). Absent = UnixFS proxy.
  format?: 'raw' | 'car';
  // Serve ONLY from the local Kubo blockstore/pinset — never touch public
  // IPFS/DHT. Routed through the Kubo RPC API with `offline=true`; a local miss
  // returns fast as IpfsNotFoundError. This is the load-bearing primitive for
  // peer-fetch recursion prevention and trustless holding measurement.
  localOnly?: boolean;
}

export class KuboDataSource {
  private log: winston.Logger;
  private kuboUrl: string;
  // Kubo RPC API base (:5001). Required only for local-only (offline) reads; the
  // read-only gateway (:8080) has no per-request offline flag.
  private kuboApiUrl?: string;
  private requestTimeoutMs: number;
  private streamStallTimeoutMs: number;
  private maxConcurrent: number;
  private maxRequestMs: number;
  private inFlight = 0;

  constructor({
    log,
    kuboUrl,
    kuboApiUrl,
    requestTimeoutMs,
    streamStallTimeoutMs,
    maxConcurrent = 0,
    maxRequestMs = 0,
  }: {
    log: winston.Logger;
    kuboUrl: string;
    kuboApiUrl?: string;
    requestTimeoutMs: number;
    streamStallTimeoutMs: number;
    maxConcurrent?: number;
    maxRequestMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.kuboUrl = kuboUrl.replace(/\/$/, '');
    this.kuboApiUrl = kuboApiUrl?.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxRequestMs = maxRequestMs;
  }

  async getContent(opts: GetContentOptions): Promise<IpfsContentResult> {
    opts.signal?.throwIfAborted();

    // Concurrency cap: bound in-flight Kubo fetches so cheap-to-issue requests
    // (HEAD, tiny Range) can't amplify into unbounded upstream/DHT load — excess
    // requests fail fast instead of piling onto Kubo. The slot is released when
    // the returned stream closes (via finalizeStream) or on any error (below).
    const release = this.acquireSlot();

    const span = startChildSpan(
      'KuboDataSource.getContent',
      {
        attributes: {
          'ipfs.cid': opts.cidString,
          'ipfs.path': opts.path ?? '',
          'ipfs.local_only': opts.localOnly === true,
        },
      },
      opts.parentSpan,
    );

    try {
      return opts.localOnly === true
        ? await this.getContentOffline(opts, span, release)
        : await this.getContentFromGateway(opts, span, release);
    } catch (error: any) {
      // The branch methods map upstream errors but leave slot/span teardown to
      // here so success (stream lifecycle) and failure share one owner. release
      // is idempotent, so this is safe even if a branch already released.
      release();
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
  }

  // Reserve a concurrency slot; returns an idempotent release fn.
  private acquireSlot(): () => void {
    if (this.maxConcurrent > 0 && this.inFlight >= this.maxConcurrent) {
      throw new IpfsUnavailableError(
        `Too many concurrent IPFS fetches (${this.inFlight}/${this.maxConcurrent})`,
      );
    }
    this.inFlight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };
  }

  // Wire a successfully-opened upstream stream into an IpfsContentResult:
  // switch to the stall timeout, end the span exactly once, and release the
  // concurrency slot when the stream terminates ('close' covers the
  // destroy()-without-error paths — HEAD, client abort, rate-limited teardown —
  // that emit only 'close', not 'end'/'error').
  private finalizeStream(
    stream: Readable,
    meta: {
      contentLength: number;
      contentType: string;
      statusCode: number;
      contentRange?: string;
    },
    release: () => void,
    span: Span,
    logContext: Record<string, unknown>,
  ): IpfsContentResult {
    attachStallTimeout(stream, this.streamStallTimeoutMs, this.maxRequestMs);

    span.setAttributes({
      'ipfs.content_length': meta.contentLength,
      'ipfs.content_type': meta.contentType,
    });
    span.addEvent('Kubo fetch successful');
    this.log.debug('Kubo fetch successful', {
      ...logContext,
      contentLength: meta.contentLength,
      contentType: meta.contentType,
    });

    let spanEnded = false;
    const endSpan = () => {
      if (spanEnded) return;
      spanEnded = true;
      span.end();
    };
    stream.on('end', endSpan);
    stream.on('error', (err) => {
      span.recordException(err);
      endSpan();
    });
    stream.once('close', () => {
      endSpan();
      release();
    });

    return {
      stream,
      size: meta.contentLength,
      contentType: meta.contentType,
      statusCode: meta.statusCode,
      contentRange: meta.contentRange,
    };
  }

  // Connection-phase timeout + client-abort plumbing shared by both fetch
  // paths. Returns the AbortController to pass to axios and a `detach` that
  // clears the timer and removes the client-abort listener (call on both
  // success and error).
  private setupAbort(signal?: AbortSignal): {
    controller: AbortController;
    detach: () => void;
  } {
    const controller = new AbortController();
    const connectionTimer = setTimeout(() => {
      controller.abort(new Error('Kubo connection timeout'));
    }, this.requestTimeoutMs);

    const onClientAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      onClientAbort();
    } else if (signal) {
      signal.addEventListener('abort', onClientAbort, { once: true });
    }

    return {
      controller,
      detach: () => {
        clearTimeout(connectionTimer);
        signal?.removeEventListener('abort', onClientAbort);
      },
    };
  }

  // Non-local-only path: fetch via the read-only Kubo gateway (:8080), which may
  // reach public IPFS/DHT. Behavior unchanged from the original implementation.
  private async getContentFromGateway(
    { cidString, path, signal, range, format }: GetContentOptions,
    span: Span,
    release: () => void,
  ): Promise<IpfsContentResult> {
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
    span.setAttribute('ipfs.url', url);

    this.log.debug('Fetching IPFS content from Kubo', { cidString, path, url });

    const { controller, detach } = this.setupAbort(signal);

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

      detach();

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

      return this.finalizeStream(
        stream,
        {
          contentLength,
          contentType,
          statusCode: response.status,
          contentRange: response.headers['content-range'],
        },
        release,
        span,
        { cidString, path },
      );
    } catch (error: any) {
      detach();
      // axios rejects for 5xx (validateStatus accepts <500 or 504). With
      // responseType 'stream', error.response.data is an open Readable — destroy
      // it so the socket/fd isn't leaked while Kubo returns 500/502/503.
      const errStream = error?.response?.data;
      if (errStream !== undefined && typeof errStream.destroy === 'function') {
        errStream.destroy();
      }

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

  // Local-only path: serve strictly from the local blockstore via the Kubo RPC
  // API with `offline=true`, so a request NEVER triggers a public-IPFS/DHT walk.
  //   raw  -> block/get  (single verifiable block)
  //   car  -> dag/export (verifiable DAG archive of the root)
  //   none -> cat        (UnixFS bytes; offline cat also fails unless the WHOLE
  //                       file's blocks are local — a free "holds the whole
  //                       thing", not just the root, signal)
  // A local miss returns fast (HTTP 500 with an "offline"/"not found locally"
  // body) and is mapped to IpfsNotFoundError. Range is intentionally not honored
  // here (the caller nulls it out under local-only); none of the local-only
  // consumers (observer raw probe, peer CAR fetch) use Range.
  private async getContentOffline(
    { cidString, path, signal, format }: GetContentOptions,
    span: Span,
    release: () => void,
  ): Promise<IpfsContentResult> {
    if (this.kuboApiUrl === undefined) {
      throw new IpfsUnavailableError(
        'Kubo RPC API URL is not configured; local-only fetch requires IPFS_KUBO_API_URL',
      );
    }

    let endpoint: string;
    let contentType: string;
    let arg = cidString;
    if (format === 'raw') {
      endpoint = 'block/get';
      contentType = 'application/vnd.ipld.raw';
    } else if (format === 'car') {
      endpoint = 'dag/export';
      contentType = 'application/vnd.ipld.car';
    } else {
      endpoint = 'cat';
      // cat is the only offline endpoint that resolves a sub-path within the DAG.
      if (path !== undefined && path !== '') {
        const encodedPath = path
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        arg = `${cidString}/${encodedPath}`;
      }
      // Content-Type is not derivable from the RPC cat response; default to a
      // safe binary type. Cache hits (served earlier in IpfsService) carry the
      // correct type, and the load-bearing raw/car paths set it explicitly.
      contentType = 'application/octet-stream';
    }

    const url = `${this.kuboApiUrl}/api/v0/${endpoint}`;
    span.setAttribute('ipfs.url', `${url}?arg=${arg}&offline=true`);

    this.log.debug('Fetching IPFS content from Kubo (local-only)', {
      cidString,
      path,
      endpoint,
    });

    const { controller, detach } = this.setupAbort(signal);

    try {
      const response = await axios.post(url, undefined, {
        params: { arg, offline: true },
        responseType: 'stream',
        signal: controller.signal,
        headers: { 'Accept-Encoding': 'identity' },
        maxRedirects: 0,
        // Inspect every status ourselves: an offline miss is a 500 we must
        // translate to a fast IpfsNotFoundError rather than let axios reject.
        validateStatus: () => true,
      });

      detach();

      if (response.status !== 200) {
        // Drain the (small) error body to classify it and avoid leaking the fd.
        const body = await collectStream(response.data as Readable, 8192);
        if (OFFLINE_MISS_RE.test(body)) {
          throw new IpfsNotFoundError(
            `IPFS content not held locally: /ipfs/${arg}`,
          );
        }
        throw new IpfsUnavailableError(
          `Unexpected Kubo RPC status ${response.status} for offline /ipfs/${arg}: ${body.slice(0, 200)}`,
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

      return this.finalizeStream(
        stream,
        { contentLength, contentType, statusCode: 200 },
        release,
        span,
        { cidString, path, localOnly: true },
      );
    } catch (error: any) {
      detach();
      const errStream = error?.response?.data;
      if (errStream !== undefined && typeof errStream.destroy === 'function') {
        errStream.destroy();
      }

      if (error instanceof IpfsNotFoundError) throw error;
      if (error instanceof IpfsUnavailableError) throw error;

      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        if (signal?.aborted) {
          throw error; // Client disconnected
        }
        throw new IpfsTimeoutError(
          `Kubo RPC timed out for offline /ipfs/${arg}`,
        );
      }

      if (error.code === 'ECONNREFUSED') {
        throw new IpfsUnavailableError(
          `Kubo RPC unavailable at ${this.kuboApiUrl}`,
        );
      }

      this.log.error('Failed to fetch from Kubo (local-only)', {
        cidString,
        path,
        message: error.message,
      });
      throw error;
    }
  }
}

// Read a Readable to a UTF-8 string, capped at maxBytes (destroys the stream
// once the cap is reached). Used to classify small Kubo RPC error bodies.
async function collectStream(
  stream: Readable,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) {
        stream.destroy();
        break;
      }
    }
  } catch {
    // A read error while draining the error body is non-fatal — return what we
    // have so the caller can still classify it.
  }
  return Buffer.concat(chunks).toString('utf8');
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
