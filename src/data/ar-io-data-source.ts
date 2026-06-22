/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosResponse } from 'axios';
import winston from 'winston';
import {
  ArIOPeerManager,
  PeerSuccessMetrics,
} from '../peers/ar-io-peer-manager.js';

import {
  ContiguousData,
  ContiguousDataSource,
  ContiguousDataAttributesStore,
  Region,
  RequestAttributes,
} from '../types.js';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
  parseUpstreamTagHeaders,
  validateHopCount,
} from '../lib/request-attributes.js';
import { headerNames } from '../constants.js';
import { startChildSpan } from '../tracing.js';
import { SpanStatusCode, Span } from '@opentelemetry/api';
import { normalizeAbortError, parseContentRange } from '../lib/http-utils.js';
import { ByteRangeTransform, attachStallTimeout } from '../lib/stream.js';
import { PeerRequestLimiter } from './peer-request-limiter.js';
import { executeHedgedRequest } from '../lib/hedged-request.js';

import * as metrics from '../metrics.js';
import * as config from '../config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_DATA_HOPS = 3;
const DATA_CATEGORY = 'data';

export class ArIODataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private streamStallTimeoutMs: number;
  private streamRequestTimeoutMs: number;
  private peerManager: ArIOPeerManager;
  private dataAttributesStore: ContiguousDataAttributesStore;
  private peerRequestLimiter?: PeerRequestLimiter;
  peers: Record<string, string> = {};

  constructor({
    log,
    peerManager,
    dataAttributesStore,
    peerRequestLimiter,
    maxHopsAllowed = MAX_DATA_HOPS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    streamStallTimeoutMs = config.STREAM_STALL_TIMEOUT_MS,
    streamRequestTimeoutMs = config.STREAM_REQUEST_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    peerManager: ArIOPeerManager;
    dataAttributesStore: ContiguousDataAttributesStore;
    peerRequestLimiter?: PeerRequestLimiter;
    maxHopsAllowed?: number;
    requestTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    streamRequestTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.maxHopsAllowed = maxHopsAllowed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
    this.streamRequestTimeoutMs = streamRequestTimeoutMs;
    this.peerManager = peerManager;
    this.dataAttributesStore = dataAttributesStore;
    this.peerRequestLimiter = peerRequestLimiter;
    this.peers = peerManager.getPeers();
  }

  handlePeerSuccess(
    peer: string,
    kbps: number,
    ttfb: number,
    requestType: string,
  ): void {
    metrics.getDataStreamSuccessesTotal.inc({
      class: this.constructor.name,
      source: peer,
      request_type: requestType,
    });

    const successMetrics: PeerSuccessMetrics = {
      kbps,
      ttfb,
    };

    this.peerManager.reportSuccess(DATA_CATEGORY, peer, successMetrics);
  }

  handlePeerFailure(peer: string, requestType: string): void {
    metrics.getDataStreamErrorsTotal.inc({
      class: this.constructor.name,
      source: peer,
      request_type: requestType,
    });

    this.peerManager.reportFailure(DATA_CATEGORY, peer);
  }

  private async request({
    peerAddress,
    id,
    headers,
    requestAttributesHeaders,
    signal,
    region,
  }: {
    peerAddress: string;
    id: string;
    headers: { [key: string]: string };
    requestAttributesHeaders?: ReturnType<typeof generateRequestAttributes>;
    signal?: AbortSignal;
    region?: Region;
  }): Promise<AxiosResponse> {
    const path = `/raw/${id}`;

    // Connection phase: use AbortController with wall-clock timeout for
    // establishing the connection, then switch to stall-based timeout once
    // the stream starts flowing.
    const controller = new AbortController();
    const connectionTimer = setTimeout(
      () => controller.abort(new Error('Connection timeout')),
      this.requestTimeoutMs,
    );
    const onClientAbort = () => {
      // INSTRUMENTATION (2026-05-17): trace abort-path propagation. If
      // `optB.hedge_aborted` fires but this doesn't, AbortSignal.any
      // isn't propagating the parent abort to per-peer attempts.
      this.log.info('optB.peer_aborted', {
        peer: peerAddress,
        id,
        reason: (signal as any)?.reason?.message,
      });
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) {
      onClientAbort();
    } else if (signal) {
      signal.addEventListener('abort', onClientAbort, { once: true });
    }

    try {
      const response = await axios.get(`${peerAddress}${path}`, {
        headers: {
          'Accept-Encoding': 'identity',
          'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
          ...headers,
        },
        responseType: 'stream',
        signal: controller.signal,
        params: {
          'ar-io-hops': requestAttributesHeaders?.attributes.hops,
          'ar-io-origin': requestAttributesHeaders?.attributes.origin,
          'ar-io-origin-release':
            requestAttributesHeaders?.attributes.originNodeRelease,
          'ar-io-arns-record': requestAttributesHeaders?.attributes.arnsRecord,
          'ar-io-arns-basename':
            requestAttributesHeaders?.attributes.arnsBasename,
          'ar-io-via': requestAttributesHeaders?.attributes.via?.join(', '),
        },
      });

      // Connection established - clear connection timeout and switch to
      // stall-based timeout for the streaming phase
      clearTimeout(connectionTimer);
      if (signal) {
        signal.removeEventListener('abort', onClientAbort);
      }

      // PE-9081: enforce 206-when-Range parity with GatewaysDataSource.
      if (
        (region !== undefined && response.status !== 206) ||
        (region === undefined && response.status !== 200)
      ) {
        response.data.destroy();
        throw new Error(
          `Unexpected status code from peer: ${response.status}. Expected ${
            region !== undefined ? '206' : '200'
          }.`,
        );
      }

      attachStallTimeout(
        response.data,
        this.streamStallTimeoutMs,
        this.streamRequestTimeoutMs,
      );

      return response;
    } catch (rawError) {
      clearTimeout(connectionTimer);
      if (signal) {
        signal.removeEventListener('abort', onClientAbort);
      }
      throw normalizeAbortError(rawError);
    }
  }

  async getData({
    id,
    requestAttributes,
    region,
    retryCount,
    parentSpan,
    signal,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    retryCount?: number;
    parentSpan?: Span;
    signal?: AbortSignal;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'ArIODataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.region.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
          'ario.config.max_hops_allowed': this.maxHopsAllowed,
          'ario.config.request_timeout_ms': this.requestTimeoutMs,
        },
      },
      parentSpan,
    );

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      // Skip remote forwarding for compute-origin requests to prevent loops
      if (requestAttributes?.skipRemoteForwarding) {
        throw new Error('Remote forwarding skipped for compute-origin request');
      }

      const log = this.log.child({ method: 'getData' });
      const candidateCount = Math.max(
        1,
        retryCount ?? config.PEER_CANDIDATE_COUNT,
      );

      span.setAttributes({
        'ario.request.candidate_count': candidateCount,
        'ario.peers.available_count': Object.keys(this.peerManager.getPeers())
          .length,
      });

      log.debug('Fetching contiguous data from ArIO peer', {
        id,
        candidateCount,
      });

      if (requestAttributes !== undefined) {
        validateHopCount(requestAttributes.hops, this.maxHopsAllowed);
        span.setAttribute('ario.request.hops', requestAttributes.hops);
      }

      const randomPeers = this.peerManager.selectPeersForKey(
        DATA_CATEGORY,
        id,
        candidateCount,
      );
      span.addEvent('Selected peers for request');

      const requestAttributesHeaders =
        generateRequestAttributes(requestAttributes);

      // Get data attributes if available
      const dataAttributes =
        await this.dataAttributesStore.getDataAttributes(id);

      // Track how many limiter slots per peer are held by live streams rather
      // than the request promise, so onRelease can skip them. A count (not a
      // Set) is required because concurrent hedged requests to the same peer
      // each hold an independent slot.
      const streamPeerCounts = new Map<string, number>();

      const result = await executeHedgedRequest<ContiguousData>({
        candidates: randomPeers,
        execute: async (peer, hedgeSignal) => {
          const requestStartTime = Date.now();

          span.addEvent('Attempting peer request', {
            'ario.peer.url': peer,
          });

          try {
            const response = await this.request({
              peerAddress: peer,
              id,
              headers: {
                ...(requestAttributesHeaders?.headers || {}),
                ...(dataAttributes?.hash !== undefined
                  ? {
                      [headerNames.expectedDigest]: dataAttributes.hash,
                    }
                  : {}),
                ...(region
                  ? {
                      Range: `bytes=${region.offset}-${region.offset + region.size - 1}`,
                    }
                  : {}),
              },
              requestAttributesHeaders,
              signal: hedgeSignal,
              region,
            });
            const ttfb = Date.now() - requestStartTime;
            const peerRequestDuration = Date.now() - requestStartTime;

            span.setAttributes({
              'ario.peer.successful_url': peer,
              'ario.request.duration_ms': peerRequestDuration,
              'ario.request.ttfb_ms': ttfb,
              'http.status_code': response.status,
            });

            span.addEvent('Peer request successful', {
              'ario.peer.url': peer,
            });

            const parsedRequestAttributes = parseRequestAttributesHeaders({
              headers: response.headers as { [key: string]: string },
              currentHops: requestAttributesHeaders?.attributes.hops,
            });

            const contiguousData = this.parseResponse({
              response,
              requestAttributes: parsedRequestAttributes,
              requestStartTime,
              peer,
              ttfb,
              expectedHash: dataAttributes?.hash,
              region,
            });

            // Defer limiter release until the stream is fully consumed so the
            // slot accurately reflects active outbound transfers.
            //
            // Listen on 'end', 'error', AND 'close' rather than 'close' alone:
            // for HTTP IncomingMessage streams consumed via pipeline() under a
            // keepAlive http.Agent, 'close' can fire late or not at all (the
            // socket is returned to the pool without the response being
            // destroyed). That left limiter slots leaked permanently — after
            // ~30 min of activity every peer hit maxConcurrent, tryAcquire
            // returned false for all candidates, and getData() stopped
            // dispatching to any peer (download pipeline wedged with the
            // bundleDataImporter queue pegged at its cap, no errors logged).
            // 'end' is the canonical "data fully received" event and fires
            // reliably for normal completion; 'error' covers explicit
            // destroys (stall timeout, wall-clock cap, peer aborts).
            // released guard makes the handler idempotent so multiple events
            // do not double-release.
            streamPeerCounts.set(peer, (streamPeerCounts.get(peer) ?? 0) + 1);
            let released = false;
            const releaseSlot = () => {
              if (released) return;
              released = true;
              const count = streamPeerCounts.get(peer) ?? 1;
              if (count <= 1) {
                streamPeerCounts.delete(peer);
              } else {
                streamPeerCounts.set(peer, count - 1);
              }
              this.peerRequestLimiter?.release(peer);
            };
            contiguousData.stream.once('end', releaseSlot);
            contiguousData.stream.once('error', releaseSlot);
            contiguousData.stream.once('close', releaseSlot);

            return contiguousData;
          } catch (error: any) {
            span.addEvent('Peer request failed', {
              'ario.peer.url': peer,
              'ario.request.error': error.message,
            });

            // AbortErrors from hedging cancellations (loser requests) are
            // expected — don't inflate metrics or log as errors
            if (error.name !== 'AbortError') {
              metrics.getDataErrorsTotal.inc({
                class: this.constructor.name,
                source: peer,
              });
              log.error('Failed to fetch contiguous data from ArIO peer', {
                currentPeer: peer,
                message: error.message,
                stack: error.stack,
              });
              this.handlePeerFailure(peer, region ? 'range' : 'full');
            }
            throw error;
          }
        },
        acquire: (peer) => this.peerRequestLimiter?.tryAcquire(peer) ?? true,
        onRelease: (peer) => {
          // Skip release if stream took ownership of the slot
          if (!streamPeerCounts.has(peer)) {
            this.peerRequestLimiter?.release(peer);
          }
        },
        onLoserResult: (data) => {
          // Destroy the losing stream so it doesn't hold an open connection
          // and limiter slot indefinitely.
          data.stream.destroy();
        },
        hedgeDelayMs: config.PEER_HEDGE_DELAY_MS,
        maxConcurrent: config.PEER_MAX_HEDGED_REQUESTS,
        signal,
        log: this.log,
      });

      return result;
    } catch (error: any) {
      // Don't record AbortError as exception
      if (error.name !== 'AbortError') {
        // Wrap AggregateError from hedged requests with a clearer message
        const wrappedError =
          error instanceof AggregateError
            ? new Error('Failed to fetch contiguous data from ArIO peers')
            : error;
        span.recordException(wrappedError);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: wrappedError.message,
        });
        throw wrappedError;
      }
      throw error;
    } finally {
      span.end();
    }
  }

  private parseResponse({
    response,
    requestAttributes,
    requestStartTime,
    peer,
    ttfb,
    expectedHash,
    region,
  }: {
    response: AxiosResponse;
    requestAttributes: RequestAttributes;
    requestStartTime: number;
    peer: string;
    ttfb: number;
    expectedHash?: string;
    region?: Region;
  }): ContiguousData {
    const stream = response.data;

    // Check if peer's digest matches our expected hash
    if (expectedHash !== undefined) {
      const peerDigest = response.headers[headerNames.digest.toLowerCase()];
      if (peerDigest !== undefined && peerDigest !== expectedHash) {
        stream.destroy();
        this.log.warn('Peer digest does not match expected hash', {
          peer,
          expectedHash,
          peerDigest,
        });
        throw new Error('Peer digest does not match expected hash');
      }
    }

    // Check if peer indicates data is verified or trusted
    const peerVerified =
      response.headers[headerNames.verified.toLowerCase()] === 'true';
    const peerTrusted =
      response.headers[headerNames.trusted.toLowerCase()] === 'true';

    // Only accept data from peers that indicate it's either verified or trusted
    if (!peerVerified && !peerTrusted) {
      stream.destroy();
      throw new Error('Peer does not indicate data is verified or trusted');
    }

    const contentLength =
      parseInt(response.headers['content-length'] ?? '0') || 0;
    const requestType = region ? 'range' : 'full';

    // PE-9081: reject responses with missing or zero Content-Length —
    // mirrors the b9088671 fix in `GatewaysDataSource:319-324`. Without
    // this guard, a misbehaving peer could return headers that quietly
    // resolve to size=0 here while emitting an arbitrary number of body
    // bytes downstream.
    if (contentLength === 0) {
      stream.destroy();
      throw new Error(
        `Peer response has no content-length or zero content-length`,
      );
    }

    // PE-9081: when the consumer asked for a region, the peer's
    // Content-Length must match region.size exactly. Oversize is the
    // leak path; undersize (a truncated 206) is just as wrong because
    // we report `size: region.size` to downstream consumers — they
    // would observe a stream that claims to be region.size bytes but
    // delivers fewer, with no signal that the upstream truncated.
    // Both directions are the same defect from the consumer's view.
    if (region !== undefined && contentLength !== region.size) {
      stream.destroy();
      throw new Error(
        `Peer Content-Length (${contentLength}) does not match requested region size (${region.size})`,
      );
    }

    // PE-9081: defense-in-depth — wrap the body stream in a transform
    // that hard-caps emitted bytes at `region.size`, regardless of what
    // the upstream actually sends. ByteRangeTransform was already in
    // `src/lib/stream.ts` and is used by Turbo*DataSource for the same
    // purpose. We're acting as the consumer-of-the-region here, so we
    // pass offset=0 (the upstream already sliced) and size=region.size.
    const cappedStream =
      region !== undefined
        ? stream.pipe(new ByteRangeTransform(0, region.size))
        : stream;

    stream.on('error', (err: any) => {
      // Don't penalize peers that were canceled by hedging
      if (err?.name !== 'AbortError') {
        this.handlePeerFailure(peer, requestType);
      }
    });

    stream.on('end', () => {
      const downloadTimeSeconds = (Date.now() - requestStartTime) / 1000;
      const kbps = contentLength / downloadTimeSeconds / 1024;
      this.handlePeerSuccess(peer, kbps, ttfb, requestType);

      // Track bytes streamed
      metrics.getDataStreamBytesTotal.inc(
        {
          class: this.constructor.name,
          source: peer,
          request_type: requestType,
        },
        contentLength,
      );

      metrics.getDataStreamSizeHistogram.observe(
        {
          class: this.constructor.name,
          source: peer,
          request_type: requestType,
        },
        contentLength,
      );
    });

    // PE-9081: when the cap is in effect, ensure the upstream socket is
    // released on every cappedStream termination — natural end (consumer
    // read to completion), close (consumer destroyed early or unpipe),
    // and error. `pipe()` does not propagate destination-side
    // destruction back to the source, so without these the upstream
    // axios response can sit open after the limiter slot is already
    // released by the consumer-side close listener (per CodeRabbit
    // review on PR #703).
    if (region !== undefined && cappedStream !== stream) {
      const destroyUpstream = () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      };
      cappedStream.once('end', destroyUpstream);
      cappedStream.once('close', destroyUpstream);
      cappedStream.once('error', destroyUpstream);
    }

    return {
      stream: cappedStream,
      // When a region was requested, prefer the requested size over the
      // upstream-declared content length for downstream consumers — the
      // ByteRangeTransform guarantees that's what they'll actually see.
      size: region !== undefined ? region.size : contentLength,
      totalSize: parseContentRange(response.headers['content-range'])?.total,
      verified: false,
      trusted: false,
      sourceContentType: response.headers['content-type'],
      cached: false,
      requestAttributes,
      upstreamTags: parseUpstreamTagHeaders(
        response.headers as Record<string, string | string[]>,
      ),
    };
  }
}
