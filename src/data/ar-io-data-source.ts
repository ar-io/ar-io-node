/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios, AxiosResponse } from 'axios';
import winston from 'winston';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import memoize from 'memoizee';
import { ArIOPeerManager } from './ar-io-peer-manager.js';

import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  Region,
  RequestAttributes,
  WithPeers,
} from '../types.js';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
} from '../lib/request-attributes.js';
import { shuffleArray } from '../lib/random.js';
import { headerNames } from '../constants.js';

import * as metrics from '../metrics.js';
import * as config from '../config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const DEFAULT_MAX_HOPS_ALLOWED = 3;

export type PeerWeight = {
  url: string;
  dataWeight: number;
};

export class ArIODataSource
  implements ContiguousDataSource, WithPeers<PeerWeight>
{
  private log: winston.Logger;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private previousGatewayPeerTtfbDurations: number[];
  private previousGatewayPeerKbpsDownloadRate: number[];

  private peerManager: ArIOPeerManager;
  peers: Record<string, string> = {};

  private getRandomWeightedPeers: (
    table: WeightedElement<string>[],
    peerCount: number,
  ) => string[];

  protected weightedPeers: Map<string, number> = new Map();
  private lastPeerListUpdate = 0;
  private readonly PEER_LIST_UPDATE_INTERVAL_MS = 60000; // Update peer list at most once per minute

  constructor({
    log,
    peerManager,
    maxHopsAllowed = DEFAULT_MAX_HOPS_ALLOWED,
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
    this.previousGatewayPeerTtfbDurations = [];
    this.previousGatewayPeerKbpsDownloadRate = [];
    this.peerManager = peerManager;
    this.initializeWeightedPeers();

    this.getRandomWeightedPeers = memoize(
      (table: WeightedElement<string>[], peerCount: number) =>
        randomWeightedChoices<string>({
          table,
          count: peerCount,
        }),
      {
        maxAge: config.GATEWAY_PEERS_WEIGHTS_CACHE_DURATION_MS,
      },
    );
  }

  stopUpdatingPeers() {
    // Peer updates are now managed by the peer manager
  }

  getPeers(): Record<string, PeerWeight> {
    const peers: Record<string, PeerWeight> = {};
    for (const [peerId, weight] of this.weightedPeers) {
      try {
        const url = new URL(peerId);
        const key = url.hostname + (url.port ? `:${url.port}` : ':443');
        peers[key] = {
          url: peerId,
          dataWeight: weight,
        };
      } catch (error) {
        // Skip if URL parsing fails
      }
    }
    return peers;
  }

  private initializeWeightedPeers() {
    this.peers = this.peerManager.getPeers();
    // Only add new peers, don't reset existing weights
    for (const peerId of Object.values(this.peers)) {
      if (!this.weightedPeers.has(peerId)) {
        this.weightedPeers.set(peerId, 50); // Default neutral weight
      }
    }
    this.lastPeerListUpdate = Date.now();
  }

  private syncPeerListIfNeeded() {
    const now = Date.now();
    if (now - this.lastPeerListUpdate > this.PEER_LIST_UPDATE_INTERVAL_MS) {
      this.peers = this.peerManager.getPeers();
      const currentPeerUrls = new Set(Object.values(this.peers));

      // Remove peers that no longer exist
      for (const peerId of this.weightedPeers.keys()) {
        if (!currentPeerUrls.has(peerId)) {
          this.weightedPeers.delete(peerId);
        }
      }

      // Add new peers with default weight
      for (const peerId of currentPeerUrls) {
        if (!this.weightedPeers.has(peerId)) {
          this.weightedPeers.set(peerId, 50);
        }
      }

      this.lastPeerListUpdate = now;
    }
  }

  private getWeightedPeersArray(): WeightedElement<string>[] {
    return Array.from(this.weightedPeers.entries()).map(([id, weight]) => ({
      id,
      weight,
    }));
  }

  selectPeers(peerCount: number): string[] {
    const log = this.log.child({ method: 'selectPeers' });

    // Only sync peer list periodically, not on every call
    this.syncPeerListIfNeeded();

    if (this.weightedPeers.size === 0) {
      log.warn('No weighted peers available');
      throw new Error('No weighted peers available');
    }

    const weightedPeersArray = this.getWeightedPeersArray();
    return shuffleArray([
      ...this.getRandomWeightedPeers(weightedPeersArray, peerCount),
    ]);
  }

  handlePeerSuccess(peer: string, kbps: number, ttfb: number): void {
    metrics.getDataStreamSuccessesTotal.inc({
      class: this.constructor.name,
      source: peer,
    });

    this.previousGatewayPeerTtfbDurations.push(ttfb);
    if (
      this.previousGatewayPeerTtfbDurations.length >
      config.GATEWAY_PEERS_REQUEST_WINDOW_COUNT
    ) {
      this.previousGatewayPeerTtfbDurations.shift();
    }

    this.previousGatewayPeerKbpsDownloadRate.push(kbps);
    if (
      this.previousGatewayPeerKbpsDownloadRate.length >
      config.GATEWAY_PEERS_REQUEST_WINDOW_COUNT
    ) {
      this.previousGatewayPeerKbpsDownloadRate.shift();
    }
    const currentAverageTtfb =
      this.previousGatewayPeerTtfbDurations.length === 0
        ? 0
        : this.previousGatewayPeerTtfbDurations.reduce(
            (acc, value) => acc + value,
            0,
          ) / this.previousGatewayPeerTtfbDurations.length;

    const currentAverageKbps =
      this.previousGatewayPeerKbpsDownloadRate.length === 0
        ? 0
        : this.previousGatewayPeerKbpsDownloadRate.reduce(
            (acc, value) => acc + value,
            0,
          ) / this.previousGatewayPeerKbpsDownloadRate.length;

    const additionalWeightFromTtfb =
      ttfb > currentAverageTtfb ? 0 : config.WEIGHTED_PEERS_TEMPERATURE_DELTA;
    const additionalWeightFromKbps =
      kbps <= currentAverageKbps ? 0 : config.WEIGHTED_PEERS_TEMPERATURE_DELTA;

    // warm the succeeding peer
    const currentWeight = this.weightedPeers.get(peer);
    if (currentWeight !== undefined) {
      this.weightedPeers.set(
        peer,
        Math.min(
          currentWeight +
            config.WEIGHTED_PEERS_TEMPERATURE_DELTA +
            additionalWeightFromTtfb +
            additionalWeightFromKbps,
          100,
        ),
      );
    }
  }

  handlePeerFailure(peer: string): void {
    metrics.getDataStreamErrorsTotal.inc({
      class: this.constructor.name,
      source: peer,
    });

    // cool the failing peer
    const currentWeight = this.weightedPeers.get(peer);
    if (currentWeight !== undefined) {
      this.weightedPeers.set(
        peer,
        Math.max(currentWeight - config.WEIGHTED_PEERS_TEMPERATURE_DELTA, 1),
      );
    }
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
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
    retryCount?: number;
  }): Promise<ContiguousData> {
    const log = this.log.child({ method: 'getData' });
    const totalRetryCount =
      retryCount ?? Math.min(Math.max(Object.keys(this.peers).length, 1), 3);

    log.debug('Fetching contiguous data from ArIO peer', {
      id,
      totalRetryCount,
    });

    if (requestAttributes !== undefined) {
      if (requestAttributes.hops >= this.maxHopsAllowed) {
        log.error('Max hops reached');
        throw new Error('Max hops reached');
      }
    }

    const randomPeers = this.selectPeers(totalRetryCount);

    const requestAttributesHeaders =
      generateRequestAttributes(requestAttributes);
    for (const currentPeer of randomPeers) {
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
