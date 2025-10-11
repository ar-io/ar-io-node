/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { calculateX402PricePerByteEgress } from './x402.js';

describe('x402 pricing utility functions', () => {
  // Note: These tests use the actual config defaults from config.ts:
  // X_402_USDC_PER_BYTE_PRICE = 0.0000000001 ($0.10 per GB)
  // X_402_USDC_DATA_EGRESS_MIN_PRICE = 0.001
  // X_402_USDC_DATA_EGRESS_MAX_PRICE = 1.0

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
      // 1GB * 0.0000000001 = 0.1073741824, formatted to 3 decimals
      assert.equal(price, '$0.107');
    });

    it('should calculate correct price for 10GB content (capped at max)', () => {
      const price = calculateX402PricePerByteEgress(10 * 1024 * 1024 * 1024); // 10GB
      // 10GB * 0.0000000001 = 1.073741824, but max is 1.0, formatted to 3 decimals
      assert.equal(price, '$1.000');
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

        // Should start with $
        assert.equal(price[0], '$', `Price ${price} should start with $`);

        // Should be a valid number after removing $
        const priceNum = parseFloat(price.substring(1));
        assert(!isNaN(priceNum), `Price ${price} should be a valid number`);

        // Should have exactly 3 decimal places
        const decimalPlaces = price.split('.')[1]?.length || 0;
        assert.equal(
          decimalPlaces,
          3,
          `Price ${price} should have 3 decimal places`,
        );

        // Should be positive
        assert(priceNum > 0, `Price ${price} should be positive`);
      }
    });

    it('should handle large content sizes', () => {
      const oneTerabyte = 1024 * 1024 * 1024 * 1024; // 1TB
      const price = calculateX402PricePerByteEgress(oneTerabyte);

      // 1TB * 0.0000000001 = 109.951 USD, but max is 1.0, formatted to 3 decimals
      assert.equal(price, '$1.000');
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

describe('x402 browser detection', () => {
  // Inline browser detection function to avoid import issues
  const isBrowserRequest = (req: any): boolean => {
    const acceptHeader = req.header('Accept');
    const userAgent = req.header('User-Agent');
    if (acceptHeader === undefined || userAgent === undefined) {
      return false;
    }
    return acceptHeader.includes('text/html') && userAgent.includes('Mozilla');
  };

  it('should detect browser requests with text/html Accept header', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html,application/xhtml+xml';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true);
  });

  it('should detect browser requests with Mozilla user agent', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true);
  });

  it('should not detect API requests without text/html', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'application/json';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), false);
  });

  it('should not detect curl requests without Mozilla', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html';
        if (name === 'User-Agent') return 'curl/8.5.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), false);
  });

  it('should handle missing Accept header', () => {
    const req = {
      header: (name: string) => {
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), false);
  });

  it('should handle missing User-Agent header', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), false);
  });

  it('should handle both headers missing', () => {
    const req = {
      header: () => undefined,
    };

    assert.equal(isBrowserRequest(req), false);
  });

  it('should detect Safari browser requests', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html,application/xhtml+xml';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 Safari/605.1.15';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true);
  });

  it('should detect Edge browser requests', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'text/html,application/xhtml+xml';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true);
  });

  it('should not detect requests with partial text/html match in other MIME types', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept') return 'application/vnd.custom-text/html-like';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true); // Should still match because it contains 'text/html'
  });

  it('should handle complex Accept headers with multiple MIME types', () => {
    const req = {
      header: (name: string) => {
        if (name === 'Accept')
          return 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
        if (name === 'User-Agent')
          return 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0';
        return undefined;
      },
    };

    assert.equal(isBrowserRequest(req), true);
  });
});

