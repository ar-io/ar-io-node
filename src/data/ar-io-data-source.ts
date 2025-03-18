/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { default as axios, AxiosResponse } from 'axios';
import winston from 'winston';
import {
  WeightedElement,
  randomWeightedChoices,
} from '../lib/random-weighted-choices.js';
import { AoARIORead } from '@ar.io/sdk';
import memoize from 'memoizee';

import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
} from '../lib/request-attributes.js';
import { shuffleArray } from '../lib/random.js';

import * as metrics from '../metrics.js';
import * as config from '../config.js';
import CircuitBreaker from 'opossum';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_HOPS_ALLOWED = 3;

export class ArIODataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private updatePeersRefreshIntervalMs: number;
  private previousGatewayPeerTtfbDurations: number[];
  private previousGatewayPeerKbpsDownloadRate: number[];

  private networkProcess: AoARIORead;
  peers: Record<string, string> = {};
  private intervalId?: NodeJS.Timeout;

  private getRandomWeightedPeers: (
    table: WeightedElement<string>[],
    peerCount: number,
  ) => string[];

  protected weightedPeers: WeightedElement<string>[] = [];

  // circuit breaker for getGateways
  private arioGatewaysCircuitBreaker: CircuitBreaker<
    Parameters<AoARIORead['getGateways']>,
    Awaited<ReturnType<AoARIORead['getGateways']>>
  >;

  constructor({
    log,
    networkProcess,
    nodeWallet,
    maxHopsAllowed = DEFAULT_MAX_HOPS_ALLOWED,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    updatePeersRefreshIntervalMs = DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS,
    circuitBreakerOptions = {
      timeout: config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    networkProcess: AoARIORead;
    nodeWallet?: string;
    maxHopsAllowed?: number;
    requestTimeoutMs?: number;
    updatePeersRefreshIntervalMs?: number;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.maxHopsAllowed = maxHopsAllowed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
    this.previousGatewayPeerTtfbDurations = [];
    this.previousGatewayPeerKbpsDownloadRate = [];
    this.networkProcess = networkProcess;
    this.arioGatewaysCircuitBreaker = new CircuitBreaker(
      this.networkProcess.getGateways.bind(this.networkProcess),
      {
        ...circuitBreakerOptions,
        capacity: 1, // only allow one request at a time
        name: 'getGateways',
      },
    );
    this.updatePeerList();
    this.intervalId = setInterval(
      this.updatePeerList.bind(this),
      this.updatePeersRefreshIntervalMs,
    );

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
    metrics.circuitBreakerMetrics.add(this.arioGatewaysCircuitBreaker);
  }

  stopUpdatingPeers() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  async updatePeerList() {
    const log = this.log.child({ method: 'updatePeerList' });
    log.info('Fetching AR.IO network peer list');

    const peers: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      try {
        // depending on how often this is called, we may want to add a circuit breaker
        const { nextCursor, items } =
          await this.arioGatewaysCircuitBreaker.fire({
            cursor,
            limit: 1000,
          });

        for (const gateway of items) {
          // skip our own node wallet
          if (
            this.nodeWallet !== undefined &&
            this.nodeWallet === gateway.gatewayAddress
          ) {
            continue;
          }

          peers[gateway.gatewayAddress] =
            `${gateway.settings.protocol}://${gateway.settings.fqdn}`;
        }
        cursor = nextCursor;
      } catch (error: any) {
        log.error(
          'Failed to fetch gateways from ARIO Returning current peer list.',
          {
            message: error.message,
            stack: error.stack,
          },
        );
        break;
      }
    } while (cursor !== undefined);
    log.info('Successfully fetched AR.IO network peer list', {
      count: Object.keys(peers).length,
    });
    this.peers = peers;
    this.weightedPeers = Object.values(peers).map((id) => {
      const previousWeight =
        this.weightedPeers.find((peer) => peer.id === id)?.weight ?? undefined;
      return {
        id,
        // the weight system is a bit arbitrary being between 0 and 100, 50 is the default neutral
        weight: previousWeight === undefined ? 50 : previousWeight,
      };
    });
  }

  selectPeers(peerCount: number): string[] {
    const log = this.log.child({ method: 'selectPeers' });

    if (this.weightedPeers.length === 0) {
      log.warn('No weighted peers available');
      throw new Error('No weighted peers available');
    }

    return shuffleArray([
      ...this.getRandomWeightedPeers(this.weightedPeers, peerCount),
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
    this.weightedPeers.forEach((weightedPeer) => {
      if (weightedPeer.id === peer) {
        weightedPeer.weight = Math.min(
          weightedPeer.weight +
            config.WEIGHTED_PEERS_TEMPERATURE_DELTA +
            additionalWeightFromTtfb +
            additionalWeightFromKbps,
          100,
        );
      }
    });
  }

  handlePeerFailure(peer: string): void {
    metrics.getDataStreamErrorsTotal.inc({
      class: this.constructor.name,
      source: peer,
    });
    // cool the failing peer
    this.weightedPeers.forEach((weightedPeer) => {
      if (weightedPeer.id === peer) {
        weightedPeer.weight = Math.max(
          weightedPeer.weight - config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
          1,
        );
      }
    });
  }

  private async request({
    peerAddress,
    id,
    headers,
  }: {
    peerAddress: string;
    id: string;
    headers: { [key: string]: string };
  }): Promise<AxiosResponse> {
    const path = `/raw/${id}`;

    const response = await axios.get(`${peerAddress}${path}`, {
      headers: {
        'Accept-Encoding': 'identity',
        ...headers,
      },
      responseType: 'stream',
      timeout: this.requestTimeoutMs,
    });

    if (response.status !== 200) {
      throw new Error(`Unexpected status code from peer: ${response.status}`);
    }

    return response;
  }

  async getData({
    id,
    requestAttributes,
    region,
    retryCount,
  }: {
    id: string;
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
            ...(region
              ? {
                  Range: `bytes=${region.offset}-${region.offset + region.size - 1}`,
                }
              : {}),
          },
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
  }: {
    response: AxiosResponse;
    requestAttributes: RequestAttributes;
    requestStartTime: number;
    peer: string;
    ttfb: number;
  }): ContiguousData {
    const stream = response.data;

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
      sourceContentType: response.headers['content-type'],
      cached: false,
      requestAttributes,
    };
  }
}
