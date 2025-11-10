/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import { default as asyncHandler } from 'express-async-handler';
import { Logger } from 'winston';
import { RateLimiter } from '../limiter/types.js';
import { PaymentProcessor } from '../payments/types.js';
import { processPaymentAndTopUp } from '../payments/payment-processor-utils.js';
import { isValidIpFormat } from '../lib/ip-utils.js';
import * as config from '../config.js';

export interface RateLimitRouterConfig {
  log: Logger;
  rateLimiter: RateLimiter;
  paymentProcessor?: PaymentProcessor;
}

export function createRateLimitRouter({
  log,
  rateLimiter,
  paymentProcessor,
}: RateLimitRouterConfig): Router {
  const rateLimitRouter = Router();

  /**
   * GET /ar-io/rate-limit/ip/:ip
   * Query IP bucket balance
   */
  rateLimitRouter.get(
    '/ar-io/rate-limit/ip/:ip',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const { ip } = req.params;

        // Validate IP format
        if (!isValidIpFormat(ip)) {
          res.status(400).json({
            error: 'Invalid IP address format',
          });
          return;
        }

        // Get bucket state
        const state = await rateLimiter.getIpBucketState(ip);

        if (state === null) {
          res.status(404).json({
            error: 'Bucket not found',
            message:
              'No rate limit bucket exists for this IP. Buckets are created on first request.',
          });
          return;
        }

        res.json(state);
      } catch (error: any) {
        log.error('Error getting IP bucket state', {
          error: error.message,
          stack: error.stack,
        });
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    }),
  );

  /**
   * GET /ar-io/rate-limit/resource
   * Query resource bucket balance
   * Query params: path (required), method (default: GET), host (default: current host)
   */
  rateLimitRouter.get(
    '/ar-io/rate-limit/resource',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const path = req.query.path as string | undefined;
        const method = (req.query.method as string | undefined) ?? 'GET';
        const host = (req.query.host as string | undefined) ?? req.headers.host;

        // Validate required params
        if (path === undefined || path === '') {
          res.status(400).json({
            error: 'Missing required parameter: path',
          });
          return;
        }

        if (host === undefined || host === '') {
          res.status(400).json({
            error: 'Missing host (provide in query or Host header)',
          });
          return;
        }

        // Validate method is valid HTTP method
        const validMethods = [
          'GET',
          'POST',
          'PUT',
          'DELETE',
          'PATCH',
          'HEAD',
          'OPTIONS',
        ];
        if (!validMethods.includes(method.toUpperCase())) {
          res.status(400).json({
            error: 'Invalid HTTP method',
            validMethods,
          });
          return;
        }

        // Get bucket state
        const state = await rateLimiter.getResourceBucketState(
          method.toUpperCase(),
          host,
          path,
        );

        if (state === null) {
          res.status(404).json({
            error: 'Bucket not found',
            message:
              'No rate limit bucket exists for this resource. Buckets are created on first request.',
          });
          return;
        }

        res.json(state);
      } catch (error: any) {
        log.error('Error getting resource bucket state', {
          error: error.message,
          stack: error.stack,
        });
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    }),
  );

  /**
   * POST /ar-io/rate-limit/ip/:ip
   * Top up IP bucket with paid tokens
   * Supports x402 payment (X-Payment header) OR admin authentication (Authorization: Bearer)
   */
  rateLimitRouter.post(
    '/ar-io/rate-limit/ip/:ip',
    express.json(),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const { ip } = req.params;

        // Validate IP format
        if (!isValidIpFormat(ip)) {
          res.status(400).json({
            error: 'Invalid IP address format',
          });
          return;
        }

        // Check for x402 payment header
        const hasPayment = req.headers['x-payment'] !== undefined;
        const isAdmin =
          req.headers.authorization === `Bearer ${config.ADMIN_API_KEY}`;

        if (!hasPayment && !isAdmin) {
          res.status(401).json({
            error: 'Unauthorized',
            message:
              'Provide X-Payment header for x402 payment or Authorization: Bearer header for admin access',
          });
          return;
        }

        // Handle x402 payment flow
        if (hasPayment && paymentProcessor !== undefined) {
          const result = await processPaymentAndTopUp(
            rateLimiter,
            paymentProcessor,
            req,
            log,
            { type: 'ip', ip },
          );

          // Set settlement response header if available
          if (result.responseHeader !== undefined) {
            res.setHeader('X-Payment-Response', result.responseHeader);
          }

          if (!result.success) {
            res.status(402).json({
              error: 'Payment failed',
              message: result.error,
            });
            return;
          }

          // Get updated bucket state
          const state = await rateLimiter.getIpBucketState(ip);

          res.json({
            ...state,
            topUp: {
              tokensAdded: result.tokensAdded,
              paymentAmount: result.paymentAmount,
              multiplierApplied: result.multiplierApplied,
            },
          });
          return;
        }

        // Handle admin flow
        if (isAdmin) {
          const { tokens, tokenType } = req.body;

          // Validate tokens
          if (typeof tokens !== 'number' || tokens <= 0) {
            res.status(400).json({
              error: 'Invalid tokens value',
              message: 'tokens must be a positive number',
            });
            return;
          }

          // Validate tokenType
          if (tokenType !== 'paid' && tokenType !== 'regular') {
            res.status(400).json({
              error: 'Invalid tokenType',
              message: 'tokenType must be "paid" or "regular"',
            });
            return;
          }

          // For admin, we add tokens directly without multiplier
          // This is done by calling the top-off method with the tokens / multiplier
          // since the method applies the multiplier
          const capacityMultiplier =
            config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER;
          const tokensToAdd =
            tokenType === 'paid' ? tokens / capacityMultiplier : tokens;

          // Note: Currently we only support paid tokens for admin top-up via the existing method
          // Regular token top-up would require a new method on rate limiter
          if (tokenType === 'regular') {
            res.status(400).json({
              error: 'Regular token top-up not yet supported',
              message:
                'Admin can only top up paid tokens currently. Use tokenType: "paid"',
            });
            return;
          }

          // Create a mock request with the target IP for topOffPaidTokens
          const mockReq = {
            ...req,
            ip,
            socket: { remoteAddress: ip },
          } as Request;

          await rateLimiter.topOffPaidTokens(mockReq, tokensToAdd);

          // Get updated bucket state
          const state = await rateLimiter.getIpBucketState(ip);

          res.json({
            ...state,
            topUp: {
              tokensAdded: tokens,
              tokenType,
              multiplierApplied: 1, // Admin adds raw tokens
            },
          });
          return;
        }

        // Should not reach here
        res.status(500).json({
          error: 'Internal server error',
        });
      } catch (error: any) {
        log.error('Error topping up IP bucket', {
          error: error.message,
          stack: error.stack,
        });
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    }),
  );

  /**
   * POST /ar-io/rate-limit/resource
   * Top up resource bucket with paid tokens
   * Supports x402 payment (X-Payment header) OR admin authentication (Authorization: Bearer)
   * Query params: path (required), method (default: GET), host (default: current host)
   */
  rateLimitRouter.post(
    '/ar-io/rate-limit/resource',
    express.json(),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const path = req.query.path as string | undefined;
        const method = (req.query.method as string | undefined) ?? 'GET';
        const host = (req.query.host as string | undefined) ?? req.headers.host;

        // Validate required params
        if (path === undefined || path === '') {
          res.status(400).json({
            error: 'Missing required parameter: path',
          });
          return;
        }

        if (host === undefined || host === '') {
          res.status(400).json({
            error: 'Missing host (provide in query or Host header)',
          });
          return;
        }

        // Validate method is valid HTTP method
        const validMethods = [
          'GET',
          'POST',
          'PUT',
          'DELETE',
          'PATCH',
          'HEAD',
          'OPTIONS',
        ];
        if (!validMethods.includes(method.toUpperCase())) {
          res.status(400).json({
            error: 'Invalid HTTP method',
            validMethods,
          });
          return;
        }

        const normalizedMethod = method.toUpperCase();

        // Check for x402 payment header
        const hasPayment = req.headers['x-payment'] !== undefined;
        const isAdmin =
          req.headers.authorization === `Bearer ${config.ADMIN_API_KEY}`;

        if (!hasPayment && !isAdmin) {
          res.status(401).json({
            error: 'Unauthorized',
            message:
              'Provide X-Payment header for x402 payment or Authorization: Bearer header for admin access',
          });
          return;
        }

        // Handle x402 payment flow
        if (hasPayment && paymentProcessor !== undefined) {
          const result = await processPaymentAndTopUp(
            rateLimiter,
            paymentProcessor,
            req,
            log,
            {
              type: 'resource',
              method: normalizedMethod,
              host,
              path,
            },
          );

          // Set settlement response header if available
          if (result.responseHeader !== undefined) {
            res.setHeader('X-Payment-Response', result.responseHeader);
          }

          if (!result.success) {
            res.status(402).json({
              error: 'Payment failed',
              message: result.error,
            });
            return;
          }

          // Get updated bucket state
          const state = await rateLimiter.getResourceBucketState(
            normalizedMethod,
            host,
            path,
          );

          res.json({
            ...state,
            topUp: {
              tokensAdded: result.tokensAdded,
              paymentAmount: result.paymentAmount,
              multiplierApplied: result.multiplierApplied,
            },
          });
          return;
        }

        // Handle admin flow
        if (isAdmin) {
          const { tokens, tokenType } = req.body;

          // Validate tokens
          if (typeof tokens !== 'number' || tokens <= 0) {
            res.status(400).json({
              error: 'Invalid tokens value',
              message: 'tokens must be a positive number',
            });
            return;
          }

          // Validate tokenType
          if (tokenType !== 'paid' && tokenType !== 'regular') {
            res.status(400).json({
              error: 'Invalid tokenType',
              message: 'tokenType must be "paid" or "regular"',
            });
            return;
          }

          // For admin, we add tokens directly without multiplier
          // This is done by calling the top-off method with the tokens / multiplier
          // since the method applies the multiplier
          const capacityMultiplier =
            config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER;
          const tokensToAdd =
            tokenType === 'paid' ? tokens / capacityMultiplier : tokens;

          // Note: Currently we only support paid tokens for admin top-up
          // Regular token top-up would require a new method on rate limiter
          if (tokenType === 'regular') {
            res.status(400).json({
              error: 'Regular token top-up not yet supported',
              message:
                'Admin can only top up paid tokens currently. Use tokenType: "paid"',
            });
            return;
          }

          await rateLimiter.topOffPaidTokensForResource(
            normalizedMethod,
            host,
            path,
            tokensToAdd,
          );

          // Get updated bucket state
          const state = await rateLimiter.getResourceBucketState(
            normalizedMethod,
            host,
            path,
          );

          res.json({
            ...state,
            topUp: {
              tokensAdded: tokens,
              tokenType,
              multiplierApplied: 1, // Admin adds raw tokens
            },
          });
          return;
        }

        // Should not reach here
        res.status(500).json({
          error: 'Internal server error',
        });
      } catch (error: any) {
        log.error('Error topping up resource bucket', {
          error: error.message,
          stack: error.stack,
        });
        res.status(500).json({
          error: 'Internal server error',
        });
      }
    }),
  );

  return rateLimitRouter;
}
