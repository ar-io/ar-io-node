/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useFacilitator } from 'x402/verify';
import { PaymentRequirements, settleResponseHeader } from 'x402/types';
import { decodePayment } from 'x402/schemes';
import { Request, Response, NextFunction } from 'express';
import * as config from '../config.js';
import * as system from '../system.js';
import log from '../log.js';
import { tracer } from '../tracing.js';
import { ContiguousDataAttributes } from '../types.js';

// TODO: we could move this to system.ts and use the same facilitator for all x402 requests
const facilitator = useFacilitator({
  url: config.X_402_USDC_FACILITATOR_URL,
});

/**
 *
 * Helper function to calculate x402 USDC per byte egress price based on content size
 *
 * This is implemented for only USDC, but could be extended to other tokens. The coinbase
 * facilitator expects prices to be provided in the format of `$USDC_AMOUNT`.
 * @param contentLength
 * @returns
 */
export const calculateX402PricePerByteEgress = (
  contentLength: number,
): string => {
  // Calculate price based on per-byte rate
  const priceInUSD = contentLength * config.X_402_USDC_PER_BYTE_PRICE;
  // Format as USD string with appropriate precision
  // Ensure minimum price of $0.001
  const formattedPrice = Math.max(priceInUSD, 0.001).toFixed(3);

  return `$${formattedPrice}`;
};

// custom x402 payment middleware for data egress with dynamic pricing
export const x402DataEgressMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Skip if x402 is not enabled or no address is provided
  if (
    !config.ENABLE_X_402_USDC_DATA_EGRESS ||
    config.X_402_USDC_ADDRESS === undefined
  ) {
    return next();
  }

  const span = tracer.startSpan('x402DataEgressMiddleware', {
    attributes: {
      'http.method': req.method,
      'http.path': req.path,
    },
  });

  try {
    /**
     * TODO: currently only handling /txId routes.
     */
    const pathMatch = req.path.match(/\/([a-zA-Z0-9-_]{43})(?:\/.*)?$/);
    const id = pathMatch ? pathMatch[1] : undefined;

    if (id === undefined) {
      // No valid ID found, continue without payment check
      return next();
    }

    span.setAttribute('data.id', id);

    // Get data attributes to check size
    let dataAttributes: ContiguousDataAttributes | undefined;
    try {
      // NOTE: this should be populated if the gateway has ever seen/served the data before. The data itself does not need to be cached.
      // Additionally, we may want to add a multiplier if the resulting txId is a manifest.
      dataAttributes = await system.contiguousDataIndex.getDataAttributes(id);
    } catch (error: any) {
      log.debug('Could not get data attributes for x402 check', {
        id,
        error: error.message,
      });
      // TODO: we may just want to fallback to a default price here instead of continuing without payment check
      return next();
    }

    // TODO: instead fo defaulting price here, update the data interface to perform HEAD checks on trusted gateways to find the content length
    const locallyCached = dataAttributes?.size !== undefined;
    const contentLength =
      dataAttributes?.size ?? config.X_402_USDC_DEFAULT_CONTENT_LENGTH;

    const price = calculateX402PricePerByteEgress(contentLength);

    span.setAttribute('x402.price', price);
    span.setAttribute('x402.content_size', contentLength);

    // Create payment requirements
    const paymentRequirements: PaymentRequirements = {
      scheme: 'exact' as const,
      description: `AR.IO Gateway data egress for ${contentLength} bytes`,
      network: config.X_402_USDC_NETWORK as 'base-sepolia' | 'base',
      maxAmountRequired: price.replace('$', ''), // Remove $ prefix for amount
      payTo: config.X_402_USDC_ADDRESS,
      asset: 'USDC',
      resource: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
      mimeType: dataAttributes?.contentType ?? 'application/octet-stream',
      maxTimeoutSeconds: 300, // 5 minutes
      extra: {
        contentLength,
        dataId: id,
      },
    };

    // Check for existing payment header
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (paymentHeader === undefined) {
      // Send 402 response with payment requirements
      span.setAttribute('x402.payment_required', true);
      res.status(402);
      res.set('X-Payment-Required', JSON.stringify(paymentRequirements));

      // TODO: we could detect if the request is from a browser and serve them html with a form to pay
      return res.json({
        error: 'Payment Required',
        message: locallyCached
          ? `Payment of ${price} USDC required for ${contentLength} bytes`
          : `Payment of ${price} USDC required for unknown content length`,
        requirements: paymentRequirements,
      });
    }

    let paymentPayload;
    try {
      // Decode the payment payload from the header using x402 utility
      paymentPayload = decodePayment(paymentHeader);
    } catch (error: any) {
      span.setAttribute('x402.payment_verification_failed', true);
      res.status(402);
      res.set('X-Payment-Required', JSON.stringify(paymentRequirements));
      return res.json({
        error: 'Payment Verification Failed',
        message: 'Invalid payment header format',
        requirements: paymentRequirements,
      });
    }

    // Validate that the payment payload matches our requirements
    if (paymentPayload.scheme !== paymentRequirements.scheme) {
      span.setAttribute('x402.payment_verification_failed', true);
      res.status(402);
      res.set('X-Payment-Required', JSON.stringify(paymentRequirements));
      return res.json({
        error: 'Payment Verification Failed',
        message: 'Payment scheme mismatch',
        requirements: paymentRequirements,
      });
    }

    if (paymentPayload.network !== paymentRequirements.network) {
      span.setAttribute('x402.payment_verification_failed', true);
      res.status(402);
      res.set('X-Payment-Required', JSON.stringify(paymentRequirements));
      return res.json({
        error: 'Payment Verification Failed',
        message: 'Payment network mismatch',
        requirements: paymentRequirements,
      });
    }

    // Verify the payment using facilitator
    const verifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    if (!verifyResponse.isValid) {
      // Payment verification failed
      span.setAttribute('x402.payment_verification_failed', true);
      res.status(402);
      res.set('X-Payment-Required', JSON.stringify(paymentRequirements));
      return res.json({
        error: 'Payment Verification Failed',
        message: verifyResponse.invalidReason || 'Invalid payment',
        requirements: paymentRequirements,
      });
    }

    // Settle the payment using facilitator
    const settleResponse = await facilitator.settle(
      paymentPayload,
      paymentRequirements,
    );

    const responseHeader = settleResponseHeader(settleResponse);

    // Set the payment response header
    res.set('X-Payment-Response', responseHeader);
    span.setAttribute('x402.payment_verified', true);
    span.setAttribute('x402.payment_settled', true);

    // Store payment info on request for potential rate limit reset
    (req as any).x402Payment = {
      verified: true,
      settled: true,
      price,
      contentLength,
      settleResponse,
    };

    // Payment successful, continue to next middleware
    next();
  } catch (error: any) {
    span.recordException(error);
    log.error('Error in x402 data egress middleware:', {
      path: req.path,
      message: error.message,
      stack: error.stack,
    });
    // On error, fail open and continue
    next();
  } finally {
    span.end();
  }
};
