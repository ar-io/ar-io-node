/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { Span } from '@opentelemetry/api';
import rangeParser from 'range-parser';
import log from '../log.js';
import * as config from '../config.js';
import { startChildSpan } from '../tracing.js';
import { extractAllClientIPs } from '../lib/ip-utils.js';
import {
  rateLimitExceededTotal,
  rateLimitRequestsTotal,
  rateLimitBytesBlockedTotal,
} from '../metrics.js';
import { ContiguousDataAttributes, RequestAttributes } from '../types.js';
import { RateLimiter } from '../limiter/types.js';
import {
  PaymentProcessor,
  PaymentRequirementsContext,
} from '../payments/types.js';

/**
 * Parameters for checking payment and rate limits
 */
export interface CheckPaymentAndRateLimitsParams {
  req: Request;
  res: Response;
  id: string;
  dataAttributes: ContiguousDataAttributes | undefined;
  requestAttributes: RequestAttributes;
  rangeHeader?: string;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor | undefined;
  parentSpan?: Span;
}

/**
 * Result from checking payment and rate limits
 */
export interface CheckPaymentAndRateLimitsResult {
  allowed: boolean;
  ipTokensConsumed?: number;
  ipX402TokensConsumed?: number;
  ipRegularTokensConsumed?: number;
  resourceTokensConsumed?: number;
  resourceX402TokensConsumed?: number;
  resourceRegularTokensConsumed?: number;
  paymentVerified?: boolean;
  paymentSettled?: boolean;
}

/**
 * Parameters for adjusting rate limit tokens after response
 */
export interface AdjustRateLimitTokensParams {
  req: Request;
  responseSize: number;
  initialResult: CheckPaymentAndRateLimitsResult;
  rateLimiter?: RateLimiter;
}

/**
 * Calculate the exact content size accounting for range requests
 */
function calculateContentSize(
  dataAttributes: ContiguousDataAttributes,
  rangeHeader?: string,
): number {
  if (rangeHeader === undefined) {
    return dataAttributes.size; // Full content
  }

  const ranges = rangeParser(dataAttributes.size, rangeHeader);

  // Malformed or unsatisfiable range - charge for full content
  if (ranges === -1 || ranges === -2 || ranges.type !== 'bytes') {
    return dataAttributes.size;
  }

  // Calculate total bytes across all ranges
  return ranges.reduce(
    (total, range) => total + (range.end - range.start + 1),
    0,
  );
}

/**
 * Main integration function - checks payment and rate limits before streaming data
 *
 * This function should be called AFTER:
 * - Manifest resolution (so we know the actual resolved data ID and size)
 * - Range request parsing (so we know the exact bytes being requested)
 *
 * And BEFORE:
 * - Streaming data to the client
 */
