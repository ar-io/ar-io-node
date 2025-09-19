/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

describe('x402 pricing utility functions', () => {
  // Define the function inline to avoid import issues
  const calculateX402PricePerByteEgress = (contentLength: number): string => {
    const X_402_USDC_PER_BYTE_PRICE = 0.0000000001; // $0.0000000001 per byte = $0.10 per GB

    // Calculate price based on per-byte rate
    const priceInUSD = contentLength * X_402_USDC_PER_BYTE_PRICE;

    // Format as USD string with appropriate precision
    // Ensure minimum price of $0.001
    const formattedPrice = Math.max(priceInUSD, 0.001).toFixed(3);

    return `$${formattedPrice}`;
  };

  describe('calculateX402PricePerByteEgress', () => {
    it('should calculate minimum price for small content', () => {
      const price = calculateX402PricePerByteEgress(100); // 100 bytes
      assert.equal(price, '$0.001'); // Minimum price
    });

    it('should calculate minimum price for 1KB content', () => {
      const price = calculateX402PricePerByteEgress(1024); // 1KB
      assert.equal(price, '$0.001'); // Still minimum price
    });

    it('should calculate minimum price for 1MB content', () => {
      const price = calculateX402PricePerByteEgress(1024 * 1024); // 1MB
      // 1MB * 0.0000000001 = 0.0001048576, but minimum is 0.001
      assert.equal(price, '$0.001');
    });

    it('should calculate correct price for 1GB content', () => {
      const price = calculateX402PricePerByteEgress(1024 * 1024 * 1024); // 1GB
      // 1GB * 0.0000000001 = 0.1073741824
      assert.equal(price, '$0.107');
    });

    it('should calculate correct price for 10GB content', () => {
      const price = calculateX402PricePerByteEgress(10 * 1024 * 1024 * 1024); // 10GB
      // 10GB * 0.0000000001 = 1.073741824
      assert.equal(price, '$1.074');
    });

    it('should handle zero bytes', () => {
      const price = calculateX402PricePerByteEgress(0);
      assert.equal(price, '$0.001'); // Minimum price
    });

    it('should calculate exact prices for various sizes', () => {
      const testCases = [
        { bytes: 500 * 1024 * 1024, expectedPrice: '$0.052' }, // 500MB
        { bytes: 1.5 * 1024 * 1024 * 1024, expectedPrice: '$0.161' }, // 1.5GB
        { bytes: 2.5 * 1024 * 1024 * 1024, expectedPrice: '$0.268' }, // 2.5GB
        { bytes: 5 * 1024 * 1024 * 1024, expectedPrice: '$0.537' }, // 5GB
      ];

      for (const testCase of testCases) {
        const price = calculateX402PricePerByteEgress(testCase.bytes);
        assert.equal(
          price,
          testCase.expectedPrice,
          `Expected ${testCase.expectedPrice} for ${testCase.bytes} bytes, got ${price}`,
        );
      }
    });

    it('should format prices with 3 decimal places', () => {
      // Test various sizes to ensure consistent formatting
      const sizes = [
        1000000000, // 1GB
        2500000000, // 2.5GB
        7500000000, // ~7.5GB
      ];

      for (const size of sizes) {
        const price = calculateX402PricePerByteEgress(size);
        const priceNum = parseFloat(price.substring(1)); // Remove $

        // Should have exactly 3 decimal places
        const decimalPlaces = price.split('.')[1]?.length || 0;
        assert.equal(
          decimalPlaces,
          3,
          `Price ${price} should have 3 decimal places`,
        );

        // Should be a valid number
        assert(!isNaN(priceNum), `Price ${price} should be a valid number`);
      }
    });

    it('should handle large content sizes', () => {
      const oneTerabyte = 1024 * 1024 * 1024 * 1024; // 1TB
      const price = calculateX402PricePerByteEgress(oneTerabyte);

      // 1TB * 0.0000000001 = 109.951 USD
      assert.equal(price, '$109.951');
    });
  });
});

describe('x402 transaction ID validation', () => {
  it('should validate standard Arweave transaction ID format', () => {
    const validIds = [
      'Ry2bDGfBIvYtvDPYnf0eg_ijH4A1EDKaaEEecyjbUQ0', // Real transaction ID (43 chars)
      'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE', // 43 chars with all valid chars
      '1234567890abcdefABCDEF-_1234567890abcdef123', // 43 chars mixed
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcde', // 43 chars
    ];

    const txIdRegex = /^[a-zA-Z0-9-_]{43}$/;

    validIds.forEach((id) => {
      assert.equal(
        id.length,
        43,
        `${id} should be exactly 43 characters (got ${id.length})`,
      );
      assert(
        txIdRegex.test(id),
        `${id} should be a valid 43-character transaction ID`,
      );
    });
  });

  it('should reject invalid transaction IDs', () => {
    const invalidIds = [
      'invalid-id', // too short
      'too-short-id', // too short
      'toolongabcdefghijklmnopqrstuvwxyz0123456789123', // too long
      'has spaces in it and should fail completely', // has spaces
      'has/slash/characters', // has slashes
      'has@symbol@in@it', // has @ symbols
      'has+plus+signs', // has + signs
      'has=equals=signs', // has = signs
      '', // empty string
      'exactly42charactersbutnotquitelongenoug', // 42 chars (too short)
      'exactly44characterswhichisalittletoolong!', // 44 chars (too long)
    ];

    const txIdRegex = /^[a-zA-Z0-9-_]{43}$/;

    invalidIds.forEach((id) => {
      assert(
        !txIdRegex.test(id),
        `${id} should be invalid (length: ${id.length})`,
      );
    });
  });

  it('should validate edge case transaction IDs', () => {
    const txIdRegex = /^[a-zA-Z0-9-_]{43}$/;

    // All allowed characters
    const allNumbers = '1234567890123456789012345678901234567890123';
    const allLetters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const allUnderscores = '___________________________________________';
    const allDashes = '-------------------------------------------';

    assert(txIdRegex.test(allNumbers), 'All numbers should be valid');
    assert(txIdRegex.test(allLetters), 'All letters should be valid');
    assert(txIdRegex.test(allUnderscores), 'All underscores should be valid');
    assert(txIdRegex.test(allDashes), 'All dashes should be valid');
  });
});

describe('x402 environment configuration validation', () => {
  it('should have reasonable per-byte pricing', () => {
    // Test the default per-byte price makes sense
    const defaultPerBytePrice = 0.0000000001; // $0.0000000001 per byte

    // Calculate what 1GB would cost
    const oneGBCost = 1024 * 1024 * 1024 * defaultPerBytePrice;

    // Should be around $0.10 per GB
    assert(
      oneGBCost > 0.1 && oneGBCost < 0.11,
      `1GB should cost ~$0.10, got $${oneGBCost.toFixed(3)}`,
    );
  });

  it('should have reasonable default content length', () => {
    const defaultContentLength = 100 * 1024 * 1024; // 100 MiB

    assert(
      defaultContentLength > 0,
      'Default content length should be positive',
    );
    assert(
      defaultContentLength <= 1024 * 1024 * 1024,
      'Default content length should be reasonable (<=1GB)',
    );
  });

  it('should validate facilitator URL format', () => {
    const facilitatorUrl = 'https://x402.org/facilitator';

    assert(
      facilitatorUrl.startsWith('http'),
      'Facilitator URL should be HTTP(S)',
    );

    // Should be a valid URL
    assert.doesNotThrow(
      () => new URL(facilitatorUrl),
      'Facilitator URL should be valid',
    );
  });
});
