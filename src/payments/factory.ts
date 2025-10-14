/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as config from '../config.js';
import log from '../log.js';
import { PaymentProcessor } from './types.js';
import { X402UsdcProcessor } from './x402-usdc-processor.js';

/**
 * Create a payment processor based on configuration
 *
 * @returns PaymentProcessor instance or undefined if payments are disabled
 */
export function createPaymentProcessor(): PaymentProcessor | undefined {
  if (!config.ENABLE_X_402_USDC_DATA_EGRESS) {
    log.info('[PaymentProcessor] x402 USDC payments disabled');
    return undefined;
  }

  if (
    config.X_402_USDC_WALLET_ADDRESS === undefined ||
    config.X_402_USDC_WALLET_ADDRESS === ''
  ) {
    log.warn(
      '[PaymentProcessor] x402 USDC enabled but no wallet address configured',
    );
    return undefined;
  }

  log.info('[PaymentProcessor] Creating x402 USDC payment processor', {
    network: config.X_402_USDC_NETWORK,
    facilitatorUrl: config.X_402_USDC_FACILITATOR_URL,
    walletAddress: config.X_402_USDC_WALLET_ADDRESS,
  });

  return new X402UsdcProcessor({
    walletAddress: config.X_402_USDC_WALLET_ADDRESS,
    network: config.X_402_USDC_NETWORK as 'base' | 'base-sepolia',
    perBytePrice: config.X_402_USDC_PER_BYTE_PRICE,
    minPrice: config.X_402_USDC_DATA_EGRESS_MIN_PRICE,
    maxPrice: config.X_402_USDC_DATA_EGRESS_MAX_PRICE,
    facilitatorUrl:
      config.X_402_USDC_FACILITATOR_URL as `${string}://${string}`,
    settleTimeoutMs: config.X_402_USDC_SETTLE_TIMEOUT_MS,
    version: 1, // x402 protocol version
    cdpClientKey: config.X_402_CDP_CLIENT_KEY,
    appName: config.X_402_APP_NAME,
    appLogo: config.X_402_APP_LOGO,
    sessionTokenEndpoint: config.X_402_SESSION_TOKEN_ENDPOINT,
  });
}