export async function checkPaymentAndRateLimits({
  req,
  res,
  id,
  dataAttributes,
  requestAttributes: _requestAttributes,
  rangeHeader,
  rateLimiter,
  paymentProcessor,
  parentSpan,
}: CheckPaymentAndRateLimitsParams): Promise<CheckPaymentAndRateLimitsResult> {
  const span = startChildSpan(
    'checkPaymentAndRateLimits',
    {
      attributes: {
        'data.id': id,
        'data.size': dataAttributes?.size,
        'data.has_range': rangeHeader !== undefined,
      },
    },
    parentSpan,
  );

  try {
    // Extract all client IPs for allowlist checking
    const { clientIps } = extractAllClientIPs(req);

    // Check if ANY IP in the chain is allowlisted - if so, skip all checks
    if (rateLimiter?.isAllowlisted(clientIps)) {
      span.setAttribute('allowlisted', true);
      log.debug('[DataHandler] Client is allowlisted, skipping checks', {
        id,
        clientIps,
      });
      return { allowed: true };
    }

    // Track request for metrics
    const host = req.headers.host ?? '';
    const domain = extractDomain(host);
    rateLimitRequestsTotal.inc({ domain });

    // Skip checks if we don't have data attributes (can't calculate size)
    if (dataAttributes === undefined) {
      span.setAttribute('skip_reason', 'no_data_attributes');
      log.debug('[DataHandler] No data attributes, skipping checks', { id });
      return { allowed: true };
    }

    // Calculate exact content size (accounting for range requests)
    const contentSize = calculateContentSize(dataAttributes, rangeHeader);
    span.setAttribute('content_size', contentSize);

    let paymentVerified = false;
    let paymentSettled = false;

    // === PAYMENT VERIFICATION ===
    if (paymentProcessor !== undefined) {
      span.addEvent('Checking payment');
      const paymentSpan = startChildSpan(
        'verifyPayment',
        {
          attributes: {
            'data.id': id,
            'content.size': contentSize,
          },
        },
        span,
      );

      try {
        // Calculate payment requirements based on actual content size
        const requirements = paymentProcessor.calculateRequirements({
          contentSize,
          protocol: req.protocol,
          host: host,
          originalUrl: req.originalUrl,
          contentType: dataAttributes.contentType ?? 'application/octet-stream',
        } as PaymentRequirementsContext);

        paymentSpan.setAttribute(
          'payment.price',
          requirements.maxAmountRequired,
        );

        // Extract payment from request headers
        const payment = paymentProcessor.extractPayment(req);

        if (payment === undefined) {
          // No payment provided - continue to rate limiter
          paymentSpan.setAttribute('payment.provided', false);
          log.debug('[DataHandler] No payment provided', { id });
        } else {
          // Verify payment
          paymentSpan.setAttribute('payment.provided', true);
          const verifyResult = await paymentProcessor.verifyPayment(
            payment,
            requirements,
          );

          if (!verifyResult.isValid) {
            // Payment verification failed
            paymentSpan.setAttribute('payment.verified', false);
            paymentSpan.setAttribute(
              'payment.invalid_reason',
              verifyResult.invalidReason ?? 'unknown',
            );
            log.warn('[DataHandler] Payment verification failed', {
              id,
              reason: verifyResult.invalidReason,
            });

            paymentProcessor.sendPaymentRequiredResponse(
              req,
              res,
              requirements,
              {
                error: 'payment_verification_failed',
                message: verifyResult.invalidReason ?? 'Invalid payment',
                payer: verifyResult.payer,
              },
            );

            return { allowed: false };
          }

          // Payment verified - attempt settlement
          paymentSpan.setAttribute('payment.verified', true);
          paymentVerified = true;

          const settlementResult = await paymentProcessor.settlePayment(
            payment,
            requirements,
          );

          if (!settlementResult.success) {
            // Settlement failed
            paymentSpan.setAttribute('payment.settled', false);
            paymentSpan.setAttribute(
              'payment.settlement_error',
              settlementResult.errorReason ?? 'unknown',
            );
            log.error('[DataHandler] Payment settlement failed', {
              id,
              error: settlementResult.errorReason,
            });

            // Set settlement response header if available
            if (settlementResult.responseHeader !== undefined) {
              res.setHeader(
                'X-Payment-Response',
                settlementResult.responseHeader,
              );
            }

            paymentProcessor.sendPaymentRequiredResponse(
              req,
              res,
              requirements,
              {
                error: 'payment_settlement_failed',
                message: settlementResult.errorReason ?? 'Settlement failed',
              },
            );

            return { allowed: false };
          }

          // Payment settled successfully
          paymentSpan.setAttribute('payment.settled', true);
          paymentSettled = true;

          // Set settlement response header
          if (settlementResult.responseHeader !== undefined) {
            res.setHeader(
              'X-Payment-Response',
              settlementResult.responseHeader,
            );
          }

          log.info('[DataHandler] Payment verified and settled', { id });
        }
      } catch (error: any) {
        paymentSpan.recordException(error);
        log.error('[DataHandler] Error during payment processing', {
          id,
          error: error.message,
          stack: error.stack,
        });
        // On payment error, allow request to proceed to rate limiter
      } finally {
        paymentSpan.end();
      }
    }

    // === RATE LIMITING ===
    if (rateLimiter !== undefined) {
      span.addEvent('Checking rate limits');
      const rateLimitSpan = startChildSpan(
        'checkRateLimits',
        {
          attributes: {
            'data.id': id,
            'content.size': contentSize,
            'payment.verified': paymentVerified,
          },
        },
        span,
      );

      try {
        // Predict tokens (1 token = 1 KB)
        const predictedTokens = Math.max(1, Math.ceil(contentSize / 1024));
        rateLimitSpan.setAttribute('predicted_tokens', predictedTokens);

        // Calculate content length for top-off if payment was verified
        // Cap at max price to ensure proportional bucket increase
        const contentLengthForTopOff = paymentVerified ? contentSize : 0;

        // Check limits
        const limitResult = await rateLimiter.checkLimit(
          req,
          res,
          predictedTokens,
          paymentVerified,
          contentLengthForTopOff,
        );

        rateLimitSpan.setAttribute('rate_limit.allowed', limitResult.allowed);

        if (!limitResult.allowed) {
          // Rate limit exceeded
          rateLimitSpan.setAttribute(
            'rate_limit.limit_type',
            limitResult.limitType ?? 'unknown',
          );

          log.info('[DataHandler] Rate limit exceeded', {
            id,
            limitType: limitResult.limitType,
          });

          rateLimitExceededTotal.inc({
            limit_type: limitResult.limitType ?? 'unknown',
            domain,
          });

          // Track bytes blocked
          rateLimitBytesBlockedTotal.inc({ domain }, contentSize);

          if (config.ENABLE_RATE_LIMITER) {
            // If payment processor exists and payment not verified, return 402
            if (
              paymentProcessor !== undefined &&
              !paymentVerified &&
              dataAttributes !== undefined
            ) {
              const requirements = paymentProcessor.calculateRequirements({
                contentSize,
                protocol: req.protocol,
                host: host,
                originalUrl: req.originalUrl,
                contentType:
                  dataAttributes.contentType ?? 'application/octet-stream',
              } as PaymentRequirementsContext);

              paymentProcessor.sendPaymentRequiredResponse(
                req,
                res,
                requirements,
                {
                  message: 'Payment required to access this resource',
                },
              );
            } else {
              // Return 429 rate limit exceeded
              res.status(429).json({
                error: 'Too Many Requests',
                message: 'IP rate limit exceeded',
              });
            }

            return { allowed: false };
          }
        }

        // Rate limit check passed
        // Check if redirect mode should be used (for browser paywall after payment)
        // This must happen AFTER rate limiter tops off buckets
        if (
          paymentProcessor !== undefined &&
          paymentVerified &&
          paymentProcessor.shouldUseRedirectMode(req)
        ) {
          rateLimitSpan.setAttribute('payment.redirect_mode', true);
          log.debug('[DataHandler] Using redirect mode after payment', { id });
          paymentProcessor.sendRedirectResponse(req, res);
          return { allowed: false }; // Request handled via redirect
        }

        return {
          allowed: true,
          ipTokensConsumed: limitResult.ipTokensConsumed,
          ipX402TokensConsumed: limitResult.ipX402TokensConsumed,
          ipRegularTokensConsumed: limitResult.ipRegularTokensConsumed,
          resourceTokensConsumed: limitResult.resourceTokensConsumed,
          resourceX402TokensConsumed: limitResult.resourceX402TokensConsumed,
          resourceRegularTokensConsumed:
            limitResult.resourceRegularTokensConsumed,
          paymentVerified,
          paymentSettled,
        };
      } catch (error: any) {
        rateLimitSpan.recordException(error);
        log.error('[DataHandler] Error during rate limit check', {
          id,
          error: error.message,
          stack: error.stack,
        });
        // On rate limit error, allow request to proceed
        return { allowed: true, paymentVerified, paymentSettled };
      } finally {
        rateLimitSpan.end();
      }
    }

    // No rate limiter configured, allow request
    return { allowed: true, paymentVerified, paymentSettled };
  } catch (error: any) {
    span.recordException(error);
    log.error('[DataHandler] Error in checkPaymentAndRateLimits', {
      id,
      error: error.message,
      stack: error.stack,
    });
    // On error, allow request to proceed
    return { allowed: true };
  } finally {
    span.end();
  }
}

