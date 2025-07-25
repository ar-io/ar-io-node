/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as axios } from 'axios';
import winston from 'winston';
import {
  generateRequestAttributes,
  parseRequestAttributesHeaders,
} from '../lib/request-attributes.js';
import { shuffleArray } from '../lib/random.js';
import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import * as metrics from '../metrics.js';
import * as config from '../config.js';

export class GatewaysDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private readonly requestTimeoutMs: number;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
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
        const shuffledGateways = shuffleArray([...gatewaysInTier]);

        for (const gatewayUrl of shuffledGateways) {
          const gatewayAxios = axios.create({
            baseURL: gatewayUrl,
            timeout: this.requestTimeoutMs,
          });

          gatewayAxios.interceptors.request.use((config) => {
            this.log.debug('Axios request initiated', {
              url: config.url,
              method: config.method,
              headers: config.headers,
              params: config.params,
              timeout: config.timeout,
            });
            return config;
          });

          gatewayAxios.interceptors.response.use(
            (response) => {
              this.log.debug('Axios response received', {
                url: response.config.url,
                status: response.status,
                headers: response.headers,
              });
              return response;
            },
            (error) => {
              if (error.response) {
                this.log.error('Axios response error', {
                  url: error.response.config.url,
                  status: error.response.status,
                  headers: error.response.headers,
                });
              } else {
                this.log.error('Axios network error', {
                  message: error.message,
                });
              }
              return Promise.reject(error);
            },
          );

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
                'ar-io-arns-record':
                  requestAttributesHeaders?.attributes.arnsRecord,
                'ar-io-arns-basename':
                  requestAttributesHeaders?.attributes.arnsBasename,
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
                source: gatewayUrl,
              });
            });

            stream.on('end', () => {
              metrics.getDataStreamSuccessesTotal.inc({
                class: this.constructor.name,
                source: gatewayUrl,
              });
            });

            return {
              stream,
              size: parseInt(response.headers['content-length']),
              verified: false,
              trusted: true,
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