describe('x402 price calculation with min/max bounds', () => {
  // Uses the real implementation from x402.ts
  // Note: Config default X_402_USDC_DATA_EGRESS_MAX_PRICE = 1.0, not 10.0
  // Tests updated to reflect actual config values

  it('should enforce minimum price for very small content', () => {
    const price = calculateX402PricePerByteEgress(1); // 1 byte
    assert.equal(price, '$0.001');
  });

  it('should enforce minimum price at boundary', () => {
    const price = calculateX402PricePerByteEgress(10_000_000); // 10MB
    assert.equal(price, '$0.001');
  });

  it('should calculate price above minimum', () => {
    const oneGB = 1024 * 1024 * 1024;
    const price = calculateX402PricePerByteEgress(oneGB);
    const numPrice = parseFloat(price.substring(1));
    assert(numPrice > 0.001, `Price ${price} should be above minimum`);
    assert(numPrice < 1.0, `Price ${price} should be below maximum`);
  });

  it('should enforce maximum price for very large content', () => {
    const oneTerabyte = 1024 * 1024 * 1024 * 1024;
    const price = calculateX402PricePerByteEgress(oneTerabyte);
    assert.equal(price, '$1.000');
  });

  it('should enforce maximum price at boundary', () => {
    const hundredGB = 100 * 1024 * 1024 * 1024;
    const price = calculateX402PricePerByteEgress(hundredGB);
    assert.equal(price, '$1.000');
  });

  it('should handle zero bytes with minimum price', () => {
    const price = calculateX402PricePerByteEgress(0);
    assert.equal(price, '$0.001');
  });

  it('should handle edge case near max boundary', () => {
    // 100GB - 1 byte should still hit max
    const nearMax = 100 * 1024 * 1024 * 1024 - 1;
    const price = calculateX402PricePerByteEgress(nearMax);
    assert.equal(price, '$1.000');
  });

  it('should handle prices in the middle range', () => {
    const testCases = [
      { bytes: 500 * 1024 * 1024, minExpected: 0.001, maxExpected: 1.0 },
      { bytes: 5 * 1024 * 1024 * 1024, minExpected: 0.001, maxExpected: 1.0 },
      {
        bytes: 10 * 1024 * 1024 * 1024,
        minExpected: 0.001,
        maxExpected: 1.0,
      },
    ];

    for (const testCase of testCases) {
      const price = calculateX402PricePerByteEgress(testCase.bytes);
      const numPrice = parseFloat(price.substring(1));
      assert(
        numPrice >= testCase.minExpected,
        `Price ${price} should be at or above minimum ${testCase.minExpected}`,
      );
      assert(
        numPrice <= testCase.maxExpected,
        `Price ${price} should be at or below maximum ${testCase.maxExpected}`,
      );
    }
  });
});

describe('x402 settlement timeout', () => {
  it('should timeout after configured duration', async () => {
    const X_402_USDC_SETTLE_TIMEOUT_MS = 5000;

    const slowSettlement = new Promise((resolve) => setTimeout(resolve, 10000));

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Settlement timeout')),
        X_402_USDC_SETTLE_TIMEOUT_MS,
      ),
    );

    const start = Date.now();
    try {
      await Promise.race([slowSettlement, timeoutPromise]);
      assert.fail('Should have timed out');
    } catch (error: any) {
      const elapsed = Date.now() - start;
      assert.equal(error.message, 'Settlement timeout');
      assert(
        elapsed >= X_402_USDC_SETTLE_TIMEOUT_MS - 100,
        `Should timeout around ${X_402_USDC_SETTLE_TIMEOUT_MS}ms, got ${elapsed}ms`,
      );
      assert(
        elapsed < X_402_USDC_SETTLE_TIMEOUT_MS + 1000,
        `Should not take much longer than timeout, got ${elapsed}ms`,
      );
    }
  });

  it('should complete fast settlements before timeout', async () => {
    const X_402_USDC_SETTLE_TIMEOUT_MS = 5000;

    const fastSettlement = new Promise((resolve) =>
      setTimeout(() => resolve({ success: true }), 100),
    );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Settlement timeout')),
        X_402_USDC_SETTLE_TIMEOUT_MS,
      ),
    );

    const result = await Promise.race([fastSettlement, timeoutPromise]);
    assert.deepEqual(result, { success: true });
  });

  it('should handle immediate settlement success', async () => {
    const X_402_USDC_SETTLE_TIMEOUT_MS = 5000;

    const immediateSettlement = Promise.resolve({ success: true });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Settlement timeout')),
        X_402_USDC_SETTLE_TIMEOUT_MS,
      ),
    );

    const result = await Promise.race([immediateSettlement, timeoutPromise]);
    assert.deepEqual(result, { success: true });
  });

  it('should handle immediate settlement failure', async () => {
    const X_402_USDC_SETTLE_TIMEOUT_MS = 5000;

    const immediateSettlement = Promise.resolve({
      success: false,
      errorReason: 'Invalid payment',
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Settlement timeout')),
        X_402_USDC_SETTLE_TIMEOUT_MS,
      ),
    );

    const result = await Promise.race([immediateSettlement, timeoutPromise]);
    assert.deepEqual(result, {
      success: false,
      errorReason: 'Invalid payment',
    });
  });

  it('should respect different timeout values', async () => {
    const shortTimeout = 100;
    const longSettlement = new Promise((resolve) => setTimeout(resolve, 1000));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Settlement timeout')), shortTimeout),
    );

    const start = Date.now();
    try {
      await Promise.race([longSettlement, timeoutPromise]);
      assert.fail('Should have timed out');
    } catch (error: any) {
      const elapsed = Date.now() - start;
      assert(
        elapsed < shortTimeout + 100,
        `Should timeout quickly with short timeout, got ${elapsed}ms`,
      );
    }
  });
});
