/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';

/**
 * Result of a rate limit check
 */
export interface RateLimitCheckResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Type of limit that was exceeded, if any */
  limitType?: 'ip' | 'resource' | 'unknown';
  /** Number of tokens consumed from IP bucket */
  ipTokensConsumed?: number;
  /** Number of x402 tokens consumed from IP bucket */
  ipX402TokensConsumed?: number;
  /** Number of regular tokens consumed from IP bucket */
  ipRegularTokensConsumed?: number;
  /** Number of tokens consumed from resource bucket */
  resourceTokensConsumed?: number;
  /** Number of x402 tokens consumed from resource bucket */
  resourceX402TokensConsumed?: number;
  /** Number of regular tokens consumed from resource bucket */
  resourceRegularTokensConsumed?: number;
}

/**
 * Context for token adjustment after response
 */
export interface TokenAdjustmentContext {
  /** The response size in bytes */
  responseSize: number;
  /** Initial tokens consumed from resource bucket */
  initialResourceTokens: number;
  /** Initial x402 tokens consumed from resource bucket */
  initialResourceX402Tokens: number;
  /** Initial regular tokens consumed from resource bucket */
  initialResourceRegularTokens: number;
  /** Initial tokens consumed from IP bucket */
  initialIpTokens: number;
  /** Initial x402 tokens consumed from IP bucket */
  initialIpX402Tokens: number;
  /** Initial regular tokens consumed from IP bucket */
  initialIpRegularTokens: number;
}

/**
 * Rate limiter interface for controlling request rate limits
 */
export interface RateLimiter {
  /**
   * Check if request is allowed and consume predicted tokens
   * @param req Express request object
   * @param res Express response object
   * @param predictedTokens Predicted number of tokens to consume
   * @param x402PaymentProvided Whether x402 payment was provided
   * @param contentLengthForTopOff Content length for bucket top-off (if payment provided)
   * @returns Promise<RateLimitCheckResult>
   */
  checkLimit(
    req: Request,
    res: Response,
    predictedTokens: number,
    x402PaymentProvided?: boolean,
    contentLengthForTopOff?: number,
  ): Promise<RateLimitCheckResult>;

  /**
   * Adjust tokens based on actual response size
   * @param req Express request object
   * @param context Token adjustment context with actual and initial sizes
   * @returns Promise<void>
   */
  adjustTokens(req: Request, context: TokenAdjustmentContext): Promise<void>;

  /**
   * Check if any IP in the chain is allowlisted
   * @param clientIps Array of client IP addresses from request
   * @returns boolean indicating if any IP is allowlisted
   */
  isAllowlisted(clientIps: string[]): boolean;
}
