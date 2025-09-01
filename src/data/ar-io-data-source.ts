/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosResponse } from 'axios';
import winston from 'winston';
import { ArIOPeerManager, PeerSuccessMetrics } from './ar-io-peer-manager.js';

import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
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

import * as metrics from '../metrics.js';
import * as config from '../config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_DATA_HOPS = 3;
const DATA_CATEGORY = 'data';

export class ArIODataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private peerManager: ArIOPeerManager;
  peers: Record<string, string> = {};

  constructor({
    log,
    peerManager,
    maxHopsAllowed = MAX_DATA_HOPS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    peerManager: ArIOPeerManager;
    maxHopsAllowed?: number;
    requestTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.maxHopsAllowed = maxHopsAllowed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.peerManager = peerManager;
    this.peers = peerManager.getPeers();
  }

  selectPeers(peerCount: number): string[] {
    return this.peerManager.selectPeers(DATA_CATEGORY, peerCount);
  }

  handlePeerSuccess(peer: string, kbps: number, ttfb: number): void {
    metrics.getDataStreamSuccessesTotal.inc({
      class: this.constructor.name,
      source: peer,
    });

    const successMetrics: PeerSuccessMetrics = {
      kbps,
      ttfb,
    };

    this.peerManager.reportSuccess(DATA_CATEGORY, peer, successMetrics);
  }

  handlePeerFailure(peer: string): void {
    metrics.getDataStreamErrorsTotal.inc({
      class: this.constructor.name,
      source: peer,
    });

    this.peerManager.reportFailure(DATA_CATEGORY, peer);
  }

  private async request({
    peerAddress,
    id,
    headers,
    requestAttributesHeaders,
  }: {
    peerAddress: string;
    id: string;
    headers: { [key: string]: string };
    requestAttributesHeaders?: ReturnType<typeof generateRequestAttributes>;
  }): Promise<AxiosResponse> {
    const path = `/raw/${id}`;

    const response = await axios.get(`${peerAddress}${path}`, {
      headers: {
        'Accept-Encoding': 'identity',
        'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
        ...headers,
      },
      responseType: 'stream',
      timeout: this.requestTimeoutMs,
      params: {
        'ar-io-hops': requestAttributesHeaders?.attributes.hops,
        'ar-io-origin': requestAttributesHeaders?.attributes.origin,
        'ar-io-origin-release':
          requestAttributesHeaders?.attributes.originNodeRelease,
        'ar-io-arns-record': requestAttributesHeaders?.attributes.arnsRecord,
        'ar-io-arns-basename':
          requestAttributesHeaders?.attributes.arnsBasename,
      },
    });

    if (response.status !== 200) {
      throw new Error(`Unexpected status code from peer: ${response.status}`);
    }

    return response;
  }

  async getData({
    id,
    dataAttributes,
    requestAttributes,
    region,
    retryCount,
    parentSpan,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
    retryCount?: number;
    parentSpan?: Span;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'ArIODataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_attributes': dataAttributes !== undefined,
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
      const log = this.log.child({ method: 'getData' });
      const totalRetryCount =
        retryCount ??
        Math.min(
          Math.max(Object.keys(this.peerManager.getPeers()).length, 1),
          3,
        );

      span.setAttributes({
        'ario.request.retry_count': totalRetryCount,
        'ario.peers.available_count': Object.keys(this.peerManager.getPeers())
          .length,
      });

      log.debug('Fetching contiguous data from ArIO peer', {
        id,
        totalRetryCount,
      });

      if (requestAttributes !== undefined) {
        validateHopCount(requestAttributes.hops, this.maxHopsAllowed);
        span.setAttribute('ario.request.hops', requestAttributes.hops);
      }

      const randomPeers = this.selectPeers(totalRetryCount);
      span.addEvent('Selected peers for request');

      const requestAttributesHeaders =
        generateRequestAttributes(requestAttributes);

      for (let i = 0; i < randomPeers.length; i++) {
        const currentPeer = randomPeers[i];
        const peerRequestStart = Date.now();

        span.addEvent('Attempting peer request', {
          'ario.peer.url': currentPeer,
          'ario.peer.index': i,
        });

        try {
          const requestStartTime = Date.now();
          const response = await this.request({
            peerAddress: currentPeer,
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
          });
          const ttfb = Date.now() - requestStartTime;
          const peerRequestDuration = Date.now() - peerRequestStart;

          span.setAttributes({
            'ario.peer.successful_url': currentPeer,
            'ario.peer.successful_index': i,
            'ario.request.duration_ms': peerRequestDuration,
            'ario.request.ttfb_ms': ttfb,
            'http.status_code': response.status,
          });

          span.addEvent('Peer request successful', {
            'ario.peer.url': currentPeer,
            'ario.peer.index': i,
          });

          const parsedRequestAttributes = parseRequestAttributesHeaders({
            headers: response.headers as { [key: string]: string },
            currentHops: requestAttributesHeaders?.attributes.hops,
          });

          return this.parseResponse({
            response,
            requestAttributes: parsedRequestAttributes,
            requestStartTime,
            peer: currentPeer,
            ttfb,
            expectedHash: dataAttributes?.hash,
          });
        } catch (error: any) {
          span.addEvent('Peer request failed', {
            'ario.peer.url': currentPeer,
            'ario.peer.index': i,
            'ario.request.error': error.message,
          });

          metrics.getDataErrorsTotal.inc({
            class: this.constructor.name,
            source: currentPeer,
          });
          log.error('Failed to fetch contiguous data from ArIO peer', {
            currentPeer,
            message: error.message,
            stack: error.stack,
          });
        }
      }

      throw new Error('Failed to fetch contiguous data from ArIO peers');
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
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
  }: {
    response: AxiosResponse;
    requestAttributes: RequestAttributes;
    requestStartTime: number;
    peer: string;
    ttfb: number;
    expectedHash?: string;
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
    stream.on('error', () => {
      this.handlePeerFailure(peer);
    });

    stream.on('end', () => {
      const downloadTimeSeconds = (Date.now() - requestStartTime) / 1000;
      const kbps = contentLength / downloadTimeSeconds / 1024;
      this.handlePeerSuccess(peer, kbps, ttfb);
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
