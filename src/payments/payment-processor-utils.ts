/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Request } from 'express';
import { Logger } from 'winston';
import { PaymentRequirements } from 'x402/types';
import * as config from '../config.js';
import { RateLimiter } from '../limiter/types.js';
import { PaymentProcessor } from './types.js';
import { X402UsdcProcessor } from './x402-usdc-processor.js';

export interface PaymentTopUpTarget {
  type: 'ip' | 'resource';
  ip?: string;
  method?: string;
  host?: string;
  path?: string;
}

export interface PaymentTopUpResult {
  success: boolean;
  tokensAdded?: number;
  paymentAmount?: string;
  multiplierApplied?: number;
  error?: string;
  responseHeader?: string;
}

/**
 * Process x402 payment, verify, settle, and top up rate limiter bucket
 *
 * @param rateLimiter Rate limiter instance
 * @param paymentProcessor Payment processor instance
 * @param req Express request object
 * @param log Logger instance
 * @param target Target configuration (IP or resource bucket)
 * @param contentSizeOverride Optional content size override for requirements calculation
 * @returns Promise<PaymentTopUpResult>
 */
export async function processPaymentAndTopUp(
  rateLimiter: RateLimiter,
  paymentProcessor: PaymentProcessor,
  req: Request,
  log: Logger,
  target: PaymentTopUpTarget,
  contentSizeOverride?: number,
): Promise<PaymentTopUpResult> {
  try {
    // Extract payment from headers
    const payment = paymentProcessor.extractPayment(req);

    if (payment === undefined) {
      return {
        success: false,
        error: 'No payment found in headers',
      };
    }

    // Calculate equivalent content size from payment amount
    let contentSize = contentSizeOverride ?? 0;
    if (
      contentSizeOverride === undefined &&
      paymentProcessor instanceof X402UsdcProcessor &&
      'authorization' in payment.payload
    ) {
      const actualPaymentAmount =
        payment.payload.authorization.value.toString();
      contentSize = paymentProcessor.paymentToContentSize(actualPaymentAmount);
      log.debug('Calculated content size from payment', {
        actualPaymentAmount,
        contentSize,
      });
    }

    // Create payment requirements based on actual payment amount
    const requirements: PaymentRequirements =
      paymentProcessor.calculateRequirements({
        contentSize,
        contentType: 'application/octet-stream',
        protocol: config.SANDBOX_PROTOCOL ?? req.protocol,
        host: req.headers.host ?? '',
        originalUrl: req.originalUrl,
      });

    // Verify payment
    log.debug('Verifying payment');
    const verifyResult = await paymentProcessor.verifyPayment(
      payment,
      requirements,
    );

    if (!verifyResult.isValid) {
      return {
        success: false,
        error: `Payment verification failed: ${verifyResult.invalidReason}`,
      };
    }

    // Settle payment
    log.debug('Settling payment');
    const settlementResult = await paymentProcessor.settlePayment(
      payment,
      requirements,
    );

    if (!settlementResult.success) {
      return {
        success: false,
        error: `Payment settlement failed: ${settlementResult.errorReason}`,
      };
    }

    // Convert payment amount to tokens and top up bucket
    let tokensAdded = 0;
    let paymentAmount = '0';
    let multiplierApplied = 1;

    if (paymentProcessor instanceof X402UsdcProcessor) {
      // Use the actual payment amount from the payment payload
      // Only EVM payments have authorization field
      if ('authorization' in payment.payload) {
        paymentAmount = payment.payload.authorization.value.toString();
        const tokens = paymentProcessor.paymentToTokens(paymentAmount);

        log.debug('Topping off rate limiter', {
          paymentAmount,
          tokens,
          target,
        });

        // Top off appropriate bucket based on target type
        if (target.type === 'ip') {
          // For IP bucket, use existing method with request
          await rateLimiter.topOffPaidTokens(req, tokens);
          multiplierApplied = 10; // Default capacity multiplier
          tokensAdded = tokens * multiplierApplied;
        } else if (target.type === 'resource') {
          // For resource bucket, use new method with explicit params
          if (
            target.method === undefined ||
            target.host === undefined ||
            target.path === undefined
          ) {
            return {
              success: false,
              error: 'Resource top-up requires method, host, and path',
            };
          }
          await rateLimiter.topOffPaidTokensForResource(
            target.method,
            target.host,
            target.path,
            tokens,
          );
          multiplierApplied = 10; // Default capacity multiplier
          tokensAdded = tokens * multiplierApplied;
        }

        log.info('Payment settled and bucket topped off', {
          target,
          tokens,
          tokensAdded,
          multiplierApplied,
        });
      }
    }

    return {
      success: true,
      tokensAdded,
      paymentAmount,
      multiplierApplied,
      responseHeader: settlementResult.responseHeader,
    };
  } catch (error: any) {
    log.error('Error processing payment and top-up', {
      error: error.message,
      stack: error.stack,
      target,
    });
    return {
      success: false,
      error: error.message || 'Unknown error',
    };
  }
}
