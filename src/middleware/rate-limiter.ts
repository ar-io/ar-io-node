/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { SpanStatusCode } from '@opentelemetry/api';
import { Counter } from 'prom-client';
import { isIP } from 'is-ip';
import { tracer } from '../tracing.js';
import { TokenBucket, rlIoRedisClient } from '../lib/rate-limiter-valkey.js';
import log from '../log.js';
import * as env from '../lib/env.js';

const VALKEY_CACHE_TTL_SECONDS = 60 * 90; // 90 mins

const rateLimitExceededTotal = new Counter({
  name: 'rate_limit_exceeded_total',
  help: 'Total number of requests that exceeded rate limits',
  labelNames: ['limit_type', 'domain'],
});

const rateLimitRequestsTotal = new Counter({
  name: 'rate_limit_requests_total',
  help: 'Total number of requests processed by rate limiter',
  labelNames: ['domain'],
});

const rateLimitBytesBlockedTotal = new Counter({
  name: 'rate_limit_bytes_blocked_total',
  help: 'Total number of bytes that would have been served if not rate limited',
  labelNames: ['domain'],
});

const RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET = +env.varOrDefault(
  'RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET',
  '10000',
);
const RATE_LIMITER_RESOURCE_REFILL_PER_SEC = +env.varOrDefault(
  'RATE_LIMITER_RESOURCE_REFILL_PER_SEC',
  '100',
);
const RATE_LIMITER_IP_TOKENS_PER_BUCKET = +env.varOrDefault(
  'RATE_LIMITER_IP_TOKENS_PER_BUCKET',
  '2000',
);
const RATE_LIMITER_IP_REFILL_PER_SEC = +env.varOrDefault(
  'RATE_LIMITER_IP_REFILL_PER_SEC',
  '20',
);
const RATE_LIMITER_LIMITS_ENABLED =
  env.varOrDefault('RATE_LIMITER_LIMITS_ENABLED', 'false') === 'true';

const RATE_LIMITER_IP_ALLOWLIST =
  env
    .varOrUndefined('RATE_LIMITER_CIDR_ALLOWLIST')
    ?.split(',')
    .map((ip) => ip.trim().replace('/32', '')) ?? [];

function getCanonicalPath(req: Request) {
  // baseUrl is '' at the app root, so this concatenation works there too.
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  // Optionally normalize trailing slash (keep root '/')
  const normalized = full === '' ? '/' : full.replace(/\/{2,}/g, '/');
  // ensure path is not too long for redis key length limit
  const sliced = normalized.slice(0, 256);
  return sliced;
}

/**
 * Extract domain name from host header (without protocol, subdomain, or path)
 */
function extractDomain(host: string): string {
  if (!host) {
    return 'unknown';
  }

  // Remove port if present
  const hostWithoutPort = host.split(':')[0];

  if (isIP(hostWithoutPort)) {
    return 'unknown';
  }

  // Split by dots and take the last two parts for domain.com format
  const parts = hostWithoutPort.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostWithoutPort;
}

/**
 * Check if an IP is in the allowlist
 */
function isIpAllowlisted(ip: string): boolean {
  return RATE_LIMITER_IP_ALLOWLIST.includes(ip);
}

function getClientIP(req: Request): string | undefined {
  const header = req.headers['x-forwarded-for'];
  if (typeof header === 'string') {
    // Split by comma and trim spaces
    const ips = header.split(',').map((ip) => ip.trim());
    return ips[0];
  }
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  return req.ip || undefined;
}

function buildBucketKeys(
  method: string,
  path: string,
  ip: string,
  host: string,
): { resourceKey: string; ipKey: string } {
  const resourceTag = `rl:${method}:${host}:${path}`; // e.g. "rl:GET:arweave.net:/api/v1/foo"
  const ipTag = `rl:${host}`; // e.g. "rl:arweave.net"

  return {
    resourceKey: `{${resourceTag}}:resource`, // → "{rl:GET:arweave.net:/api/v1/foo}:resource"
    ipKey: `{${ipTag}}:ip:${ip}`, // → "{rl:arweave.net}:ip:203.0.113.42"
  };
}

/**
 * Get or create both buckets using separate operations to avoid CROSSSLOT errors
 */
