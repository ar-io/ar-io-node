/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { SpanStatusCode } from '@opentelemetry/api';
import { isIP } from 'is-ip';
import { tracer } from '../tracing.js';
import {
  TokenBucket,
  RateLimiterRedisClient,
  getRateLimiterRedisClient,
} from '../lib/rate-limiter-redis.js';
import { extractAllClientIPs, isAnyIpAllowlisted } from '../lib/ip-utils.js';
import log from '../log.js';
import * as config from '../config.js';
import {
  rateLimitExceededTotal,
  rateLimitRequestsTotal,
  rateLimitBytesBlockedTotal,
} from '../metrics.js';
import { sendX402Response } from './x402.js';

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

function buildBucketKeys(
  method: string,
  path: string,
  ip: string,
  host: string,
): { resourceKey: string; ipKey: string } {
  const resourceTag = `rl:${method}:${host}:${path}`; // e.g. "rl:GET:arweave.net:/api/v1/foo"

  // NOTE: resourceKey and ipKey not intended to be used in multi-key operations together in clustered setups
  return {
    resourceKey: `{${resourceTag}}:resource`, // → "{rl:GET:arweave.net:/api/v1/foo}:resource"
    ipKey: `rl:ip:${ip}`, // → "rl:ip:203.0.113.42"
  };
}

/**
 * Get or create both buckets and consume predicted tokens atomically
 * Handles rollback if one bucket fails. Use separate operations to avoid
 * CROSSLOT errors in Redis Cluster mode.
 */
async function getOrCreateBucketsAndConsume(
  redisClient: RateLimiterRedisClient,
  resourceKey: string,
  ipKey: string,
  resourceCapacity: number,
  resourceRefillRate: number,
  ipCapacity: number,
  ipRefillRate: number,
  domain: string,
  cacheTtlSeconds: number,
  predictedTokens: number,
  x402PaymentProvided = false,
): Promise<{
  success: boolean;
  resourceBucket?: TokenBucket;
  ipBucket?: TokenBucket;
  failureType?: 'resource' | 'ip';
  // Tokens initially consumed from each bucket during the predictive phase
  resourceTokensConsumed?: number; // what was actually debited from resource bucket (predicted)
  ipTokensConsumed?: number; // what was actually debited from IP bucket (actual tokens needed)
  x402PaymentProvided?: boolean; // whether x402 payment was used
}> {
  const span = tracer.startSpan('rateLimiter.getOrCreateBucketsAndConsume');
  span.setAttributes({
    resource_key: resourceKey,
    ip_key: ipKey,
    domain: domain,
    predicted_tokens: predictedTokens,
  });

  try {
    const now = Date.now();

    // Consume from the resource bucket first since it may have a cached contentLength
    // that can be used to calculate actual tokens needed for the IP bucket
    const resourceResult = await redisClient.getOrCreateBucketAndConsume(
      resourceKey,
      resourceCapacity,
      resourceRefillRate,
      now,
      cacheTtlSeconds,
      predictedTokens,
      x402PaymentProvided,
    );

    span.setAttributes({
      'resource_bucket.tokens': resourceResult.bucket.tokens,
      'resource_bucket.consumed': resourceResult.consumed,
      'resource_bucket.success': resourceResult.success,
    });

    if (!resourceResult.success) {
      // Resource bucket has insufficient tokens
      span.setAttributes({ failure_reason: 'resource_insufficient_tokens' });
      return { success: false, failureType: 'resource' };
    }

    // Calculate actual tokens needed from resource bucket's cached contentLength
    const actualTokensNeeded =
      resourceResult.bucket.contentLength != null &&
      resourceResult.bucket.contentLength > 0
        ? Math.max(1, Math.ceil(resourceResult.bucket.contentLength / 1024))
        : predictedTokens;
    const ipResult = await redisClient.getOrCreateBucketAndConsume(
      ipKey,
      ipCapacity,
      ipRefillRate,
      now,
      cacheTtlSeconds,
      actualTokensNeeded,
      x402PaymentProvided,
    );

    span.setAttributes({
      'ip_bucket.tokens': ipResult.bucket.tokens,
      'ip_bucket.consumed': ipResult.consumed,
      'ip_bucket.success': ipResult.success,
    });

    if (!ipResult.success) {
      // IP bucket has insufficient tokens - need to rollback resource consumption
      span.setAttributes({
        failure_reason: 'ip_insufficient_tokens',
        rollback_needed: true,
      });

      try {
        // Rollback: return tokens to resource bucket (use actual consumed amount)
        await redisClient.consumeTokens(
          resourceKey,
          -resourceResult.consumed,
          cacheTtlSeconds,
        );
        span.setAttributes({ rollback_success: true });
      } catch (rollbackError) {
        span.recordException(rollbackError as Error);
        span.setAttributes({ rollback_success: false });
        log.error(
          '[rateLimiter] Failed to rollback resource tokens after IP failure',
          {
            error: rollbackError,
            resourceKey,
            tokensToRollback: actualTokensNeeded,
          },
        );
      }

      return { success: false, failureType: 'ip' };
    }

    // Both buckets succeeded
    return {
      success: true,
      resourceBucket: resourceResult.bucket,
      ipBucket: ipResult.bucket,
      resourceTokensConsumed: resourceResult.consumed,
      ipTokensConsumed: ipResult.consumed,
    };
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });

    log.error(
      '[rateLimiter] Error getting or creating buckets with consumption',
      { error },
    );
    return { success: false };
  } finally {
    span.end();
  }
}

