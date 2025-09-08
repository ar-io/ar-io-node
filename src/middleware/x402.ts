/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @ts-expect-error-next-line
import { paymentMiddleware } from 'x402-express';
import * as config from '../config.js';

// Configure the payment middleware with the IO address and payment routes
const x402MiddlewareUsdc = paymentMiddleware(config.X_402_USDC_ADDRESS, {
  [`POST /ar-io/queue-bundle`]: {
    price: config.X_402_USDC_QUEUE_BUNDLE_PRICE_USDC,
    network: 'base-sepolia', // TODO: make this dynamic to the network.
    config: {
      description: 'Queue a bundle for processing',
    },
  },
});

export { x402MiddlewareUsdc };
