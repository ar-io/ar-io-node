/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { useFacilitator } from 'x402/verify';
import {
  ERC20TokenAmount,
  PaymentPayload,
  PaymentRequirements,
  settleResponseHeader,
} from 'x402/types';
import { decodePayment } from 'x402/schemes';
import * as config from '../config.js';
import * as system from '../system.js';
import log from '../log.js';
import { tracer } from '../tracing.js';
import { ContiguousDataAttributes } from '../types.js';
import { getPaywallHtml, processPriceToAtomicAmount } from 'x402/shared';
import { asyncMiddleware } from 'middleware-async';

// TODO: we could move this to system.ts and use the same facilitator for all x402 requests
const facilitator = useFacilitator({
  url: config.X_402_USDC_FACILITATOR_URL,
});
const x402Version = 1;

export const sendX402Response = ({
  res,
  message,
  paymentRequirements,
  error,
  payer,
}: {
  res: any;
  message?: string;
  paymentRequirements: PaymentRequirements;
  error?: string;
  payer?: string;
}) => {
  res.set('X-Payment-Required', JSON.stringify(paymentRequirements));
  res.status(402).json({
    x402Version,
    accepts: [paymentRequirements],
    error,
    message,
    payer,
  });
};

/**
 *
 * Helper function to calculate x402 USDC per byte egress price based on content size
 *
 * This is implemented for only USDC, but could be extended to other tokens. The coinbase
 * facilitator expects prices to be provided in the format of `$USDC_AMOUNT`.
 * @param contentLength
 * @returns string formatted price like `$0.01`
 */
export const calculateX402PricePerByteEgress = (
  contentLength: number,
): string => {
  const priceInUSD = contentLength * config.X_402_USDC_PER_BYTE_PRICE;
  const formattedPrice = Math.min(
    Math.max(priceInUSD, config.X_402_USDC_DATA_EGRESS_MIN_PRICE),
    config.X_402_USDC_DATA_EGRESS_MAX_PRICE,
  );
  return `$${formattedPrice}`;
};

