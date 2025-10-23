/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Configuration for x402 pricing calculations.
 */
export interface X402PricingConfig {
  perBytePrice: number;
  minPrice: number;
  maxPrice: number;
}

/**
 * Calculate x402 USDC price for content based on size and price constraints.
 *
 * The calculation applies min/max bounds to the per-byte price:
 * - price = contentLength × perBytePrice
 * - bounded by [minPrice, maxPrice]
 *
 * @param contentLength - Size of content in bytes
 * @param config - Pricing configuration
 * @returns Unformatted price in USD (caller must format as needed)
 *
 * @example
 * const price = calculateX402Price(1048576, {
 *   perBytePrice: 0.0000000001,
 *   minPrice: 0.001,
 *   maxPrice: 1.0
 * });
 * // price = 0.0001048576 (before formatting)
 */
export function calculateX402Price(
  contentLength: number,
  config: X402PricingConfig,
): number {
  const priceInUSD = contentLength * config.perBytePrice;
  return Math.min(Math.max(priceInUSD, config.minPrice), config.maxPrice);
}
