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
import { TrustedGatewayConfig } from '../config.js';
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';
import {
  buildRangeHeader,
  normalizeAbortError,
  parseContentLength,
} from '../lib/http-utils.js';
import { attachStallTimeout } from '../lib/stream.js';

export class GatewaysDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private gatewayTrust: Map<string, boolean>;
  private readonly requestTimeoutMs: number;
  private readonly streamStallTimeoutMs: number;
  private readonly fallbackToBasePath: boolean;

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    streamStallTimeoutMs = config.STREAM_STALL_TIMEOUT_MS,
    fallbackToBasePath = false,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, TrustedGatewayConfig>;
    requestTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    fallbackToBasePath?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
    this.fallbackToBasePath = fallbackToBasePath;

    if (Object.keys(trustedGatewaysUrls).length === 0) {
      throw new Error('At least one gateway URL must be provided');
    }

    // lower number = higher priority
    this.trustedGateways = new Map();
    this.gatewayTrust = new Map();
    for (const [url, gatewayConfig] of Object.entries(trustedGatewaysUrls)) {
      const { priority, trusted } = gatewayConfig;
      if (!this.trustedGateways.has(priority)) {
        this.trustedGateways.set(priority, []);
      }
      this.trustedGateways.get(priority)?.push(url);
      this.gatewayTrust.set(url, trusted);
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

      // Skip remote forwarding for compute-origin requests to prevent loops
      if (requestAttributes?.skipRemoteForwarding) {
        throw new Error('Remote forwarding skipped for compute-origin request');
      }

      const pathPrefixes = this.fallbackToBasePath ? ['/raw', ''] : ['/raw'];
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

            const gatewayAxios = axios.create({
              baseURL: gatewayUrl,
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

            for (const pathPrefix of pathPrefixes) {
              const path = pathPrefix ? `${pathPrefix}/${id}` : `/${id}`;

              // Connection phase: use AbortController with wall-clock timeout
              // for establishing the connection, then switch to stall-based
              // timeout once the stream starts flowing.
              const controller = new AbortController();
              const connectionTimer = setTimeout(
                () => controller.abort(new Error('Connection timeout')),
                this.requestTimeoutMs,
              );
              const onClientAbort = () => controller.abort(signal?.reason);
              if (signal) {
                signal.addEventListener('abort', onClientAbort, { once: true });
              }

              this.log.debug(
                'Attempting to fetch contiguous data from gateway',
                {
                  id,
                  gatewayUrl,
                  priority,
                  path,
                  region,
                },
              );

              const gatewayRequestStart = Date.now();
              span.addEvent('Attempting gateway request', {
                'gateways.request.url': gatewayUrl,
                'gateways.request.priority': priority,
                'gateways.request.path': path,
                'gateways.request.has_region': region !== undefined,
              });

              try {
                const response = await gatewayAxios.request({
                  signal: controller.signal,
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
                    'ar-io-via':
                      requestAttributesHeaders?.attributes.via?.join(', '),
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
                    'gateways.request.path': path,
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

                // Connection established - clear connection timeout and
                // switch to stall-based timeout for the streaming phase
                clearTimeout(connectionTimer);
                if (signal) {
                  signal.removeEventListener('abort', onClientAbort);
                }

                const stream = response.data;
                const contentLength = parseContentLength(response.headers);

                if (contentLength === undefined || contentLength === 0) {
                  stream.destroy();
                  throw new Error(
                    `Gateway response has no content-length or zero content-length for ${id}`,
                  );
                }

                attachStallTimeout(stream, this.streamStallTimeoutMs);

                const gatewayTrusted =
                  this.gatewayTrust.get(gatewayUrl) ?? true;

                span.setAttributes({
                  'gateway.successful_url': gatewayUrl,
                  'gateway.successful_priority': priority,
                  'gateway.successful_trusted': gatewayTrusted,
                  'gateway.successful_path': path,
                  'gateway.request_duration_ms': gatewayRequestDuration,
                  'gateway.response_status': response.status,
                  'data.size': contentLength,
                  'data.content_type': response.headers['content-type'],
                });

                span.addEvent('Gateway request successful', {
                  'gateways.url': gatewayUrl,
                  'gateways.tier.priority': priority,
                  'gateways.request.path': path,
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
                  trusted: gatewayTrusted,
                  sourceContentType: response.headers['content-type'],
                  cached: false,
                  requestAttributes: parseRequestAttributesHeaders({
                    headers: response.headers as { [key: string]: string },
                    currentHops: requestAttributesHeaders?.attributes.hops,
                  }),
                };
              } catch (rawError: any) {
                clearTimeout(connectionTimer);
                if (signal) {
                  signal.removeEventListener('abort', onClientAbort);
                }
                const error = normalizeAbortError(rawError);

                // Handle AbortError - distinguish client disconnect from timeout
                if (error.name === 'AbortError') {
                  const isClientDisconnect = signal?.aborted === true;
                  span.addEvent('Request aborted', {
                    'gateways.url': gatewayUrl,
                    'gateways.tier.priority': priority,
                    'gateways.request.path': path,
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
                  'gateways.request.path': path,
                  'gateways.request.error': error.message,
                  'gateways.request.duration_ms': gatewayRequestDuration,
                });

                this.log.warn('Failed to fetch from gateway', {
                  gatewayUrl,
                  priority,
                  path,
                  error: error.message,
                });
              }
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
