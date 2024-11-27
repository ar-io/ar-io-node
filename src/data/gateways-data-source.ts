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
import { default as axios } from 'axios';
import winston from 'winston';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
} from '../lib/request-attributes.js';

import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import * as metrics from '../metrics.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export class GatewaysDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly requestTimeoutMs: number;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, number>;
    requestTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.requestTimeoutMs = requestTimeoutMs;

    if (Object.keys(trustedGatewaysUrls).length === 0) {
      throw new Error('At least one gateway URL must be provided');
    }

    // lower number = higher priority
    this.trustedGateways = new Map();
    for (const [url, priority] of Object.entries(trustedGatewaysUrls)) {
      if (!this.trustedGateways.has(priority)) {
        this.trustedGateways.set(priority, []);
      }
      this.trustedGateways.get(priority)?.push(url);
    }
  }

  // Fisher-Yates algorithm
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
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
    const path = `/raw/${id}`;
    const requestAttributesHeaders =
      generateRequestAttributes(requestAttributes);

    // lower number = higher priority
    const priorities = Array.from(this.trustedGateways.keys()).sort(
      (a, b) => a - b,
    );

    let lastError: Error | null = null;

    for (const priority of priorities) {
      const gatewaysInTier = this.trustedGateways.get(priority);

      if (gatewaysInTier) {
        const shuffledGateways = this.shuffleArray([...gatewaysInTier]);

        for (const gatewayUrl of shuffledGateways) {
          const gatewayAxios = axios.create({
            baseURL: gatewayUrl,
            timeout: this.requestTimeoutMs,
          });

          this.log.debug('Attempting to fetch contiguous data from gateway', {
            id,
            gatewayUrl,
            priority,
            path,
            region,
          });

          try {
            const response = await gatewayAxios.request({
              method: 'GET',
              headers: {
                'Accept-Encoding': 'identity',
                ...requestAttributesHeaders?.headers,
                ...(region
                  ? {
                      Range: `bytes=${region.offset}-${
                        region.offset + region.size - 1
                      }`,
                    }
                  : {}),
              },
              url: path,
              responseType: 'stream',
              params: {
                'ar-io-hops': requestAttributesHeaders?.attributes.hops,
                'ar-io-origin': requestAttributesHeaders?.attributes.origin,
                'ar-io-origin-release':
                  requestAttributesHeaders?.attributes.originNodeRelease,
              },
            });

            if (
              (region !== undefined && response.status !== 206) ||
              (region === undefined && response.status !== 200)
            ) {
              throw new Error(
                `Unexpected status code from gateway: ${response.status}. Expected ${
                  region !== undefined ? '206' : '200'
                }.`,
              );
            }

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
              requestAttributes: parseRequestAttributesHeaders({
                headers: response.headers as { [key: string]: string },
                currentHops: requestAttributesHeaders?.attributes.hops,
              }),
            };
          } catch (error: any) {
            lastError = error as Error;
            this.log.warn('Failed to fetch from gateway', {
              gatewayUrl,
              priority,
              error: error.message,
            });
          }
        }

        this.log.warn('All gateways in priority tier failed', { priority });
      }
    }

    metrics.getDataErrorsTotal.inc({
      class: this.constructor.name,
    });

    throw lastError || new Error('All gateways failed to respond');
  }
}
