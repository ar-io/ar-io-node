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
import * as config from '../config.js';
import { RateLimiter } from '../limiter/types.js';
import { PaymentProcessor } from '../payments/types.js';
import { processPaymentAndTopUp } from '../payments/payment-processor-utils.js';

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

  // Shared handler for redirect endpoints
  const redirectHandler = asyncHandler(async (req: Request, res: Response) => {
    try {
      // Decode the original URL from base64url
      const encoded = req.params.encoded;
      let decodedUrl: string;
      let validatedUrl: string;

      try {
        decodedUrl = Buffer.from(encoded, 'base64url').toString('utf-8');
      } catch (error) {
        log.warn('Invalid base64url encoding', { encoded });
        res.status(400).send('Invalid encoded URL');
        return;
      }

      // Validate and normalize the URL
      try {
        validatedUrl = validateRedirectUrl(decodedUrl);
      } catch (error: any) {
        log.warn('Invalid redirect URL', {
          decodedUrl,
          error: error.message,
        });
        res.status(400).send('Invalid redirect URL');
        return;
      }

      log.debug('Processing redirect request', {
        encoded,
        validatedUrl,
      });

      // If no payment processor or rate limiter, just redirect
      if (paymentProcessor === undefined || rateLimiter === undefined) {
        log.warn('No payment processor or rate limiter configured');
        sendRedirectHtml(res, validatedUrl);
        return;
      }

      // Process payment and top up IP bucket using shared utility
      const result = await processPaymentAndTopUp(
        rateLimiter,
        paymentProcessor,
        req,
        log,
        { type: 'ip' },
      );

      // Set settlement response header if available
      if (result.responseHeader !== undefined) {
        res.setHeader('X-Payment-Response', result.responseHeader);
      }

      if (!result.success) {
        log.warn('Payment processing failed', {
          error: result.error,
        });
      }

      // Send redirect HTML
      sendRedirectHtml(res, validatedUrl);
    } catch (error: any) {
      log.error('Error processing redirect', {
        error: error.message,
        stack: error.stack,
      });
      res.status(500).send('Internal server error');
    }
  });

  // New primary endpoint (browser paywall redirect)
  x402Router.get(
    '/ar-io/x402/browser-paywall-redirect/:encoded',
    redirectHandler,
  );

  // Deprecated alias for backward compatibility
  x402Router.get('/ar-io/x402/redirect/:encoded', (req, res, next) => {
    log.warn(
      'Using deprecated /ar-io/x402/redirect endpoint, use /ar-io/x402/browser-paywall-redirect instead',
    );
    redirectHandler(req, res, next);
  });

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
    // Relative paths must start with / but not // (scheme-relative URLs)
    if (urlString.startsWith('/') && !urlString.startsWith('//')) {
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
