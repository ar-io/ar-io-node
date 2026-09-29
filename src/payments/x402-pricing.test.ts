/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateX402Price, x402PriceToAtomicUnits } from './x402-pricing.js';

const USDC_DECIMALS = 6;

describe('x402PriceToAtomicUnits', () => {
  it('converts prices to whole USDC atomic units', () => {
    assert.strictEqual(x402PriceToAtomicUnits(0.0001, USDC_DECIMALS), 100n);
    assert.strictEqual(x402PriceToAtomicUnits(0.001, USDC_DECIMALS), 1000n);
    assert.strictEqual(x402PriceToAtomicUnits(0.000123, USDC_DECIMALS), 123n);
    assert.strictEqual(x402PriceToAtomicUnits(1, USDC_DECIMALS), 1000000n);
  });

  it('does not let float noise add a unit', () => {
    // 0.0079 * 1e6 === 7900.000000000001 and 0.0157 * 1e6 === 15699.999999999998;
    // x402's string path quotes exactly those non-integer amounts.
    assert.strictEqual(x402PriceToAtomicUnits(0.0079, USDC_DECIMALS), 7900n);
    assert.strictEqual(x402PriceToAtomicUnits(0.0157, USDC_DECIMALS), 15700n);
    for (let k = 1; k <= 200_000; k++) {
      const units = x402PriceToAtomicUnits(k / 1e4, USDC_DECIMALS);
      if (units !== BigInt(k * 100)) {
        assert.fail(`$${k / 1e4} became ${units} units, expected ${k * 100}`);
      }
    }
  });

  it('rounds a sub-unit remainder up, never to zero', () => {
    assert.strictEqual(x402PriceToAtomicUnits(0.0000001, USDC_DECIMALS), 1n);
    assert.strictEqual(x402PriceToAtomicUnits(0.0001001, USDC_DECIMALS), 101n);
    assert.strictEqual(x402PriceToAtomicUnits(0, USDC_DECIMALS), 1n);
  });

  it('rejects prices that are not finite and non-negative', () => {
    assert.throws(() => x402PriceToAtomicUnits(NaN, USDC_DECIMALS));
    assert.throws(() => x402PriceToAtomicUnits(-0.001, USDC_DECIMALS));
    assert.throws(() => x402PriceToAtomicUnits(Infinity, USDC_DECIMALS));
  });

  it('prices small items above zero at a sub-$0.0005 per-byte rate', () => {
    // $0.045/GiB with a $0.0001 floor: every item under ~11.9 MB used to be
    // quoted as "$0.000", which x402 rejects.
    const config = {
      perBytePrice: 0.000000000042,
      minPrice: 0.0001,
      maxPrice: 1.0,
    };
    const units = (bytes: number) =>
      x402PriceToAtomicUnits(calculateX402Price(bytes, config), USDC_DECIMALS);
    assert.strictEqual(units(1), 100n);
    assert.strictEqual(units(7_306_242), 307n);
    assert.strictEqual(units(11_000_000), 462n);
    assert.strictEqual(units(29_680_638), 1247n);
  });
});
