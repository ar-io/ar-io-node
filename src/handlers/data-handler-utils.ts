/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { Span } from '@opentelemetry/api';
import log from '../log.js';
import * as config from '../config.js';
import { startChildSpan } from '../tracing.js';
import { extractAllClientIPs } from '../lib/ip-utils.js';
import {
  rateLimitExceededTotal,
  rateLimitRequestsTotal,
  rateLimitBytesBlockedTotal,
} from '../metrics.js';
import { RequestAttributes } from '../types.js';
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
  id?: string;
  contentSize: number;
  contentType?: string;
  requestAttributes: RequestAttributes;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor | undefined;
  parentSpan?: Span;
  /**
   * Internal hint for the paywall renderer that controls how the browser should
   * handle the HTML paywall: 'redirect' to send the user to a hosted paywall URL,
   * or 'direct' to render the paywall inline
   */
  browserPaymentFlow?: 'redirect' | 'direct';
}

/**
 * Result from checking payment and rate limits
 */
export interface CheckPaymentAndRateLimitsResult {
  allowed: boolean;
  ipTokensConsumed?: number;
  ipPaidTokensConsumed?: number;
  ipRegularTokensConsumed?: number;
  resourceTokensConsumed?: number;
  resourcePaidTokensConsumed?: number;
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
  contentSize,
  contentType,
  requestAttributes: _requestAttributes,
  rateLimiter,
  paymentProcessor,
  parentSpan,
  browserPaymentFlow,
}: CheckPaymentAndRateLimitsParams): Promise<CheckPaymentAndRateLimitsResult> {
  const span = startChildSpan(
    'checkPaymentAndRateLimits',
    {
      attributes: {
        ...(id !== undefined && { 'data.id': id }),
        'content.size': contentSize,
      },
    },
    parentSpan,
  );

  try {
    // Extract all client IPs for allowlist checking
    const { clientIp, clientIps } = extractAllClientIPs(req);

    // Add client IP attributes to span for visibility in tail sampling
    // Especially valuable for debugging rate limits, payment issues, and abuse patterns
    span.setAttribute('client.ip', clientIp);
    span.setAttribute('client.ips', clientIps.join(','));

    // Check if ANY IP in the chain is allowlisted - if so, skip all checks
    if (rateLimiter?.isAllowlisted(clientIps)) {
      span.setAttribute('allowlisted', true);
      log.debug('Client is allowlisted, skipping checks', {
        id,
        clientIps,
      });
      return { allowed: true };
    }

    // Check if ArNS name is allowlisted - if so, skip all checks
    const arnsName = req.arns?.name;
    if (
      arnsName !== undefined &&
      arnsName !== '' &&
      config.RATE_LIMITER_ARNS_ALLOWLIST.includes(arnsName)
    ) {
      span.setAttribute('arns_allowlisted', true);
      span.setAttribute('arns_name', arnsName);
      log.debug('ArNS name is allowlisted, skipping checks', {
        id,
        arnsName,
      });
      return { allowed: true };
    }

    // Track request for metrics
    const host = req.headers.host ?? '';
    const domain = extractDomain(host);
    rateLimitRequestsTotal.inc({ domain });

    let paymentVerified = false;
    let paymentSettled = false;

    // === PAYMENT VERIFICATION ===
    if (paymentProcessor !== undefined) {
      span.addEvent('Checking payment');
      const paymentSpan = startChildSpan(
        'verifyPayment',
        {
          attributes: {
            ...(id !== undefined && { 'data.id': id }),
            'content.size': contentSize,
            'client.ip': clientIp,
            'client.ips': clientIps.join(','),
          },
        },
        span,
      );

      try {
        // Calculate payment requirements based on actual content size
        const requirements = paymentProcessor.calculateRequirements({
          contentSize,
          protocol: config.SANDBOX_PROTOCOL ?? req.protocol,
          host: host,
          originalUrl: req.originalUrl,
          contentType: contentType ?? 'application/octet-stream',
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
          log.debug('No payment provided', { id });
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
            log.warn('Payment verification failed', {
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
                browserPaymentFlow,
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
            log.error('Payment settlement failed', {
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
                browserPaymentFlow,
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

          log.info('Payment verified and settled', { id });
        }
      } catch (error: any) {
        paymentSpan.recordException(error);
        log.error('Error during payment processing', {
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
    if (rateLimiter !== undefined && config.ENABLE_RATE_LIMITER) {
      span.addEvent('Checking rate limits');
      const rateLimitSpan = startChildSpan(
        'checkRateLimits',
        {
          attributes: {
            ...(id !== undefined && { 'data.id': id }),
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

        log.debug('Reserving rate limit tokens', {
          id,
          contentSize,
          predictedTokens,
          paymentVerified,
        });

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

          log.info('Rate limit exceeded', {
            clientIp,
            id,
            limitType: limitResult.limitType,
          });

          rateLimitExceededTotal.inc({
            limit_type: limitResult.limitType ?? 'unknown',
            domain,
          });

          // Track bytes blocked
          rateLimitBytesBlockedTotal.inc({ domain }, contentSize);

          // If payment processor exists and payment not verified, return 402
          if (paymentProcessor !== undefined && !paymentVerified) {
            const requirements = paymentProcessor.calculateRequirements({
              contentSize,
              protocol: config.SANDBOX_PROTOCOL ?? req.protocol,
              host: host,
              originalUrl: req.originalUrl,
              contentType: contentType ?? 'application/octet-stream',
            } as PaymentRequirementsContext);

            paymentProcessor.sendPaymentRequiredResponse(
              req,
              res,
              requirements,
              {
                message: 'Payment required to access this resource',
                browserPaymentFlow,
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

        // Rate limit check passed
        return {
          allowed: true,
          ipTokensConsumed: limitResult.ipTokensConsumed,
          ipPaidTokensConsumed: limitResult.ipPaidTokensConsumed,
          ipRegularTokensConsumed: limitResult.ipRegularTokensConsumed,
          resourceTokensConsumed: limitResult.resourceTokensConsumed,
          resourcePaidTokensConsumed: limitResult.resourcePaidTokensConsumed,
          resourceRegularTokensConsumed:
            limitResult.resourceRegularTokensConsumed,
          paymentVerified,
          paymentSettled,
        };
      } catch (error: any) {
        rateLimitSpan.recordException(error);
        log.error('Error during rate limit check', {
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
    log.error('Error in checkPaymentAndRateLimits', {
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
    // Extract client IPs for span visibility
    const { clientIp, clientIps } = extractAllClientIPs(req);
    span.setAttribute('client.ip', clientIp);
    span.setAttribute('client.ips', clientIps.join(','));

    // Extract domain for metrics
    const host = req.headers.host ?? '';
    const domain = extractDomain(host);

    await rateLimiter.adjustTokens(req, {
      responseSize,
      initialResourceTokens: initialResult.resourceTokensConsumed ?? 0,
      initialResourcePaidTokens: initialResult.resourcePaidTokensConsumed ?? 0,
      initialResourceRegularTokens:
        initialResult.resourceRegularTokensConsumed ?? 0,
      initialIpTokens: initialResult.ipTokensConsumed ?? 0,
      initialIpPaidTokens: initialResult.ipPaidTokensConsumed ?? 0,
      initialIpRegularTokens: initialResult.ipRegularTokensConsumed ?? 0,
      domain,
    });

    log.debug('Adjusted rate limit tokens', {
      responseSize,
      initialIpTokens: initialResult.ipTokensConsumed,
      initialIpPaidTokens: initialResult.ipPaidTokensConsumed,
      initialIpRegularTokens: initialResult.ipRegularTokensConsumed,
      initialResourceTokens: initialResult.resourceTokensConsumed,
      initialResourcePaidTokens: initialResult.resourcePaidTokensConsumed,
      initialResourceRegularTokens: initialResult.resourceRegularTokensConsumed,
    });
  } catch (error: any) {
    span.recordException(error);
    log.error('Error adjusting tokens', {
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