/**
 * Rate limiter middleware factory
 */
export function rateLimiterMiddleware(options?: {
  resourceCapacity?: number;
  resourceRefillRate?: number;
  ipCapacity?: number;
  ipRefillRate?: number;
  cacheTtlSeconds?: number;
  limitsEnabled?: boolean;
  ipAllowlist?: string[];
  redisClient?: RateLimiterRedisClient; // Optional Redis client for dependency injection
}): RequestHandler {
  const resourceCapacity =
    options?.resourceCapacity ?? config.RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET;
  const resourceRefillRate =
    options?.resourceRefillRate ?? config.RATE_LIMITER_RESOURCE_REFILL_PER_SEC;
  const ipCapacity =
    options?.ipCapacity ?? config.RATE_LIMITER_IP_TOKENS_PER_BUCKET;
  const ipRefillRate =
    options?.ipRefillRate ?? config.RATE_LIMITER_IP_REFILL_PER_SEC;
  const cacheTtlSeconds =
    options?.cacheTtlSeconds ?? config.RATE_LIMITER_CACHE_TTL_SECONDS;
  const limitsEnabled = options?.limitsEnabled ?? config.ENABLE_RATE_LIMITER;
  const ipAllowlist =
    options?.ipAllowlist ?? config.RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST;
  const redisClient = options?.redisClient ?? getRateLimiterRedisClient();
  const x402Enabled = config.ENABLE_X_402_USDC_DATA_EGRESS;

  // Return the middleware function
  return async (req: Request, res: Response, next: NextFunction) => {
    // determine if x402 payment was made for this request
    const x402PaymentProvided = !!(req as any).x402Payment;

    // Extract all client IPs from headers and connection
    const { clientIp, clientIps } = extractAllClientIPs(req);
    const primaryClientIp = clientIp ?? '0.0.0.0';

    const method = req.method;
    const canonicalPath = getCanonicalPath(req);
    const host = (req.headers.host ?? '').slice(0, 256);
    const domain = extractDomain(host);

    // Increment total requests counter for all requests processed by rate limiter
    rateLimitRequestsTotal.inc({ domain });

    // Check if ANY IP in the chain is in allowlist - if so, skip rate limiting
    if (isAnyIpAllowlisted(clientIps, ipAllowlist)) {
      return next();
    }

    // Create bucket keys using primary client IP for consistency
    const { resourceKey, ipKey } = buildBucketKeys(
      method,
      canonicalPath,
      primaryClientIp,
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

    // Override end to track response size with proper overloads
    res.end = function end(
      chunk?: any,
      encodingOrCallback?: any,
      callback?: any,
    ) {
      if (chunk) {
        responseSize += Buffer.byteLength(chunk);
      }
      return originalEnd.call(res, chunk, encodingOrCallback, callback);
    } as typeof res.end;

    // Declare rateLimitSpan in outer scope
    let rateLimitSpan: ReturnType<typeof tracer.startSpan> | undefined;

    try {
      // Create a span for the rate limiting check
      rateLimitSpan = tracer.startSpan('rateLimiter.checkLimits');
      rateLimitSpan.setAttribute('resource_key', resourceKey);
      rateLimitSpan.setAttribute('ip_key', ipKey);
      rateLimitSpan.setAttribute('domain', domain);

      // We don't know the response size yet, so predict 1 token (1 KiB). If the
      // resource bucket has a cached contentLength, it will be used to calculate
      // and consume the actual tokens needed and return that value for use with the IP bucket.
      // TODO: in the future consider an in-memory cache of resource sizes to improve prediction
      const predictedTokens = 1;

      // Get or create both buckets and consume predicted tokens atomically
      rateLimitSpan.addEvent(
        'Getting both buckets and consuming predicted tokens',
      );
      const bucketsResult = await getOrCreateBucketsAndConsume(
        redisClient,
        resourceKey,
        ipKey,
        resourceCapacity,
        resourceRefillRate,
        ipCapacity,
        ipRefillRate,
        domain,
        cacheTtlSeconds,
        predictedTokens,
        x402PaymentProvided,
      );

      if (!bucketsResult.success) {
        rateLimitSpan.setAttribute('rate_limited', true);
        rateLimitSpan.setAttribute(
          'rate_limit_type',
          bucketsResult.failureType ?? 'unknown',
        );
        log.info(
          `[rateLimiter] ${bucketsResult.failureType === 'resource' ? 'Resource' : 'IP'} limit exceeded during atomic consumption`,
        );

        rateLimitExceededTotal.inc({
          limit_type: bucketsResult.failureType || 'unknown',
          domain,
        });

        // Track bytes that would have been served if we have cached contentLength
        if (
          bucketsResult.resourceBucket?.contentLength != null &&
          bucketsResult.resourceBucket.contentLength > 0
        ) {
          rateLimitBytesBlockedTotal.inc(
            { domain },
            bucketsResult.resourceBucket.contentLength,
          );
        }

        if (limitsEnabled) {
          // if x402 is enabled, then return 402 with payment attributes instead of a 429
          if (x402Enabled && x402PaymentProvided) {
            return sendX402Response({
              res,
              message: 'Payment required to access this resource',
              paymentRequirements: (req as any).x402Payment.paymentRequirements,
            });
          } else {
            return res.status(429).json({
              error: 'Too Many Requests',
              message:
                bucketsResult.failureType === 'resource'
                  ? 'Resource rate limit exceeded'
                  : 'IP rate limit exceeded',
            });
          }
        } else {
          next();
          return;
        }
      }

      // Both buckets had sufficient tokens and consumption succeeded
      rateLimitSpan.setAttribute(
        'resource_bucket.tokens',
        bucketsResult.resourceBucket!.tokens,
      );
      rateLimitSpan.setAttribute(
        'ip_bucket.tokens',
        bucketsResult.ipBucket!.tokens,
      );
      rateLimitSpan.setAttribute('predicted_tokens_consumed', predictedTokens);
      rateLimitSpan.setAttribute('rate_limited', false);

      // Store buckets in request for response phase
      req.resourceBucket = bucketsResult.resourceBucket!;
      req.ipBucket = bucketsResult.ipBucket!;

      // Store the initially consumed tokens for each bucket separately
      const initialResourceTokensConsumed =
        bucketsResult.resourceTokensConsumed ?? predictedTokens;
      const initialIpTokensConsumed =
        bucketsResult.ipTokensConsumed ?? predictedTokens;

      // Add response finish handler to consume tokens based on response size
      res.on('finish', async () => {
        // Declare consumeSpan in outer scope
        let consumeSpan: ReturnType<typeof tracer.startSpan> | undefined;

        try {
          // Create a span for token consumption
          consumeSpan = tracer.startSpan('rateLimiter.consumeTokens');

          // Calculate total tokens needed based on response size
          // Use 1 KB as the base unit (1 token = 1 KB), minimum 1 token per request
          const totalTokensNeeded = Math.max(1, Math.ceil(responseSize / 1024));
          const resourceTokenAdjustment =
            totalTokensNeeded - initialResourceTokensConsumed;
          const ipTokenAdjustment = totalTokensNeeded - initialIpTokensConsumed;

          consumeSpan.setAttribute('total_tokens_needed', totalTokensNeeded);
          consumeSpan.setAttribute(
            'initial_resource_tokens_consumed',
            initialResourceTokensConsumed,
          );
          consumeSpan.setAttribute(
            'initial_ip_tokens_consumed',
            initialIpTokensConsumed,
          );
          consumeSpan.setAttribute(
            'resource_token_adjustment',
            resourceTokenAdjustment,
          );
          consumeSpan.setAttribute('ip_token_adjustment', ipTokenAdjustment);
          consumeSpan.setAttribute('response_size_bytes', responseSize);

          log.debug(
            '[rateLimiter] Response size and per-bucket token adjustment',
            {
              responseSize,
              totalTokensNeeded,
              initialResourceTokensConsumed,
              initialIpTokensConsumed,
              resourceTokenAdjustment,
              ipTokenAdjustment,
              resourceBucket: {
                key: req.resourceBucket?.key,
                tokens: req.resourceBucket?.tokens,
                lastRefill: req.resourceBucket?.lastRefill,
              },
              ipBucket: {
                key: req.ipBucket?.key,
                tokens: req.ipBucket?.tokens,
                lastRefill: req.ipBucket?.lastRefill,
              },
            },
          );

          // Only adjust tokens if there's a difference per bucket and buckets exist
          const adjustmentPromises: Promise<number>[] = [];
          const adjustmentLabels: string[] = [];

          if (resourceTokenAdjustment !== 0 && req.resourceBucket) {
            adjustmentPromises.push(
              redisClient.consumeTokens(
                req.resourceBucket.key,
                resourceTokenAdjustment,
                cacheTtlSeconds,
                responseSize, // contentLength - only for resource bucket
              ),
            );
            adjustmentLabels.push('resource');
          }

          if (ipTokenAdjustment !== 0 && req.ipBucket) {
            adjustmentPromises.push(
              redisClient.consumeTokens(
                req.ipBucket.key,
                ipTokenAdjustment,
                cacheTtlSeconds,
                // No contentLength for IP bucket
              ),
            );
            adjustmentLabels.push('ip');
          }

          if (adjustmentPromises.length > 0) {
            // Execute adjustments allowing partial failures
            const settlements = await Promise.allSettled(adjustmentPromises);

            const adjustmentDetails: Record<string, any> = {};
            let failures = 0;
            let successes = 0;

            adjustmentLabels.forEach((label, index) => {
              const settlement = settlements[index];
              const bucket =
                label === 'resource' ? req.resourceBucket : req.ipBucket;
              const tokensBefore = bucket?.tokens ?? 0;

              if (settlement.status === 'fulfilled') {
                successes++;
                const tokensAfter = settlement.value;
                const perBucketAdjustment =
                  label === 'resource'
                    ? resourceTokenAdjustment
                    : ipTokenAdjustment;
                adjustmentDetails[`${label}Bucket`] = {
                  key: bucket?.key,
                  tokensBeforeAdjustment: tokensBefore,
                  tokensDeducted: perBucketAdjustment,
                  tokensAfterAdjustment: tokensAfter,
                  tokensConsumedTotal: tokensBefore - tokensAfter,
                  capacity: bucket?.capacity,
                  utilizationPercent:
                    bucket?.capacity != null && bucket.capacity > 0
                      ? Math.round(
                          ((bucket.capacity - tokensAfter) / bucket.capacity) *
                            100,
                        )
                      : 0,
                  status: 'fulfilled',
                };
                consumeSpan?.setAttribute(
                  `${label}_tokens_remaining`,
                  tokensAfter,
                );
              } else {
                failures++;
                const error = settlement.reason;
                const perBucketAdjustment =
                  label === 'resource'
                    ? resourceTokenAdjustment
                    : ipTokenAdjustment;
                adjustmentDetails[`${label}Bucket`] = {
                  key: bucket?.key,
                  tokensBeforeAdjustment: tokensBefore,
                  tokensDeducted: perBucketAdjustment,
                  tokensAfterAdjustment: null,
                  capacity: bucket?.capacity,
                  status: 'rejected',
                  errorName: error?.name,
                  errorMessage: error?.message ?? String(error),
                };
                log.error('[rateLimiter] Token adjustment failed for bucket', {
                  label,
                  error,
                  key: bucket?.key,
                  resourceTokenAdjustment,
                  ipTokenAdjustment,
                });
                consumeSpan?.setAttribute(`${label}_adjustment_failed`, true);
                consumeSpan?.setAttribute(
                  `${label}_adjustment_error_type`,
                  error?.constructor?.name || 'UnknownError',
                );
              }
            });

            log.debug('[rateLimiter] Token adjustments completed', {
              totalAdjustments: adjustmentPromises.length,
              successes,
              failures,
              adjustedBuckets: adjustmentLabels,
              ...adjustmentDetails,
            });

            consumeSpan?.setAttribute(
              'adjustments_total',
              adjustmentPromises.length,
            );
            consumeSpan?.setAttribute('adjustments_failed', failures);
            consumeSpan?.setAttribute('adjustments_succeeded', successes);
          } else {
            consumeSpan.setAttribute('token_adjustment_skipped', true);
            const bothZero =
              resourceTokenAdjustment === 0 && ipTokenAdjustment === 0;
            consumeSpan.setAttribute(
              'adjustment_reason',
              bothZero ? 'perfect_consumption' : 'missing_buckets',
            );
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