async function getOrCreateBuckets(
  resourceKey: string,
  ipKey: string,
  resourceCapacity: number,
  resourceRefillRate: number,
  ipCapacity: number,
  ipRefillRate: number,
  domain: string,
): Promise<[TokenBucket, TokenBucket]> {
  const span = tracer.startSpan('rateLimiter.getOrCreateBuckets');
  span.setAttribute('resource_key', resourceKey);
  span.setAttribute('ip_key', ipKey);
  span.setAttribute('domain', domain);

  try {
    const now = Date.now();

    const [resourceBucketJson, ipBucketJson] = await Promise.all([
      rlIoRedisClient.getOrCreateBucket(
        resourceKey,
        resourceCapacity,
        resourceRefillRate,
        now,
        VALKEY_CACHE_TTL_SECONDS,
      ),
      rlIoRedisClient.getOrCreateBucket(
        ipKey,
        ipCapacity,
        ipRefillRate,
        now,
        VALKEY_CACHE_TTL_SECONDS,
      ),
    ]);

    const resourceBucket: TokenBucket = JSON.parse(resourceBucketJson);
    const ipBucket: TokenBucket = JSON.parse(ipBucketJson);

    span.setAttribute('resource_bucket.tokens', resourceBucket.tokens);
    span.setAttribute('ip_bucket.tokens', ipBucket.tokens);

    return [resourceBucket, ipBucket];
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });

    log.error('[rateLimiter] Error getting or creating buckets', { error });

    // Return default buckets in case of error
    const now = Date.now();
    return [
      {
        key: resourceKey,
        tokens: resourceCapacity,
        lastRefill: now,
        capacity: resourceCapacity,
        refillRate: resourceRefillRate,
      },
      {
        key: ipKey,
        tokens: ipCapacity,
        lastRefill: now,
        capacity: ipCapacity,
        refillRate: ipRefillRate,
      },
    ];
  } finally {
    span.end();
  }
}

/**
 * Rate limiter middleware factory
 */
