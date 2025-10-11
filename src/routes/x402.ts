/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router } from 'express';
import { paymentMiddleware } from 'x402-express';
import * as config from '../config.js';

const x402Router = Router();

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

export { x402Router };
