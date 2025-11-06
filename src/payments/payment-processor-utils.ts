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
 * Type guard to check if a payment payload is an EVM payload with authorization
 */
function isEvmPayload(
  payload: unknown,
): payload is { authorization: { value: string } } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'authorization' in payload &&
    typeof (payload as any).authorization === 'object' &&
    'value' in (payload as any).authorization
  );
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

    // Validate target before processing payment
    if (target.type === 'resource') {
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

    // Validate host header is present
    const host = req.headers.host;
    if (host === undefined || host === '') {
      return {
        success: false,
        error: 'Missing Host header - required for payment processing',
      };
    }

    // Create payment requirements based on actual payment amount
    const requirements: PaymentRequirements =
      paymentProcessor.calculateRequirements({
        contentSize,
        contentType: 'application/octet-stream',
        protocol: config.SANDBOX_PROTOCOL ?? req.protocol,
        host: host,
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
    // Payment has been settled successfully, now we must grant access tokens

    // Validate processor type
    if (!(paymentProcessor instanceof X402UsdcProcessor)) {
      log.error('Unsupported payment processor type', {
        processorType: paymentProcessor.constructor.name,
        network: payment.network,
        scheme: payment.scheme,
      });
      return {
        success: false,
        error: `Unsupported payment processor type: ${paymentProcessor.constructor.name}`,
      };
    }

    // Validate payload type - must be EVM payload with authorization
    if (!isEvmPayload(payment.payload)) {
      log.error('Unsupported payment payload type', {
        processorType: paymentProcessor.constructor.name,
        network: payment.network,
        scheme: payment.scheme,
        hasAuthorization: 'authorization' in payment.payload,
        hasTransaction: 'transaction' in payment.payload,
      });
      return {
        success: false,
        error:
          'Unsupported payment payload type. Only EVM payments with authorization are currently supported.',
      };
    }

    // Extract payment amount from EVM authorization
    const paymentAmount = payment.payload.authorization.value.toString();
    const tokens = paymentProcessor.paymentToTokens(paymentAmount);

    log.debug('Topping off rate limiter', {
      processorType: paymentProcessor.constructor.name,
      paymentAmount,
      tokens,
      target,
      network: payment.network,
      scheme: payment.scheme,
    });

    // Top off appropriate bucket based on target type
    const multiplierApplied = config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER;
    let tokensAdded: number;

    if (target.type === 'ip') {
      // For IP bucket, use existing method with request
      await rateLimiter.topOffPaidTokens(req, tokens);
      tokensAdded = tokens * multiplierApplied;
    } else if (target.type === 'resource') {
      // For resource bucket, use new method with explicit params
      // Note: target validation already done at function entry
      await rateLimiter.topOffPaidTokensForResource(
        target.method!,
        target.host!,
        target.path!,
        tokens,
      );
      tokensAdded = tokens * multiplierApplied;
    } else {
      log.error('Invalid target type', { target });
      return {
        success: false,
        error: `Invalid target type: ${target.type}`,
      };
    }

    log.info('Payment settled and bucket topped off', {
      processorType: paymentProcessor.constructor.name,
      network: payment.network,
      scheme: payment.scheme,
      target,
      tokens,
      tokensAdded,
      multiplierApplied,
    });

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
