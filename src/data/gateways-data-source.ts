/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Span } from '@opentelemetry/api';
import { default as axios } from 'axios';
import http from 'node:http';
import https from 'node:https';
import winston from 'winston';

import * as config from '../config.js';
import { TrustedGatewayConfig } from '../config.js';
import {
  buildRangeHeader,
  normalizeAbortError,
  parseContentLength,
  parseContentRange,
} from '../lib/http-utils.js';
import { shuffleArray } from '../lib/random.js';
import {
  detectLoopInViaChain,
  generateRequestAttributes,
  parseRequestAttributesHeaders,
  parseUpstreamTagHeaders,
  validateHopCount,
} from '../lib/request-attributes.js';
import { ByteRangeTransform, attachStallTimeout } from '../lib/stream.js';
import * as metrics from '../metrics.js';
import { startChildSpan } from '../tracing.js';
import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';

const MAX_DATA_HOPS = 3;

// Shared keep-alive agent pool, one entry per gateway URL. Reusing TCP+TLS
// connections across requests avoids per-request handshake cost, slashes
// kernel TIME_WAIT churn, and gives upstream connections a chance to settle
// into stable buffer sizes (which matters at high ANS104_DOWNLOAD_WORKERS).
// maxSockets caps concurrent connections per gateway so a burst of retry
// traffic doesn't open hundreds of sockets simultaneously.
const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60_000,
} as const;

