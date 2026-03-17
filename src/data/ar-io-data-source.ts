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
  validateHopCount,
} from '../lib/request-attributes.js';
import { headerNames } from '../constants.js';
import { startChildSpan } from '../tracing.js';
import { SpanStatusCode, Span } from '@opentelemetry/api';
import { normalizeAbortError } from '../lib/http-utils.js';
import { attachStallTimeout } from '../lib/stream.js';
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
  }: {
    log: winston.Logger;
    peerManager: ArIOPeerManager;
    dataAttributesStore: ContiguousDataAttributesStore;
    peerRequestLimiter?: PeerRequestLimiter;
    maxHopsAllowed?: number;
    requestTimeoutMs?: number;
    streamStallTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.maxHopsAllowed = maxHopsAllowed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
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
  }: {
    peerAddress: string;
    id: string;
    headers: { [key: string]: string };
    requestAttributesHeaders?: ReturnType<typeof generateRequestAttributes>;
    signal?: AbortSignal;
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
    const onClientAbort = () => controller.abort(signal?.reason);
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

      if (response.status !== 200 && response.status !== 206) {
        response.data.destroy();
        throw new Error(`Unexpected status code from peer: ${response.status}`);
      }

      attachStallTimeout(response.data, this.streamStallTimeoutMs);

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
      const candidateCount = Math.max(1, retryCount ?? config.PEER_CANDIDATE_COUNT);

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
            streamPeerCounts.set(peer, (streamPeerCounts.get(peer) ?? 0) + 1);
            contiguousData.stream.once('close', () => {
              const count = streamPeerCounts.get(peer) ?? 1;
              if (count <= 1) {
                streamPeerCounts.delete(peer);
              } else {
                streamPeerCounts.set(peer, count - 1);
              }
              this.peerRequestLimiter?.release(peer);
            });

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
        hedgeDelayMs: config.PEER_HEDGE_DELAY_MS,
        maxConcurrent: config.PEER_MAX_HEDGED_REQUESTS,
        signal,
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

    return {
      stream,
      size: contentLength,
      verified: false,
      trusted: false,
      sourceContentType: response.headers['content-type'],
      cached: false,
      requestAttributes,
    };
  }
}