export function rateLimiterMiddleware(): RequestHandler {
  const resourceCapacity = RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET;
  const resourceRefillRate = RATE_LIMITER_RESOURCE_REFILL_PER_SEC;
  const ipCapacity = RATE_LIMITER_IP_TOKENS_PER_BUCKET;
  const ipRefillRate = RATE_LIMITER_IP_REFILL_PER_SEC;

  // Return the middleware function
  return async (req: Request, res: Response, next: NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    const clientIp = getClientIP(req) || '0.0.0.0';
    const method = req.method;
    const canonicalPath = getCanonicalPath(req);
    const host = (req.headers.host ?? '').slice(0, 256);
    const domain = extractDomain(host);

    // Increment total requests counter for all requests processed by rate limiter
    rateLimitRequestsTotal.inc({ domain });

    // Check if IP is in allowlist - if so, skip rate limiting
    if (isIpAllowlisted(clientIp)) {
      return next();
    }

    // Create bucket keys
    const { resourceKey, ipKey } = buildBucketKeys(
      method,
      canonicalPath,
      clientIp,
      host,
    );

    // Track response size
    let responseSize = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    // Override write to track response size
    (res.write as (
      chunk: Buffer,
      encoding: BufferEncoding,
      cb?: ((err: Error | null | undefined) => void) | undefined,
    ) => boolean) = function (chunk, encodingOrCallback, callback) {
      responseSize += Buffer.byteLength(chunk);
      return originalWrite.call(res, chunk, encodingOrCallback, callback);
    };

    // Override end to track response size
    (res.end as unknown as (
      chunk: Buffer,
      encoding: BufferEncoding,
      cb?: (() => void) | undefined,
    ) => void) = function (chunk, encodingOrCallback, callback) {
      responseSize += Buffer.byteLength(chunk);
      return originalEnd.call(res, chunk, encodingOrCallback, callback);
    };

    // Declare rateLimitSpan in outer scope
    let rateLimitSpan: ReturnType<typeof tracer.startSpan> | undefined;

    try {
      // Create a span for the rate limiting check
      rateLimitSpan = tracer.startSpan('rateLimiter.checkLimits');
      rateLimitSpan.setAttribute('resource_key', resourceKey);
      rateLimitSpan.setAttribute('ip_key', ipKey);
      rateLimitSpan.setAttribute('domain', domain);

      // Get or create both buckets atomically
      rateLimitSpan.addEvent('Getting both buckets');
      const [resourceBucket, ipBucket] = await getOrCreateBuckets(
        resourceKey,
        ipKey,
        resourceCapacity,
        resourceRefillRate,
        ipCapacity,
        ipRefillRate,
        domain,
      );

      // Check if resource bucket has at least 1 token to allow the request
      rateLimitSpan.setAttribute(
        'resource_bucket.tokens',
        resourceBucket.tokens,
      );

      // Check if we can serve the request based on available tokens
      const hasInsufficientTokens = resourceBucket.tokens < 1;
      const hasKnownContentLength =
        typeof resourceBucket.contentLength === 'number';
      const contentLengthExceedsTokens =
        hasKnownContentLength &&
        Math.floor(resourceBucket.contentLength! / 1024) >
          resourceBucket.tokens;

      if (hasInsufficientTokens || contentLengthExceedsTokens) {
        rateLimitSpan.setAttribute('rate_limited', true);
        rateLimitSpan.setAttribute('rate_limit_type', 'resource');
        log.info(`[rateLimiter] Resource limit exceeded: ${resourceKey}`);
        rateLimitSpan.end();

        rateLimitExceededTotal.inc({ limit_type: 'resource', domain });
        // Track bytes that would have been served
        // if we know the content length
        if (hasKnownContentLength) {
          rateLimitBytesBlockedTotal.inc(
            { domain },
            resourceBucket.contentLength!,
          );
        }

        if (RATE_LIMITER_LIMITS_ENABLED) {
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Resource rate limit exceeded',
          });
        } else {
          next();
          return;
        }
      }

      // Check if IP bucket has at least 1 token to allow the request
      rateLimitSpan.setAttribute('ip_bucket.tokens', ipBucket.tokens);
      if (ipBucket.tokens < 1) {
        rateLimitSpan.setAttribute('rate_limited', true);
        rateLimitSpan.setAttribute('rate_limit_type', 'ip');
        log.info(`[rateLimiter] IP limit exceeded: ${ipKey}`);
        rateLimitSpan.end();

        rateLimitExceededTotal.inc({ limit_type: 'ip', domain });
        // Track bytes that would have been served
        // if we know the content length
        if (hasKnownContentLength) {
          rateLimitBytesBlockedTotal.inc(
            { domain },
            resourceBucket.contentLength!,
          );
        }

        if (RATE_LIMITER_LIMITS_ENABLED) {
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'IP rate limit exceeded',
          });
        } else {
          next();
          return;
        }
      }

      rateLimitSpan.setAttribute('rate_limited', false);
      rateLimitSpan.end();

      // Store buckets in request for response phase
      req.resourceBucket = resourceBucket;
      req.ipBucket = ipBucket;

      // Add response finish handler to consume tokens based on response size
      res.on('finish', async () => {
        // Declare consumeSpan in outer scope
        let consumeSpan: ReturnType<typeof tracer.startSpan> | undefined;

        try {
          // Create a span for token consumption
          consumeSpan = tracer.startSpan('rateLimiter.consumeTokens');

          // Calculate tokens to consume based on response size
          // Use 1 KB as the base unit (1 token = 1 KB)
          const tokensToConsume = Math.max(1, Math.ceil(responseSize / 1024));
          consumeSpan.setAttribute('tokens_to_consume', tokensToConsume);
          consumeSpan.setAttribute('response_size_bytes', responseSize);

          log.debug('[rateLimiter] Response size and tokens', {
            responseSize,
            tokensToConsume,
            resourceKey: req.resourceBucket?.key,
            ipKey: req.ipBucket?.key,
          });

          if (req.resourceBucket && req.ipBucket) {
            const now = Date.now();

            const [resourceTokensRemaining, ipTokensRemaining] =
              await Promise.all([
                rlIoRedisClient.consumeTokens(
                  req.resourceBucket.key,
                  tokensToConsume,
                  now,
                  VALKEY_CACHE_TTL_SECONDS,
                  responseSize, // contentLength - only for resource bucket
                ),
                rlIoRedisClient.consumeTokens(
                  req.ipBucket.key,
                  tokensToConsume,
                  now,
                  VALKEY_CACHE_TTL_SECONDS,
                  // No contentLength for IP bucket
                ),
              ]);

            consumeSpan.setAttribute(
              'resource_tokens_remaining',
              resourceTokensRemaining,
            );
            consumeSpan.setAttribute('ip_tokens_remaining', ipTokensRemaining);
          }
        } catch (error) {
          // Record error in span if it exists
          if (consumeSpan) {
            consumeSpan.recordException(error as Error);
            consumeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            consumeSpan.setAttribute('consume_tokens.error', true);
            consumeSpan.setAttribute(
              'consume_tokens.error_type',
              error instanceof Error ? error.constructor.name : 'UnknownError',
            );
            consumeSpan.setAttribute(
              'consume_tokens.response_size',
              responseSize,
            );
          }

          log.error(
            '[rateLimiter] Error consuming tokens based on response size',
            {
              error,
              responseSize,
            },
          );
        } finally {
          // Always end the span if it was created
          if (consumeSpan) {
            consumeSpan.end();
          }
        }
      });

      // Continue to next middleware
      next();
    } catch (error) {
      // Record error in span if it exists
      if (rateLimitSpan) {
        rateLimitSpan.recordException(error as Error);
        rateLimitSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        rateLimitSpan.setAttribute('rate_limiter.error', true);
        rateLimitSpan.setAttribute(
          'rate_limiter.error_type',
          error instanceof Error ? error.constructor.name : 'UnknownError',
        );
        rateLimitSpan.setAttribute('rate_limiter.resource_key', resourceKey);
        rateLimitSpan.setAttribute('rate_limiter.ip_key', ipKey);
        rateLimitSpan.end();
      }

      log.error('[rateLimiter] Error in rate limiter', {
        error,
      });
      // In case of error, allow the request to proceed
      next();
    } finally {
      // Always end the rateLimitSpan if it was created
      if (rateLimitSpan) {
        rateLimitSpan.end();
      }
    }
  };
}
