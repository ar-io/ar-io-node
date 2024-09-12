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
import { AoIORead } from '@ar.io/sdk';
import { randomInt } from 'node:crypto';

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
import * as metrics from '../metrics.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds
const DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_HOPS_ALLOWED = 3;

export class ArIODataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private nodeWallet: string | undefined;
  private maxHopsAllowed: number;
  private requestTimeoutMs: number;
  private updatePeersRefreshIntervalMs: number;

  private arIO: AoIORead;
  peers: Record<string, string> = {};
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    arIO,
    nodeWallet,
    maxHopsAllowed = DEFAULT_MAX_HOPS_ALLOWED,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    updatePeersRefreshIntervalMs = DEFAULT_UPDATE_PEERS_REFRESH_INTERVAL_MS,
  }: {
    log: winston.Logger;
    arIO: AoIORead;
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
  }

  stopUpdatingPeers() {
    this.intervalId && clearInterval(this.intervalId);
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
          'Failed to fetch gateways from IO. Returning current peer list.',
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
  }

  selectPeer(): string {
    const log = this.log.child({ method: 'selectPeer' });
    const keys = Object.keys(this.peers);

    if (keys.length === 0) {
      log.warn('No peers available');
      throw new Error('No peers available');
    }

    const randomIndex = randomInt(0, keys.length);
    return this.peers[keys[randomIndex]];
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
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    const log = this.log.child({ method: 'getData' });

    log.debug('Fetching contiguous data from ArIO peer', {
      id,
    });

    if (requestAttributes !== undefined) {
      if (requestAttributes.hops >= this.maxHopsAllowed) {
        log.error('Max hops reached');
        throw new Error('Max hops reached');
      }
    }

    let selectedPeer = this.selectPeer();

    const requestAttributesHeaders =
      generateRequestAttributes(requestAttributes);

    try {
      const response = await this.request({
        peerAddress: selectedPeer,
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

      return this.parseResponse(response, parsedRequestAttributes);
    } catch (error: any) {
      metrics.getDataErrorsTotal.inc({
        class: 'ArIODataSource',
      });
      log.error('Failed to fetch contiguous data from first random ArIO peer', {
        message: error.message,
        stack: error.stack,
      });

      try {
        selectedPeer = this.selectPeer();
        const response = await this.request({
          peerAddress: selectedPeer,
          id,
          headers: requestAttributesHeaders?.headers || {},
        });

        const parsedRequestAttributes = parseRequestAttributesHeaders({
          headers: response.headers as { [key: string]: string },
          currentHops: requestAttributesHeaders?.attributes.hops,
        });

        return this.parseResponse(response, parsedRequestAttributes);
      } catch (error: any) {
        metrics.getDataErrorsTotal.inc({
          class: this.constructor.name,
        });
        log.error(
          'Failed to fetch contiguous data from second random ArIO peer',
          {
            message: error.message,
            stack: error.stack,
          },
        );
        throw new Error('Failed to fetch contiguous data from ArIO peers');
      }
    }
  }

  private parseResponse(
    response: AxiosResponse,
    requestAttributes: RequestAttributes,
  ): ContiguousData {
    const stream = response.data;

    stream.on('error', () => {
      metrics.getDataStreamErrorsTotal.inc({
        class: this.constructor.name,
      });
    });

    stream.on('end', () => {
      metrics.getDataStreamSuccessesTotal.inc({
        class: this.constructor.name,
      });
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
