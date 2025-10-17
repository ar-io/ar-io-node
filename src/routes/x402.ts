/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import { Logger } from 'winston';
import { paymentMiddleware } from 'x402-express';
import { PaymentRequirements } from 'x402/types';
import * as config from '../config.js';
import { RateLimiter } from '../limiter/types.js';
import { PaymentProcessor } from '../payments/types.js';
import { X402UsdcProcessor } from '../payments/x402-usdc-processor.js';

export interface X402RouterConfig {
  log: Logger;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
}

export function createX402Router({
  log,
  rateLimiter,
  paymentProcessor,
}: X402RouterConfig): Router {
  const x402Router = Router();

  // Register redirect endpoint BEFORE payment middleware to avoid double-processing
  // Redirect endpoint for payment settlement
  x402Router.get(
    '/ar-io/x402/redirect/:encoded',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        // Decode the original URL from base64url
        const encoded = req.params.encoded;
        let decodedUrl: string;
        let validatedUrl: string;

        try {
          decodedUrl = Buffer.from(encoded, 'base64url').toString('utf-8');
        } catch (error) {
          log.warn('[X402Redirect] Invalid base64url encoding', { encoded });
          res.status(400).send('Invalid encoded URL');
          return;
        }

        // Validate and normalize the URL
        try {
          validatedUrl = validateRedirectUrl(decodedUrl);
        } catch (error: any) {
          log.warn('[X402Redirect] Invalid redirect URL', {
            decodedUrl,
            error: error.message,
          });
          res.status(400).send('Invalid redirect URL');
          return;
        }

        log.debug('[X402Redirect] Processing redirect request', {
          encoded,
          validatedUrl,
        });

        // If no payment processor or rate limiter, just redirect
        if (paymentProcessor === undefined || rateLimiter === undefined) {
          log.warn(
            '[X402Redirect] No payment processor or rate limiter configured',
          );
          sendRedirectHtml(res, validatedUrl);
          return;
        }

        // Extract payment from headers
        const payment = paymentProcessor.extractPayment(req);

        if (payment === undefined) {
          log.warn('[X402Redirect] No payment header found');
          sendRedirectHtml(res, validatedUrl);
          return;
        }

        // Create payment requirements with maximum price
        // We don't know the actual content size, so use max price
        const requirements: PaymentRequirements =
          paymentProcessor.calculateRequirements({
            contentSize: 0, // Will be ignored due to max price clamping
            contentType: 'application/octet-stream',
            protocol: req.protocol,
            host: req.headers.host ?? '',
            originalUrl: validatedUrl,
          });

        // Verify payment
        log.debug('[X402Redirect] Verifying payment');
        const verifyResult = await paymentProcessor.verifyPayment(
          payment,
          requirements,
        );

        if (!verifyResult.isValid) {
          log.warn('[X402Redirect] Payment verification failed', {
            reason: verifyResult.invalidReason,
          });
          sendRedirectHtml(res, validatedUrl);
          return;
        }

        // Settle payment
        log.debug('[X402Redirect] Settling payment');
        const settlementResult = await paymentProcessor.settlePayment(
          payment,
          requirements,
        );

        if (!settlementResult.success) {
          log.error('[X402Redirect] Payment settlement failed', {
            error: settlementResult.errorReason,
          });
          sendRedirectHtml(res, validatedUrl);
          return;
        }

        // Set settlement response header if available
        if (settlementResult.responseHeader !== undefined) {
          res.setHeader('X-Payment-Response', settlementResult.responseHeader);
        }

        // Convert payment amount to tokens
        if (paymentProcessor instanceof X402UsdcProcessor) {
          // Use the actual payment amount from the payment payload, not requirements
          // Only EVM payments have authorization field
          if ('authorization' in payment.payload) {
            const actualPaymentAmount =
              payment.payload.authorization.value.toString();
            const tokens =
              paymentProcessor.paymentToTokens(actualPaymentAmount);

            log.debug('[X402Redirect] Topping off rate limiter', {
              paymentAmount: actualPaymentAmount,
              tokens,
            });

            // Top off rate limiter bucket
            await rateLimiter.topOffPaidTokens(req, tokens);

            log.info('[X402Redirect] Payment settled and bucket topped off', {
              tokens,
            });
          }
        }

        // Send redirect HTML
        sendRedirectHtml(res, validatedUrl);
      } catch (error: any) {
        log.error('[X402Redirect] Error processing redirect', {
          error: error.message,
          stack: error.stack,
        });
        res.status(500).send('Internal server error');
      }
    }),
  );

  // Register payment middleware after redirect endpoint to avoid intercepting it
  if (config.X_402_USDC_WALLET_ADDRESS !== undefined) {
    x402Router.use(
      paymentMiddleware(
        config.X_402_USDC_WALLET_ADDRESS as `0x${string}`,
        {
          'GET /ar-io/x402/*': {
            price: `$${config.X_402_USDC_DATA_EGRESS_MIN_PRICE}`,
            network: config.X_402_USDC_NETWORK,
          },
        },
        {
          url: config.X_402_USDC_FACILITATOR_URL,
        },
      ),
    );
  }

  x402Router.get('/ar-io/x402/test', (_req, res) => {
    res.header('Content-Type', 'text/html');
    res.send('<h1>x402 is working!</h1>');
  });

  return x402Router;
}

/**
 * Validate and normalize a redirect URL
 * Only allows http/https schemes or relative URLs (same-origin paths)
 * @param urlString - URL string to validate
 * @returns Normalized URL string
 * @throws Error if URL is invalid or uses disallowed scheme
 */
export function validateRedirectUrl(urlString: string): string {
  // Try to parse as URL
  try {
    const url = new URL(urlString);

    // Only allow http and https schemes
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid URL scheme: ${url.protocol}`);
    }

    return url.toString();
  } catch (error) {
    // If URL parsing fails, check if it's a relative path
    // Relative paths should start with / and not contain protocol-like patterns
    if (
      urlString.startsWith('/') &&
      !urlString.includes(':') &&
      !urlString.startsWith('//')
    ) {
      return urlString;
    }

    // Otherwise it's invalid
    throw new Error('Invalid redirect URL');
  }
}

/**
 * Escape HTML special characters to prevent XSS attacks
 * @param text - Text to escape
 * @returns HTML-safe escaped text
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Send HTML redirect response
 * SECURITY: targetUrl must be HTML-escaped to prevent XSS attacks
 */
function sendRedirectHtml(res: Response, targetUrl: string): void {
  const escapedUrl = escapeHtml(targetUrl);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${escapedUrl}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting...</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}

// For backwards compatibility, export a router with no dependencies
export const x402Router = createX402Router({
  log: console as any,
});