export class GatewaysDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private trustedGateways: Map<number, string[]>;
  private gatewayTrust: Map<string, boolean>;
  private readonly requestTimeoutMs: number;
  private readonly streamStallTimeoutMs: number;
  private readonly fallbackToBasePath: boolean;
  private readonly maxHopsAllowed: number;
  private readonly rangeAccept200MaxOffset: number;
  private readonly agents: Map<string, http.Agent | https.Agent> = new Map();

  constructor({
    log,
    trustedGatewaysUrls,
    requestTimeoutMs = config.TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS,
    streamStallTimeoutMs = config.STREAM_STALL_TIMEOUT_MS,
    fallbackToBasePath = false,
    maxHopsAllowed = MAX_DATA_HOPS,
    rangeAccept200MaxOffset = config.GATEWAYS_RANGE_ACCEPT_200_MAX_OFFSET,
  }: {
    log: winston.Logger;
    trustedGatewaysUrls: Record<string, TrustedGatewayConfig>;
    requestTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    fallbackToBasePath?: boolean;
    maxHopsAllowed?: number;
    rangeAccept200MaxOffset?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamStallTimeoutMs = streamStallTimeoutMs;
    this.fallbackToBasePath = fallbackToBasePath;
    this.maxHopsAllowed = maxHopsAllowed;
    this.rangeAccept200MaxOffset = rangeAccept200MaxOffset;

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

  // Returns a long-lived keep-alive agent for the given gateway URL. The agent
  // is created lazily on first request and cached for the lifetime of this
  // data source instance.
  private getAgent(gatewayUrl: string): http.Agent | https.Agent {
    let agent = this.agents.get(gatewayUrl);
    if (agent === undefined) {
      agent = gatewayUrl.startsWith('https://')
        ? new https.Agent(AGENT_OPTIONS)
        : new http.Agent(AGENT_OPTIONS);
      this.agents.set(gatewayUrl, agent);
    }
    return agent;
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
    signal,
    acceptContentType,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
    acceptContentType?: (contentType: string | undefined) => boolean;
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

      // Hop count validation
      if (requestAttributes !== undefined) {
        validateHopCount(requestAttributes.hops, this.maxHopsAllowed);
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

            const gatewayHostname = new URL(gatewayUrl).hostname.toLowerCase();
            if (
              requestAttributes?.via != null &&
              detectLoopInViaChain(requestAttributes.via, gatewayHostname)
            ) {
              this.log.debug('Skipping gateway already present in via chain', {
                gatewayUrl,
                via: requestAttributes.via,
              });
              continue;
            }

            const isHttps = gatewayUrl.startsWith('https://');
            const agent = this.getAgent(gatewayUrl);
            const gatewayAxios = axios.create({
              baseURL: gatewayUrl,
              headers: {
                'X-AR-IO-Node-Release': config.AR_IO_NODE_RELEASE,
              },
              httpAgent: isHttps ? undefined : (agent as http.Agent),
              httpsAgent: isHttps ? (agent as https.Agent) : undefined,
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
              if (signal?.aborted) {
                onClientAbort();
              } else if (signal) {
                signal.addEventListener('abort', onClientAbort, {
                  once: true,
                });
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

                // For region requests we accept either 206 (proper partial
                // content) or 200 (upstream ignored our Range header and
                // returned the full body — common when nginx caching is in
                // front of an origin without slice configured). On the 200
                // path we slice the full body locally below to satisfy the
                // consumer's region; the upstream bandwidth cost is real
                // but unavoidable here, and rejecting the response just
                // forces a fallback to the next tier which is strictly
                // worse for callers. For non-region requests only 200 is
                // acceptable.
                const isRangedRequest = region !== undefined;
                const upstreamIgnoredRange =
                  isRangedRequest && response.status === 200;
                const acceptableStatus =
                  (isRangedRequest &&
                    (response.status === 206 || response.status === 200)) ||
                  (!isRangedRequest && response.status === 200);

                if (!acceptableStatus) {
                  response.data.destroy();
                  span.addEvent('Gateway returned unexpected status', {
                    'gateways.url': gatewayUrl,
                    'gateways.tier.priority': priority,
                    'gateways.request.path': path,
                    'http.status_code': response.status,
                    'http.expected_status': isRangedRequest
                      ? '200 or 206'
                      : '200',
                    'gateways.request.duration_ms': gatewayRequestDuration,
                  });
                  throw new Error(
                    `Unexpected status code from gateway: ${response.status}. Expected ${
                      isRangedRequest ? '200 or 206' : '200'
                    }.`,
                  );
                }

                // PE-9099: caller-supplied content-type predicate. Used by
                // callers that intend to parse the bytes as a specific
                // format (e.g., ANS-104 bundles) to refuse responses that
                // are obviously not that format — most notably the
                // `text/html` parking pages a legacy gateway's S3 cache
                // can hold from a 2024 outage of `gateway.bundlr.network`.
                // Reject + throw so the data-source chain falls through
                // to the next priority tier (and ultimately to chunks).
                if (acceptContentType !== undefined) {
                  const upstreamContentType = response.headers[
                    'content-type'
                  ] as string | undefined;
                  if (!acceptContentType(upstreamContentType)) {
                    response.data.destroy();
                    metrics.gatewayContentTypeRejectedTotal.inc({
                      gateway_url: gatewayUrl,
                      priority: String(priority),
                      content_type: upstreamContentType ?? 'unknown',
                    });
                    span.addEvent(
                      'Gateway response content-type rejected by caller',
                      {
                        'gateways.url': gatewayUrl,
                        'gateways.tier.priority': priority,
                        'gateways.request.path': path,
                        'http.content_type': upstreamContentType,
                      },
                    );
                    throw new Error(
                      `Gateway content-type "${upstreamContentType ?? '(none)'}" ` +
                        `rejected by caller predicate for ${id} ` +
                        `(likely poisoned upstream cache)`,
                    );
                  }
                }

                if (upstreamIgnoredRange) {
                  // Cap the prefix bandwidth we're willing to burn to
                  // slice locally. If region.offset exceeds the cap, the
                  // cost of pulling [0, region.offset) bytes from this
                  // upstream is too high — reject and let the data source
                  // chain fall through to the next priority tier.
                  if (region.offset > this.rangeAccept200MaxOffset) {
                    metrics.gatewayRangeIgnoredTotal.inc({
                      gateway_url: gatewayUrl,
                      priority: String(priority),
                      outcome: 'rejected_offset_too_high',
                    });
                    span.addEvent(
                      'Gateway returned full body for Range; rejected (offset above threshold)',
                      {
                        'gateways.url': gatewayUrl,
                        'gateways.tier.priority': priority,
                        'gateways.request.path': path,
                        'data.region.offset': region.offset,
                        'gateways.range_accept_200_max_offset':
                          this.rangeAccept200MaxOffset,
                      },
                    );
                    response.data.destroy();
                    throw new Error(
                      `Gateway returned full body for Range request but ` +
                        `region.offset (${region.offset}) exceeds ` +
                        `GATEWAYS_RANGE_ACCEPT_200_MAX_OFFSET ` +
                        `(${this.rangeAccept200MaxOffset}); refusing to ` +
                        `burn ${region.offset} prefix bytes for ${id}`,
                    );
                  }
                  metrics.gatewayRangeIgnoredTotal.inc({
                    gateway_url: gatewayUrl,
                    priority: String(priority),
                    outcome: 'sliced',
                  });
                  span.addEvent(
                    'Gateway returned full body for Range; sliced locally',
                    {
                      'gateways.url': gatewayUrl,
                      'gateways.tier.priority': priority,
                      'gateways.request.path': path,
                      'data.region.offset': region.offset,
                    },
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

                // PE-9081 / PE-9098: Content-Length validation depends on
                // which status the upstream chose:
                //  - 206: Content-Length is the partial body length and must
                //    match region.size exactly. Oversize is a leak path;
                //    undersize is silent truncation.
                //  - 200 with Range requested (upstreamIgnoredRange): the
                //    upstream sent the full body, so Content-Length is the
                //    total object size and must be large enough to contain
                //    the requested region. We'll slice it locally below.
                if (isRangedRequest && !upstreamIgnoredRange) {
                  if (contentLength !== region.size) {
                    stream.destroy();
                    throw new Error(
                      `Gateway Content-Length (${contentLength}) does not match ` +
                        `requested region size (${region.size}) for ${id}`,
                    );
                  }
                } else if (isRangedRequest && upstreamIgnoredRange) {
                  const requiredBytes = region.offset + region.size;
                  if (contentLength < requiredBytes) {
                    stream.destroy();
                    throw new Error(
                      `Gateway full body (${contentLength}) too small for ` +
                        `requested region [${region.offset}, ${requiredBytes}) for ${id}`,
                    );
                  }
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
                // Consumer-visible byte count. When `region` is set the
                // returned stream is always sliced to `region.size`
                // (regardless of whether upstream was 206 or 200-with-Range),
                // so contentLength would overcount for the sliced path.
                const emittedSize =
                  region !== undefined ? region.size : contentLength;

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
                    emittedSize,
                  );

                  metrics.getDataStreamSizeHistogram.observe(
                    {
                      class: this.constructor.name,
                      source: gatewayUrl,
                      request_type: requestType,
                    },
                    emittedSize,
                  );
                });

                // PE-9081 / PE-9098: hard-cap the consumer-visible byte
                // count when a region was requested. The slice offset
                // depends on what the upstream returned:
                //  - 206: stream starts at region.offset, slice (0, size).
                //  - 200 (upstreamIgnoredRange): stream is the full body
                //    starting at offset 0, slice (region.offset, size) to
                //    skip the prefix and stop at the right boundary.
                // ByteRangeTransform pushes null after `size` bytes
                // regardless of upstream behavior, and we destroy the
                // underlying socket on every termination path of the
                // cappedStream (end, close, error) so the upstream
                // connection is released promptly even when consumers
                // destroy the cappedStream early or it errors. `pipe()`
                // does not propagate destination termination back to the
                // source (per CodeRabbit review on PR #703).
                const cappedStream =
                  region !== undefined
                    ? stream.pipe(
                        new ByteRangeTransform(
                          upstreamIgnoredRange ? region.offset : 0,
                          region.size,
                        ),
                      )
                    : stream;

                if (region !== undefined && cappedStream !== stream) {
                  const destroyUpstream = () => {
                    if (!stream.destroyed) {
                      stream.destroy();
                    }
                  };
                  cappedStream.once('end', destroyUpstream);
                  cappedStream.once('close', destroyUpstream);
                  cappedStream.once('error', destroyUpstream);
                }

                return {
                  stream: cappedStream,
                  size: region !== undefined ? region.size : contentLength,
                  // 206 carries totalSize in the Content-Range header; on
                  // the 200-with-Range path Content-Length IS the total.
                  totalSize: upstreamIgnoredRange
                    ? contentLength
                    : parseContentRange(response.headers['content-range'])
                        ?.total,
                  verified: false,
                  trusted: gatewayTrusted,
                  sourceContentType: response.headers['content-type'],
                  cached: false,
                  requestAttributes: parseRequestAttributesHeaders({
                    headers: response.headers as { [key: string]: string },
                    currentHops: requestAttributesHeaders?.attributes.hops,
                  }),
                  upstreamTags: parseUpstreamTagHeaders(
                    response.headers as Record<string, string | string[]>,
                  ),
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
