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
      // Consume from the resource bucket first
      const resourceResult = await this.redisClient.getOrCreateBucketAndConsume(
        resourceKey,
        this.config.resourceCapacity,
        this.config.resourceRefillRate,
        now,
        this.config.cacheTtlSeconds,
        predictedTokens,
        x402PaymentProvided,
        this.config.capacityMultiplier,
        contentLengthForTopOff,
      );

      if (!resourceResult.success) {
        log.info('[RedisRateLimiter] Resource limit exceeded', {
          key: resourceKey,
          tokens: resourceResult.bucket.tokens,
          needed: predictedTokens,
        });

        return {
          allowed: false,
          limitType: 'resource',
          cachedContentLength: resourceResult.bucket.contentLength,
        };
      }

      // Calculate actual tokens needed from resource bucket's cached contentLength
      const actualTokensNeeded =
        resourceResult.bucket.contentLength != null &&
        resourceResult.bucket.contentLength > 0
          ? Math.max(1, Math.ceil(resourceResult.bucket.contentLength / 1024))
          : predictedTokens;

      // Consume from IP bucket
      const ipResult = await this.redisClient.getOrCreateBucketAndConsume(
        ipKey,
        this.config.ipCapacity,
        this.config.ipRefillRate,
        now,
        this.config.cacheTtlSeconds,
        actualTokensNeeded,
        x402PaymentProvided,
        this.config.capacityMultiplier,
        contentLengthForTopOff,
      );

      if (!ipResult.success) {
        log.info('[RedisRateLimiter] IP limit exceeded', {
          key: ipKey,
          tokens: ipResult.bucket.tokens,
          needed: actualTokensNeeded,
        });

        // Rollback: return tokens to resource bucket
        try {
          await this.redisClient.consumeTokens(
            resourceKey,
            -resourceResult.consumed,
            this.config.cacheTtlSeconds,
          );
        } catch (rollbackError) {
          log.error(
            '[RedisRateLimiter] Failed to rollback resource tokens after IP failure',
            {
              error: rollbackError,
              resourceKey,
              tokensToRollback: actualTokensNeeded,
            },
          );
        }

        return {
          allowed: false,
          limitType: 'ip',
          cachedContentLength: resourceResult.bucket.contentLength,
        };
      }

      // Store bucket keys and initial consumption in request for later adjustment
      (req as any).resourceBucketKey = resourceKey;
      (req as any).ipBucketKey = ipKey;
      (req as any).cachedContentLength = resourceResult.bucket.contentLength;

      return {
        allowed: true,
        resourceTokensConsumed: resourceResult.consumed,
        ipTokensConsumed: ipResult.consumed,
        cachedContentLength: resourceResult.bucket.contentLength,
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
    const resourceKey = (req as any).resourceBucketKey as string | undefined;
    const ipKey = (req as any).ipBucketKey as string | undefined;

    if (resourceKey === undefined || ipKey === undefined) {
      log.warn('[RedisRateLimiter] No bucket keys found for token adjustment');
      return;
    }

    // Calculate total tokens needed based on response size
    const totalTokensNeeded = Math.max(
      1,
      Math.ceil(context.responseSize / 1024),
    );
    const resourceTokenAdjustment =
      totalTokensNeeded - context.initialResourceTokens;
    const ipTokenAdjustment = totalTokensNeeded - context.initialIpTokens;

    log.debug('[RedisRateLimiter] Adjusting tokens', {
      responseSize: context.responseSize,
      totalTokensNeeded,
      resourceAdjustment: resourceTokenAdjustment,
      ipAdjustment: ipTokenAdjustment,
    });

    const adjustmentPromises: Promise<number>[] = [];
    const adjustmentLabels: string[] = [];

    // Adjust resource bucket and cache content length
    if (resourceTokenAdjustment !== 0) {
      adjustmentPromises.push(
        this.redisClient.consumeTokens(
          resourceKey,
          resourceTokenAdjustment,
          this.config.cacheTtlSeconds,
          context.responseSize, // Cache content length
        ),
      );
      adjustmentLabels.push('resource');
    }

    // Adjust IP bucket
    if (ipTokenAdjustment !== 0) {
      adjustmentPromises.push(
        this.redisClient.consumeTokens(
          ipKey,
          ipTokenAdjustment,
          this.config.cacheTtlSeconds,
        ),
      );
      adjustmentLabels.push('ip');
    }

    if (adjustmentPromises.length > 0) {
      try {
        const results = await Promise.allSettled(adjustmentPromises);

        results.forEach((result, index) => {
          const label = adjustmentLabels[index];
          if (result.status === 'rejected') {
            log.error('[RedisRateLimiter] Token adjustment failed for bucket', {
              label,
              error: result.reason,
            });
          }
        });

        log.debug('[RedisRateLimiter] Token adjustments completed', {
          adjustedBuckets: adjustmentLabels,
        });
      } catch (error) {
        log.error('[RedisRateLimiter] Error adjusting tokens', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
