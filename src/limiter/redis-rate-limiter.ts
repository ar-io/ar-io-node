/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import {
  getRateLimiterRedisClient,
  RateLimiterRedisClient,
} from '../lib/rate-limiter-redis.js';
import { isAnyIpAllowlisted } from '../lib/ip-utils.js';
import log from '../log.js';
import {
  RateLimiter,
  RateLimitCheckResult,
  TokenAdjustmentContext,
} from './types.js';
import { rateLimitTokensConsumedTotal } from '../metrics.js';

/**
 * Configuration options for Redis rate limiter
 */
export interface RedisRateLimiterConfig {
  resourceCapacity: number;
  resourceRefillRate: number;
  ipCapacity: number;
  ipRefillRate: number;
  cacheTtlSeconds: number;
  limitsEnabled: boolean;
  ipAllowlist: string[];
  capacityMultiplier: number; // Multiplier for x402 payments
  redisClient?: RateLimiterRedisClient; // Optional for dependency injection
}

/**
 * Redis-based rate limiter implementation
 * Suitable for distributed deployments and production environments
 */
export class RedisRateLimiter implements RateLimiter {
  private config: RedisRateLimiterConfig;
  private redisClient: RateLimiterRedisClient;

  constructor(config: RedisRateLimiterConfig) {
    this.config = config;
    this.redisClient = config.redisClient ?? getRateLimiterRedisClient();
  }

  /**
   * Get canonical path from request
   */
  private getCanonicalPath(req: Request): string {
    const full = `${req.baseUrl || ''}${req.path || ''}`;
    const normalized = full === '' ? '/' : full.replace(/\/{2,}/g, '/');
    return normalized.slice(0, 256);
  }

  /**
   * Build bucket keys for resource and IP
   */
  private buildBucketKeys(
    method: string,
    path: string,
    ip: string,
    host: string,
  ): { resourceKey: string; ipKey: string } {
    const resourceTag = `rl:${method}:${host}:${path}`;
    return {
      resourceKey: `{${resourceTag}}:resource`,
      ipKey: `rl:ip:${ip}`,
    };
  }

  /**
   * Check IP allowlist
   */
  public isAllowlisted(clientIps: string[]): boolean {
    return isAnyIpAllowlisted(clientIps, this.config.ipAllowlist);
  }

  /**
   * Check rate limit and consume predicted tokens
   */
  public async checkLimit(
    req: Request,
    _res: Response,
    predictedTokens: number,
    x402PaymentProvided = false,
    contentLengthForTopOff = 0,
  ): Promise<RateLimitCheckResult> {
    const method = req.method;
    const canonicalPath = this.getCanonicalPath(req);
    const host = (req.headers.host ?? '').slice(0, 256);
    const primaryClientIp = req.ip ?? '0.0.0.0';

    const { resourceKey, ipKey } = this.buildBucketKeys(
      method,
      canonicalPath,
      primaryClientIp,
      host,
    );

    const now = Date.now();

    try {
      // Consume from IP bucket first - this is the primary rate limit
      const ipResult = await this.redisClient.getOrCreateBucketAndConsume(
        ipKey,
        this.config.ipCapacity,
        this.config.ipRefillRate,
        now,
        this.config.cacheTtlSeconds,
        predictedTokens,
        x402PaymentProvided,
        this.config.capacityMultiplier,
        contentLengthForTopOff,
      );

      if (!ipResult.success) {
        log.info('[RedisRateLimiter] IP limit exceeded', {
          key: ipKey,
          tokens: ipResult.bucket.tokens,
          needed: predictedTokens,
        });

        return {
          allowed: false,
          limitType: 'ip',
        };
      }

      // Store bucket key and initial consumption in request for later adjustment
      (req as any).ipBucketKey = ipKey;

      // Check resource bucket ONLY if no paid tokens were consumed for this request
      // (consuming paid tokens grants bypass of per-resource limits)
      if (ipResult.paidConsumed === 0) {
        const resourceResult =
          await this.redisClient.getOrCreateBucketAndConsume(
            resourceKey,
            this.config.resourceCapacity,
            this.config.resourceRefillRate,
            now,
            this.config.cacheTtlSeconds,
            predictedTokens,
            false, // Never apply payment to resource buckets
            this.config.capacityMultiplier,
            0,
          );

        if (!resourceResult.success) {
          // Resource limit exceeded - refund IP tokens and deny
          const totalConsumed =
            ipResult.regularConsumed + ipResult.paidConsumed;
          if (totalConsumed > 0) {
            try {
              await this.redisClient.consumeTokens(
                ipKey,
                -totalConsumed, // Negative to refund (returns to regular pool)
                this.config.cacheTtlSeconds,
              );
            } catch (refundError) {
              log.error('[RedisRateLimiter] Failed to refund IP tokens', {
                error:
                  refundError instanceof Error
                    ? refundError.message
                    : String(refundError),
                ipKey,
                totalRefunded: totalConsumed,
                regularConsumed: ipResult.regularConsumed,
                paidConsumed: ipResult.paidConsumed,
              });
            }
          }

          log.info('[RedisRateLimiter] Resource limit exceeded', {
            key: resourceKey,
            tokens: resourceResult.bucket.tokens,
            needed: predictedTokens,
            refunded: totalConsumed,
            regularConsumed: ipResult.regularConsumed,
            paidConsumed: ipResult.paidConsumed,
          });

          return {
            allowed: false,
            limitType: 'resource',
          };
        }

        // Resource check passed - store key for later adjustment
        (req as any).resourceBucketKey = resourceKey;

        return {
          allowed: true,
          ipTokensConsumed: ipResult.consumed,
          ipPaidTokensConsumed: ipResult.paidConsumed,
          ipRegularTokensConsumed: ipResult.regularConsumed,
          resourceTokensConsumed: resourceResult.consumed,
          resourcePaidTokensConsumed: resourceResult.paidConsumed,
          resourceRegularTokensConsumed: resourceResult.regularConsumed,
        };
      }

      // Paid request - skip resource check
      return {
        allowed: true,
        ipTokensConsumed: ipResult.consumed,
        ipPaidTokensConsumed: ipResult.paidConsumed,
        ipRegularTokensConsumed: ipResult.regularConsumed,
      };
    } catch (error) {
      log.error('[RedisRateLimiter] Error checking rate limit', {
        error: error instanceof Error ? error.message : String(error),
        resourceKey,
        ipKey,
      });

      // On error, allow the request to proceed
      return {
        allowed: true,
      };
    }
  }

