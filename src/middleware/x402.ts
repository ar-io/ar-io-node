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
import log from '../log.js';
import { tracer } from '../tracing.js';
import {
  ContiguousDataAttributes,
  ContiguousDataAttributesStore,
} from '../types.js';
import { getPaywallHtml, processPriceToAtomicAmount } from 'x402/shared';
import { Request, Response, NextFunction } from 'express';
import {
  DATA_PATH_REGEX,
  RAW_DATA_PATH_REGEX,
  FARCASTER_FRAME_DATA_PATH_REGEX,
} from '../constants.js';
import logger from '../log.js';

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
export const x402DataEgressMiddleware = ({
  dataAttributesSource,
  enabledRateLimiting = config.ENABLE_RATE_LIMITER,
}: {
  dataAttributesSource?: ContiguousDataAttributesStore;
  enabledRateLimiting?: boolean;
} = {}): any => {
  const isX402EgressEnabled =
    config.ENABLE_X_402_USDC_DATA_EGRESS &&
    config.X_402_USDC_WALLET_ADDRESS !== undefined;
  const payTo402UsdcAddress: `0x${string}` = config.X_402_USDC_WALLET_ADDRESS!;
  const x402UsdcNetwork: 'base' | 'base-sepolia' = config.X_402_USDC_NETWORK;

  return async (req: Request, res: Response, next: NextFunction) => {
    // skip if x402 is not enabled or no address is provided
    if (isX402EgressEnabled === false) {
      logger.debug('x402 egress middleware is disabled');
      return next();
    }

    logger.info('[x402] Middleware running', {
      path: req.path,
      method: req.method,
      hasPaymentHeader: req.headers['x-payment'] !== undefined,
    });

    const span = tracer.startSpan('x402DataEgressMiddleware', {
      attributes: {
        'http.method': req.method,
        'http.path': req.path,
      },
    });

    let paymentPayload: PaymentPayload;
    let paymentRequirements: PaymentRequirements;

    try {
      // Try to extract transaction ID from different path patterns
      let id: string | undefined;

      // Try DATA_PATH_REGEX first (/:id or /:id/path)
      let pathMatch = req.path.match(DATA_PATH_REGEX);
      if (pathMatch) {
        id = pathMatch[1] || pathMatch[2];
      }

      // Try RAW_DATA_PATH_REGEX (/raw/:id)
      if (id === undefined) {
        pathMatch = req.path.match(RAW_DATA_PATH_REGEX);
        if (pathMatch) {
          id = pathMatch[1];
        }
      }

      // Try FARCASTER_FRAME_DATA_PATH_REGEX (/local/farcaster/frame/:id)
      if (id === undefined) {
        pathMatch = req.path.match(FARCASTER_FRAME_DATA_PATH_REGEX);
        if (pathMatch) {
          id = pathMatch[1];
        }
      }

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
        if (dataAttributesSource) {
          dataAttributes = await dataAttributesSource.getDataAttributes(id);
        }
      } catch (error: any) {
        log.debug('Could not get data attributes for x402 check', {
          id,
          error: error.message,
        });
        // TODO: we may just want to fallback to a default price here instead of continuing without payment check
        return next();
      }

      // if we don't know anything about the data and rate limiting is enabled, let it determine if the resource can be served
      if (dataAttributes === undefined && enabledRateLimiting) {
        log.debug(
          'Data attributes not found; cannot enforce x402 payment for unknown content length',
          { id },
        );
        return next();
      }

      /**
       * TODO: manifests require some additional logic to determine the total size of the data being requested via the manifest resolution.
       * For now, we will skip payment enforcement for manifests.
       */
      if (dataAttributes?.isManifest) {
        log.debug(
          'Data is a manifest; cannot enforce x402 payment for manifests',
          { id },
        );
        return next();
      }

      // TODO: instead of defaulting price, update the data interface to perform HEAD checks on trusted gateways to find the content length
      // TODO: properly handle byteRange requests by parsing out the range(s) and calculate the price based on the total size of the ranges requested
      const contentLength = dataAttributes?.itemSize ?? 0;
      const price = calculateX402PricePerByteEgress(contentLength);

      log.debug('Calculated x402 price', { price, contentLength });

      span.setAttribute('x402.price', price);
      span.setAttribute('x402.content_size', contentLength);

      const atomicAssetPrice = processPriceToAtomicAmount(
        price,
        x402UsdcNetwork,
      );

      if ('error' in atomicAssetPrice) {
        // Invalid price format, continue without payment check
        log.error('Invalid x402 price format', { price });
        // Being conservative, if price is misconfigured, continue to next middleware
        return next();
      }

      // Create payment requirements
      paymentRequirements = {
        scheme: 'exact' as const,
        description: `AR.IO Gateway data egress for ${contentLength} bytes`,
        network: x402UsdcNetwork,
        maxAmountRequired: atomicAssetPrice.maxAmountRequired,
        payTo: payTo402UsdcAddress,
        asset: atomicAssetPrice.asset.address,
        resource: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
        mimeType: dataAttributes?.contentType ?? 'application/octet-stream',
        maxTimeoutSeconds: 300, // 5 minutes
        // TODO: we could include additional attributes here
        extra: (atomicAssetPrice.asset as ERC20TokenAmount['asset']).eip712,
      };

      // Store payment requirements for rate limiter (even if no payment provided)
      (req as any).x402Payment = {
        verified: false,
        settled: false,
        paymentRequirements,
        price,
      };

      // Check for existing payment header
      const paymentHeader = req.headers['x-payment'] as string | undefined;

      if (paymentHeader === undefined) {
        // No payment provided - continue to rate limiter which will use standard capacity
        span.setAttribute('x402.payment_required', false);
        span.setAttribute('x402.payment_provided', false);
        log.debug(
          'No x402 payment provided, continuing with standard rate limit',
          {
            id,
          },
        );
        return next();
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
          error: 'Invalid payment header',
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

      // isValid indicates the payment is unique and has not been settled on chain yet
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
          // TODO: could add a settlement timeout via config.X_402_USDC_SETTLE_TIMEOUT_MS to limit the time spent here
          // We may also want to consider circuit breaking if the facilitator is having issues
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

      // Update payment info with verified and settled status
      (req as any).x402Payment = {
        verified: true,
        settled: true,
        paymentPayload,
        paymentRequirements,
        price,
      };

      span.setAttribute('x402.payment_provided', true);
      log.debug(
        'x402 payment verified and settled, continuing with paid rate limit',
        {
          id,
        },
      );

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
  };
};
