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
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';
import { buildRangeHeader, parseContentLength } from '../lib/http-utils.js';

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
    parentSpan,
    signal,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'GatewaysDataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.region.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
          'gateways.config.priority_tiers': this.trustedGateways.size,
          'gateways.config.request_timeout_ms': this.requestTimeoutMs,
        },
      },
      parentSpan,
    );

    try {
      // Check for abort before starting
      signal?.throwIfAborted();
      const path = `/raw/${id}`;
      const requestAttributesHeaders =
        generateRequestAttributes(requestAttributes);

      // lower number = higher priority
      const priorities = Array.from(this.trustedGateways.keys()).sort(
        (a, b) => a - b,
      );

      span.addEvent('Starting gateway attempts', {
        'gateways.attempt.priority_tiers': priorities.length,
        'gateways.attempt.total_gateways': Array.from(
          this.trustedGateways.values(),
        ).reduce((sum, gateways) => sum + gateways.length, 0),
      });

      let lastError: Error | null = null;

      for (const priority of priorities) {
        const gatewaysInTier = this.trustedGateways.get(priority);

        if (gatewaysInTier) {
          span.addEvent('Trying priority tier', {
            'gateways.tier.priority': priority,
            'gateways.tier.count': gatewaysInTier.length,
          });
          const shuffledGateways = shuffleArray([...gatewaysInTier]);

          for (const gatewayUrl of shuffledGateways) {
            // Check for abort before each gateway attempt
            signal?.throwIfAborted();

            // Combine timeout with client abort signal
            const signals: AbortSignal[] = [
              AbortSignal.timeout(this.requestTimeoutMs),
            ];
            if (signal) signals.push(signal);
            const combinedSignal = AbortSignal.any(signals);

            const gatewayAxios = axios.create({
              baseURL: gatewayUrl,
              signal: combinedSignal,
              headers: {
                'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
              },
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

            const gatewayRequestStart = Date.now();
            span.addEvent('Attempting gateway request', {
              'gateways.request.url': gatewayUrl,
              'gateways.request.priority': priority,
              'gateways.request.has_region': region !== undefined,
            });

            try {
              const response = await gatewayAxios.request({
                method: 'GET',
                headers: {
                  'Accept-Encoding': 'identity',
                  ...requestAttributesHeaders?.headers,
                  ...(region
                    ? {
                        Range: buildRangeHeader(
                          region.offset,
                          region.offset + region.size - 1,
                        ),
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

              const gatewayRequestDuration = Date.now() - gatewayRequestStart;

              if (
                (region !== undefined && response.status !== 206) ||
                (region === undefined && response.status !== 200)
              ) {
                span.addEvent('Gateway returned unexpected status', {
                  'gateways.url': gatewayUrl,
                  'gateways.tier.priority': priority,
                  'http.status_code': response.status,
                  'http.expected_status': region !== undefined ? 206 : 200,
                  'gateways.request.duration_ms': gatewayRequestDuration,
                });
                throw new Error(
                  `Unexpected status code from gateway: ${response.status}. Expected ${
                    region !== undefined ? '206' : '200'
                  }.`,
                );
              }

              const stream = response.data;
              const contentLength = parseContentLength(response.headers) ?? 0;

              span.setAttributes({
                'gateway.successful_url': gatewayUrl,
                'gateway.successful_priority': priority,
                'gateway.request_duration_ms': gatewayRequestDuration,
                'gateway.response_status': response.status,
                'data.size': contentLength,
                'data.content_type': response.headers['content-type'],
              });

              span.addEvent('Gateway request successful', {
                'gateways.url': gatewayUrl,
                'gateways.tier.priority': priority,
                'http.status_code': response.status,
                'http.content_length': contentLength,
                'gateways.request.duration_ms': gatewayRequestDuration,
              });

              const requestType = region ? 'range' : 'full';

              stream.on('error', () => {
                metrics.getDataStreamErrorsTotal.inc({
                  class: this.constructor.name,
                  source: gatewayUrl,
                  request_type: requestType,
                });
              });

              stream.on('end', () => {
                metrics.getDataStreamSuccessesTotal.inc({
                  class: this.constructor.name,
                  source: gatewayUrl,
                  request_type: requestType,
                });

                // Track bytes streamed
                metrics.getDataStreamBytesTotal.inc(
                  {
                    class: this.constructor.name,
                    source: gatewayUrl,
                    request_type: requestType,
                  },
                  contentLength,
                );

                metrics.getDataStreamSizeHistogram.observe(
                  {
                    class: this.constructor.name,
                    source: gatewayUrl,
                    request_type: requestType,
                  },
                  contentLength,
                );
              });

              return {
                stream,
                size: contentLength,
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
              // Handle AbortError - distinguish client disconnect from timeout
              if (error.name === 'AbortError') {
                const isClientDisconnect = signal?.aborted === true;
                span.addEvent('Request aborted', {
                  'gateways.url': gatewayUrl,
                  'gateways.tier.priority': priority,
                  'data.retrieval.error': isClientDisconnect
                    ? 'client_disconnected'
                    : 'timeout',
                });
                // Only skip remaining gateways on client disconnect, not timeout
                if (isClientDisconnect) {
                  throw error;
                }
                lastError = error;
                continue;
              }

              const gatewayRequestDuration = Date.now() - gatewayRequestStart;
              lastError = error as Error;

              span.addEvent('Gateway request failed', {
                'gateways.url': gatewayUrl,
                'gateways.tier.priority': priority,
                'gateways.request.error': error.message,
                'gateways.request.duration_ms': gatewayRequestDuration,
              });

              this.log.warn('Failed to fetch from gateway', {
                gatewayUrl,
                priority,
                error: error.message,
              });
            }
          }

          span.addEvent('Priority tier exhausted', {
            'gateways.tier.priority': priority,
          });
          this.log.warn('All gateways in priority tier failed', { priority });
        }
      }

      // All gateways failed
      span.setAttribute('gateway.all_failed', true);
      span.addEvent('All gateways failed');

      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
      });

      const finalError =
        lastError || new Error('All gateways failed to respond');
      span.recordException(finalError);
      throw finalError;
    } catch (error: any) {
      // Don't record AbortError as exception
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}
