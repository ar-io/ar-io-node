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

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_HOPS_ALLOWED = 3;

export class ArIODataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private updatePeersRefreshIntervalMs: number;

  private arIO: AoARIORead;
  peers: Record<string, string> = {};
  private intervalId?: NodeJS.Timeout;

  private getRandomWeightedPeers: (
    table: WeightedElement<string>[],
    peerCount: number,
  ) => string[];

  protected weightedPeers: WeightedElement<string>[] = [];

  constructor({
    log,
    arIO,
    nodeWallet,
    maxHopsAllowed = DEFAULT_MAX_HOPS_ALLOWED,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    updatePeersRefreshIntervalMs = DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS,
  }: {
    log: winston.Logger;
    arIO: AoARIORead;
    nodeWallet?: string;
    maxHopsAllowed?: number;
    requestTimeoutMs?: number;
    updatePeersRefreshIntervalMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.nodeWallet = nodeWallet;
    this.maxHopsAllowed = maxHopsAllowed;
    this.requestTimeoutMs = requestTimeoutMs;
    this.updatePeersRefreshIntervalMs = updatePeersRefreshIntervalMs;
    this.arIO = arIO;

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
  }

  stopUpdatingPeers() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  async updatePeerList() {
    const log = this.log.child({ method: 'updatePeerList' });
    log.debug('Updating peers from ArIO contract');

    const peers: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      try {
        // depending on how often this is called, we may want to add a circuit breaker
        const { nextCursor, items } = await this.arIO.getGateways({
          cursor,
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
    log.debug('Updated peer list from ArIO contract', {
      peers: Object.keys(peers),
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

  handlePeerSuccess(peer: string): void {
    metrics.getDataStreamSuccessesTotal.inc({
      class: this.constructor.name,
      source: peer,
    });
    // warm the succeeding peer
    this.weightedPeers.forEach((weightedPeer) => {
      if (weightedPeer.id === peer) {
        weightedPeer.weight = Math.min(
          weightedPeer.weight + config.WEIGHTED_PEERS_TEMPERATURE_DELTA,
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

        const parsedRequestAttributes = parseRequestAttributesHeaders({
          headers: response.headers as { [key: string]: string },
          currentHops: requestAttributesHeaders?.attributes.hops,
        });

        return this.parseResponse({
          response,
          requestAttributes: parsedRequestAttributes,
          peer: currentPeer,
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
    peer,
  }: {
    response: AxiosResponse;
    requestAttributes: RequestAttributes;
    peer: string;
  }): ContiguousData {
    const stream = response.data;

    stream.on('error', () => {
      this.handlePeerFailure(peer);
    });

    stream.on('end', () => {
      this.handlePeerSuccess(peer);
    });

    return {
      stream,
      size: parseInt(response.headers['content-length']),
      verified: false,
      sourceContentType: response.headers['content-type'],
      cached: false,
      requestAttributes,
    };
  }
}