  /**
   * Adjust tokens based on actual response size
   */
  public async adjustTokens(
    req: Request,
    context: TokenAdjustmentContext,
  ): Promise<void> {
    const ipKey = (req as any).ipBucketKey as string | undefined;
    const resourceKey = (req as any).resourceBucketKey as string | undefined;

    if (ipKey === undefined) {
      log.warn(
        '[RedisRateLimiter] No IP bucket key found for token adjustment',
      );
      return;
    }

    // Calculate total tokens needed based on response size
    const totalTokensNeeded = Math.max(
      1,
      Math.ceil(context.responseSize / 1024),
    );
    const ipTokenAdjustment = totalTokensNeeded - context.initialIpTokens;
    const resourceTokenAdjustment =
      resourceKey !== undefined
        ? totalTokensNeeded - context.initialResourceTokens
        : 0;

    log.debug('[RedisRateLimiter] Adjusting tokens', {
      responseSize: context.responseSize,
      totalTokensNeeded,
      ipAdjustment: ipTokenAdjustment,
      resourceAdjustment: resourceTokenAdjustment,
    });

    // Adjust IP bucket
    if (ipTokenAdjustment !== 0) {
      try {
        const ipAdjustResult = await this.redisClient.consumeTokens(
          ipKey,
          ipTokenAdjustment,
          this.config.cacheTtlSeconds,
        );

        // Track metrics - only increment for positive, finite values
        if (
          Number.isFinite(ipAdjustResult.paidConsumed) &&
          ipAdjustResult.paidConsumed > 0
        ) {
          rateLimitTokensConsumedTotal.inc(
            {
              bucket_type: 'ip',
              token_type: 'paid',
              domain: context.domain,
            },
            ipAdjustResult.paidConsumed,
          );
        }

        if (
          Number.isFinite(ipAdjustResult.regularConsumed) &&
          ipAdjustResult.regularConsumed > 0
        ) {
          rateLimitTokensConsumedTotal.inc(
            {
              bucket_type: 'ip',
              token_type: 'regular',
              domain: context.domain,
            },
            ipAdjustResult.regularConsumed,
          );
        }

        // Log warning if partial consumption occurred
        if (!ipAdjustResult.success) {
          log.warn(
            '[RedisRateLimiter] Partial token consumption - insufficient paid tokens',
            {
              bucket: 'ip',
              requested: ipTokenAdjustment,
              consumed: ipAdjustResult.consumed,
              paidConsumed: ipAdjustResult.paidConsumed,
              regularConsumed: ipAdjustResult.regularConsumed,
              after: {
                regular: ipAdjustResult.bucket.tokens,
                paid: ipAdjustResult.bucket.paidTokens,
              },
            },
          );
        }

        log.debug('[RedisRateLimiter] Token adjustment completed', {
          bucket: 'ip',
          adjustment: ipTokenAdjustment,
          consumed: {
            paid: ipAdjustResult.paidConsumed,
            regular: ipAdjustResult.regularConsumed,
          },
          after: {
            regular: ipAdjustResult.bucket.tokens,
            paid: ipAdjustResult.bucket.paidTokens,
          },
          success: ipAdjustResult.success,
        });
      } catch (error) {
        log.error('[RedisRateLimiter] IP token adjustment failed', {
          error: error instanceof Error ? error.message : String(error),
          ipKey,
        });
      }
    }

    // Adjust resource bucket if it was checked
    if (resourceKey !== undefined && resourceTokenAdjustment !== 0) {
      try {
        const resourceAdjustResult = await this.redisClient.consumeTokens(
          resourceKey,
          resourceTokenAdjustment,
          this.config.cacheTtlSeconds,
        );

        // Track metrics - only increment for positive, finite values
        if (
          Number.isFinite(resourceAdjustResult.paidConsumed) &&
          resourceAdjustResult.paidConsumed > 0
        ) {
          rateLimitTokensConsumedTotal.inc(
            {
              bucket_type: 'resource',
              token_type: 'paid',
              domain: context.domain,
            },
            resourceAdjustResult.paidConsumed,
          );
        }

        if (
          Number.isFinite(resourceAdjustResult.regularConsumed) &&
          resourceAdjustResult.regularConsumed > 0
        ) {
          rateLimitTokensConsumedTotal.inc(
            {
              bucket_type: 'resource',
              token_type: 'regular',
              domain: context.domain,
            },
            resourceAdjustResult.regularConsumed,
          );
        }

        // Log warning if partial consumption occurred
        if (!resourceAdjustResult.success) {
          log.warn(
            '[RedisRateLimiter] Partial token consumption - insufficient paid tokens',
            {
              bucket: 'resource',
              requested: resourceTokenAdjustment,
              consumed: resourceAdjustResult.consumed,
              paidConsumed: resourceAdjustResult.paidConsumed,
              regularConsumed: resourceAdjustResult.regularConsumed,
              after: {
                regular: resourceAdjustResult.bucket.tokens,
                paid: resourceAdjustResult.bucket.paidTokens,
              },
            },
          );
        }

        log.debug('[RedisRateLimiter] Token adjustment completed', {
          bucket: 'resource',
          adjustment: resourceTokenAdjustment,
          consumed: {
            paid: resourceAdjustResult.paidConsumed,
            regular: resourceAdjustResult.regularConsumed,
          },
          after: {
            regular: resourceAdjustResult.bucket.tokens,
            paid: resourceAdjustResult.bucket.paidTokens,
          },
          success: resourceAdjustResult.success,
        });
      } catch (error) {
        log.error('[RedisRateLimiter] Resource token adjustment failed', {
          error: error instanceof Error ? error.message : String(error),
          resourceKey,
        });
      }
    }
  }