/**
 * Adjust rate limit tokens based on actual response size
 *
 * Should be called in res.on('finish') after response is sent
 */
export async function adjustRateLimitTokens({
  req,
  responseSize,
  initialResult,
  rateLimiter,
}: AdjustRateLimitTokensParams): Promise<void> {
  if (rateLimiter === undefined) {
    return;
  }

  if (initialResult.ipTokensConsumed === undefined) {
    // No initial consumption to adjust
    return;
  }

  const span = startChildSpan('adjustRateLimitTokens', {
    attributes: {
      response_size: responseSize,
      initial_ip_tokens: initialResult.ipTokensConsumed,
    },
  });

  try {
    await rateLimiter.adjustTokens(req, {
      responseSize,
      initialResourceTokens: initialResult.resourceTokensConsumed ?? 0,
      initialResourceX402Tokens: initialResult.resourceX402TokensConsumed ?? 0,
      initialResourceRegularTokens:
        initialResult.resourceRegularTokensConsumed ?? 0,
      initialIpTokens: initialResult.ipTokensConsumed ?? 0,
      initialIpX402Tokens: initialResult.ipX402TokensConsumed ?? 0,
      initialIpRegularTokens: initialResult.ipRegularTokensConsumed ?? 0,
    });

    log.debug('[DataHandler] Adjusted rate limit tokens', {
      responseSize,
      initialIpTokens: initialResult.ipTokensConsumed,
      initialIpX402Tokens: initialResult.ipX402TokensConsumed,
      initialIpRegularTokens: initialResult.ipRegularTokensConsumed,
      initialResourceTokens: initialResult.resourceTokensConsumed,
      initialResourceX402Tokens: initialResult.resourceX402TokensConsumed,
      initialResourceRegularTokens: initialResult.resourceRegularTokensConsumed,
    });
  } catch (error: any) {
    span.recordException(error);
    log.error('[DataHandler] Error adjusting tokens', {
      error: error.message,
      stack: error.stack,
    });
  } finally {
    span.end();
  }
}

/**
 * Extract domain name from host header (without protocol, subdomain, or path)
 */
function extractDomain(host: string): string {
  if (host === '') {
    return 'unknown';
  }

  // Remove port if present
  const hostWithoutPort = host.split(':')[0];

  // Split by dots and take the last two parts for domain.com format
  const parts = hostWithoutPort.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostWithoutPort;
}
