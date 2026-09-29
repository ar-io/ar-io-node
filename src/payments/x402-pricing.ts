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

/**
 * Convert a USD price to a whole number of the payment asset's atomic units,
 * rounding up so that no non-zero price is quoted as free.
 *
 * x402's own string path (`processPriceToAtomicAmount('$0.0079', network)`)
 * is not usable for computed prices: it multiplies a float by
 * `10 ** decimals` and stringifies the result, which quotes amounts such as
 * "7900.000000000001" that no client can pay, and its money schema rejects
 * any price under $0.0001. Rounding the price to a few decimals first only
 * moves the problem, from float noise to prices that round to zero.
 *
 * @param priceUsd - Price in USD, as returned by calculateX402Price
 * @param decimals - Decimals of the payment asset (6 for USDC)
 * @returns Atomic units, at least 1
 */
export function x402PriceToAtomicUnits(
  priceUsd: number,
  decimals: number,
): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new Error(`Invalid x402 price: ${priceUsd}`);
  }
  // Drop float noise before rounding up: 0.0079 * 1e6 is 7900.000000000001,
  // which would otherwise round up to 7901.
  const scaled = Number((priceUsd * 10 ** decimals).toPrecision(12));
  return BigInt(Math.max(1, Math.ceil(scaled)));
}