  /**
   * Top off bucket with paid tokens directly (for payment-based top-off)
   */
  public async topOffPaidTokens(req: Request, tokens: number): Promise<void> {
    const method = req.method;
    const canonicalPath = this.getCanonicalPath(req);
    const host = (req.headers.host ?? '').slice(0, 256);
    const primaryClientIp = req.ip ?? '0.0.0.0';

    const { ipKey } = this.buildBucketKeys(
      method,
      canonicalPath,
      primaryClientIp,
      host,
    );

    const now = Date.now();

    try {
      // Apply capacity multiplier to match topOffBucket behavior
      const tokensWithMultiplier = tokens * this.config.capacityMultiplier;

      const result = await this.redisClient.addPaidTokens(
        ipKey,
        this.config.ipCapacity,
        this.config.ipRefillRate,
        now,
        this.config.cacheTtlSeconds,
        tokensWithMultiplier,
      );

      log.debug('[RedisRateLimiter] Topped off bucket with paid tokens', {
        key: ipKey,
        tokensInput: tokens,
        capacityMultiplier: this.config.capacityMultiplier,
        paidTokensAdded: tokensWithMultiplier,
        totalPaidTokens: result.bucket.paidTokens,
      });
    } catch (error) {
      log.error('[RedisRateLimiter] Failed to top off paid tokens', {
        error: error instanceof Error ? error.message : String(error),
        ipKey,
      });
    }
  }
}