// custom x402 payment middleware for data egress with dynamic pricing
export const x402DataEgressMiddleware = asyncMiddleware(
  async (req, res, next) => {
    // skip if x402 is not enabled or no address is provided
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

    let paymentPayload: PaymentPayload;
    let paymentRequirements: PaymentRequirements;

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

      // TODO: instead of defaulting price, update the data interface to perform HEAD checks on trusted gateways to find the content length
      const locallyCached = dataAttributes !== undefined;
      const contentLength = dataAttributes?.size ?? 0;

      const price = calculateX402PricePerByteEgress(contentLength);

      log.debug('Calculated x402 price', { price, contentLength });

      span.setAttribute('x402.price', price);
      span.setAttribute('x402.content_size', contentLength);

      const atomicAssetPrice = processPriceToAtomicAmount(
        price,
        config.X_402_USDC_NETWORK,
      );

      if ('error' in atomicAssetPrice) {
        // Invalid price format, continue without payment check
        log.error('Invalid x402 price format', { price });
        return next();
      }

      // Create payment requirements
      paymentRequirements = {
        scheme: 'exact' as const,
        description: `AR.IO Gateway data egress for ${contentLength} bytes`,
        network: config.X_402_USDC_NETWORK,
        maxAmountRequired: atomicAssetPrice.maxAmountRequired,
        payTo: config.X_402_USDC_ADDRESS,
        asset: atomicAssetPrice.asset.address,
        resource: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
        mimeType: dataAttributes?.contentType ?? 'application/octet-stream',
        maxTimeoutSeconds: 300, // 5 minutes
        extra: (atomicAssetPrice.asset as ERC20TokenAmount['asset']).eip712,
      };

      // Check for existing payment header
      const paymentHeader = req.headers['x-payment'] as string | undefined;

      if (paymentHeader === undefined) {
        // Send 402 response with payment requirements
        span.setAttribute('x402.payment_required', true);

        const userAgent = req.header('user-agent') ?? '';
        const isBrowser = /Mozilla|Chrome|Safari|Firefox|Edge/.test(userAgent);
        const acceptHeader = req.header('Accept') ?? '';
        const sendPaywall = acceptHeader.includes('text/html') && isBrowser;
        // If request is from a browser, we could serve a simple payment page instead of JSON
        if (sendPaywall) {
          // send html constructed by x402/shared library
          const html = getPaywallHtml({
            amount:
              +paymentRequirements.maxAmountRequired /
              10 ** atomicAssetPrice.asset.decimals,
            paymentRequirements: [paymentRequirements],
            testnet: config.X_402_USDC_NETWORK === 'base-sepolia',
            currentUrl: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
          });
          res.status(402).header('Content-Type', 'text/html').send(html);
        } else {
          sendX402Response({
            res,
            message: locallyCached
              ? `Payment of ${price} USDC required for ${contentLength} bytes`
              : `Payment of ${price} USDC required for unknown content length`,
            paymentRequirements,
            error: 'X-PAYMENT header is required',
          });
        }

        return;
      }

      try {
        // Decode the payment payload from the header using x402 utility
        paymentPayload = decodePayment(paymentHeader);
        paymentPayload.x402Version = x402Version;
        log.debug('Decoded payment payload', { paymentPayload });
      } catch (error: any) {
        span.setAttribute('x402.payment_verification_failed', true);
        sendX402Response({
          res,
          paymentRequirements,
          error: 'Invalid payment header format',
        });
        return;
      }

      // Validate that the payment payload matches our requirements
      if (paymentPayload.scheme !== paymentRequirements.scheme) {
        span.setAttribute('x402.payment_verification_failed', true);
        sendX402Response({
          res,
          paymentRequirements,
          error: 'Payment scheme mismatch',
        });

        return;
      }

      if (paymentPayload.network !== paymentRequirements.network) {
        span.setAttribute('x402.payment_verification_failed', true);
        sendX402Response({
          res,
          paymentRequirements,
          error: 'Payment network mismatch',
        });

        return;
      }

      // Verify the payment using facilitator
      const verifyResponse = await facilitator.verify(
        paymentPayload,
        paymentRequirements,
      );

      log.debug('Payment verification response', { verifyResponse });

      if (!verifyResponse.isValid) {
        // Payment verification failed
        span.setAttribute('x402.payment_verification_failed', true);
        sendX402Response({
          res,
          paymentRequirements,
          error: 'Payment verification failed',
          message: verifyResponse.invalidReason || 'Invalid payment',
          payer: verifyResponse.payer,
        });

        return;
      }

      // Store payment info on request for settlement after response
      (req as any).x402Payment = {
        verified: true,
        paymentPayload,
        paymentRequirements,
        price,
        contentLength,
      };

      span.setAttribute('x402.payment_verified', true);

      /**
       * NOTE: ideally settlement is handled AFTER the data is streamed, but `express` limits our ability
       * to wrap downstream middleware and capture the final status code before the response is sent to the client.
       * This leads to settlement ultimately blocking the response from being sent until it completes.
       *
       * Other libraries like koa or hono provide better control flow for this use case, specifically when
       * streaming large responses.
       */
      if (paymentPayload !== undefined && paymentRequirements !== undefined) {
        try {
          log.debug('Settling x402 payment', {
            id,
            paymentPayload,
            paymentRequirements,
          });
          // TODO: handle settle timeout via config.X_402_USDC_SETTLE_TIMEOUT_MS
          // wait for settlement to complete
          const settlementResult = await facilitator.settle(
            paymentPayload,
            paymentRequirements,
          );
          const settlementResultHeader = settleResponseHeader(settlementResult);

          log.debug('Payment settlement result', {
            id,
            settlementResult,
          });

          // put your header on BEFORE any bytes go out
          res.setHeader('X-Payment-Response', settlementResultHeader);
          res.append('Access-Control-Expose-Headers', 'X-Payment-Response');
          span.setAttribute('x402.payment_settled', settlementResult.success);

          // NOTE: we may not want to send a 402 here and just log the failed settlement. The client has already made the request and we have verified payment,
          // so it may be better to just log the failure and continue. This could be revisited in the future
          if (!settlementResult.success) {
            throw new Error(
              `Payment settlement failed: ${settlementResult.errorReason}`,
            );
          }
        } catch (err) {
          span.setAttribute('x402.payment_settlement_error', true);
          log.error('Error during payment settlement', {
            id,
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
          // NOTE: we may not want to send a 402 here and just log the error. The client has already made the request and we have verified payment,
          // so it may be better to just log the failure and continue. This could be revisited in the future.
          if (!res.headersSent) {
            res.status(402).json({
              x402Version,
              error: (err as Error).message ?? 'settlement_error',
              accepts: [paymentRequirements],
            });
            return;
          }
        }
      }

      // Proceed to next middleware
      return next();
    } catch (error: any) {
      span.recordException(error);
      log.error('Error in x402 data egress middleware:', {
        path: req.path,
        message: error.message,
        stack: error.stack,
      });
      // On error, send error response
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message,
      });
    } finally {
      span.end();
    }
  },
);
