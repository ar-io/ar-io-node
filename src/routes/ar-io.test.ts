/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildArIoInfo } from './ar-io-info-builder.js';

describe('buildArIoInfo', () => {
  it('should return basic info when both features are disabled', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: { allow: [] },
      ans104IndexFilter: { allow: [] },
      release: 'r123',
    });

    assert.strictEqual(result.wallet, 'test-wallet');
    assert.strictEqual(result.processId, 'test-process');
    assert.deepStrictEqual(result.ans104UnbundleFilter, { allow: [] });
    assert.deepStrictEqual(result.ans104IndexFilter, { allow: [] });
    assert.deepStrictEqual(result.supportedManifestVersions, [
      '0.1.0',
      '0.2.0',
    ]);
    assert.strictEqual(result.release, 'r123');
    assert.strictEqual(result.rateLimiter, undefined);
    assert.strictEqual(result.x402, undefined);
  });

  it('should include rateLimiter when enabled', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      rateLimiter: {
        enabled: true,
        resourceCapacity: 1000000,
        resourceRefillRate: 100,
        ipCapacity: 100000,
        ipRefillRate: 20,
      },
    });

    assert.notStrictEqual(result.rateLimiter, undefined);
    assert.strictEqual(result.rateLimiter.enabled, true);
    assert.notStrictEqual(result.rateLimiter.dataEgress, undefined);
    assert.notStrictEqual(result.rateLimiter.dataEgress.buckets, undefined);

    const resourceBucket = result.rateLimiter.dataEgress.buckets.resource;
    assert.strictEqual(resourceBucket.capacity, 1000000);
    assert.strictEqual(resourceBucket.refillRate, 100);
    assert.strictEqual(resourceBucket.capacityBytes, 1000000 * 1024);
    assert.strictEqual(resourceBucket.refillRateBytesPerSec, 100 * 1024);

    const ipBucket = result.rateLimiter.dataEgress.buckets.ip;
    assert.strictEqual(ipBucket.capacity, 100000);
    assert.strictEqual(ipBucket.refillRate, 20);
    assert.strictEqual(ipBucket.capacityBytes, 100000 * 1024);
    assert.strictEqual(ipBucket.refillRateBytesPerSec, 20 * 1024);

    assert.strictEqual(result.x402, undefined);
  });

  it('should include x402 when enabled with testnet', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      x402: {
        enabled: true,
        network: 'base-sepolia',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://x402.org/facilitator',
        perBytePrice: 0.0000000001,
        minPrice: 0.001,
        maxPrice: 1.0,
        capacityMultiplier: 10,
      },
    });

    assert.notStrictEqual(result.x402, undefined);
    assert.strictEqual(result.x402.enabled, true);
    assert.strictEqual(result.x402.network, 'base-sepolia');
    assert.strictEqual(
      result.x402.walletAddress,
      '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
    );
    assert.strictEqual(
      result.x402.facilitatorUrl,
      'https://x402.org/facilitator',
    );

    const pricing = result.x402.dataEgress.pricing;
    assert.strictEqual(pricing.perBytePrice, '0.0000000001');
    assert.strictEqual(pricing.minPrice, '0.001000');
    assert.strictEqual(pricing.maxPrice, '1.000000');
    assert.strictEqual(pricing.currency, 'USDC');

    assert.strictEqual(pricing.exampleCosts['1KB'], 0.001); // min price applies
    assert.strictEqual(
      pricing.exampleCosts['1MB'],
      Number(Math.max(0.0000000001 * 1048576, 0.001).toFixed(6)),
    );
    assert.strictEqual(
      pricing.exampleCosts['1GB'],
      Number(
        Math.min(Math.max(0.0000000001 * 1073741824, 0.001), 1.0).toFixed(6),
      ),
    );

    assert.strictEqual(
      result.x402.dataEgress.rateLimiterCapacityMultiplier,
      10,
    );

    assert.strictEqual(result.rateLimiter, undefined);
  });

  it('should include x402 when enabled with mainnet', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      x402: {
        enabled: true,
        network: 'base',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://facilitator.x402.rs',
        perBytePrice: 0.0000000001,
        minPrice: 0.001,
        maxPrice: 1.0,
        capacityMultiplier: 10,
      },
    });

    assert.notStrictEqual(result.x402, undefined);
    assert.strictEqual(result.x402.network, 'base');
    assert.strictEqual(result.rateLimiter, undefined);
  });

  it('should include both rateLimiter and x402 when both are enabled', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      rateLimiter: {
        enabled: true,
        resourceCapacity: 1000000,
        resourceRefillRate: 100,
        ipCapacity: 100000,
        ipRefillRate: 20,
      },
      x402: {
        enabled: true,
        network: 'base-sepolia',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://x402.org/facilitator',
        perBytePrice: 0.0000000001,
        minPrice: 0.001,
        maxPrice: 1.0,
        capacityMultiplier: 10,
      },
    });

    assert.notStrictEqual(result.rateLimiter, undefined);
    assert.notStrictEqual(result.x402, undefined);
    assert.strictEqual(result.rateLimiter.enabled, true);
    assert.strictEqual(result.x402.enabled, true);
  });

  it('should correctly calculate convenience fields for rate limiter', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      rateLimiter: {
        enabled: true,
        resourceCapacity: 500,
        resourceRefillRate: 10,
        ipCapacity: 200,
        ipRefillRate: 5,
      },
    });

    const resourceBucket = result.rateLimiter.dataEgress.buckets.resource;
    assert.strictEqual(resourceBucket.capacityBytes, 500 * 1024);
    assert.strictEqual(resourceBucket.refillRateBytesPerSec, 10 * 1024);

    const ipBucket = result.rateLimiter.dataEgress.buckets.ip;
    assert.strictEqual(ipBucket.capacityBytes, 200 * 1024);
    assert.strictEqual(ipBucket.refillRateBytesPerSec, 5 * 1024);
  });

  it('should correctly calculate example costs for x402', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      x402: {
        enabled: true,
        network: 'base',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://facilitator.x402.rs',
        perBytePrice: 0.0000001, // Higher price to test calculations
        minPrice: 0.0001,
        maxPrice: 500.0,
        capacityMultiplier: 10,
      },
    });

    const costs = result.x402.dataEgress.pricing.exampleCosts;
    const perBytePrice = 0.0000001;
    const minPrice = 0.0001;
    const maxPrice = 500.0;

    // 1KB cost should be max(perBytePrice * 1024, minPrice)
    const expected1KB = Number(
      Math.max(perBytePrice * 1024, minPrice).toFixed(6),
    );
    assert.strictEqual(costs['1KB'], expected1KB);

    // 1MB cost
    const expected1MB = Number(
      Math.max(perBytePrice * 1048576, minPrice).toFixed(6),
    );
    assert.strictEqual(costs['1MB'], expected1MB);

    // 1GB cost should be min(max(perBytePrice * 1073741824, minPrice), maxPrice)
    const expected1GB = Number(
      Math.min(Math.max(perBytePrice * 1073741824, minPrice), maxPrice).toFixed(
        6,
      ),
    );
    assert.strictEqual(costs['1GB'], expected1GB);
  });

  it('should apply minPrice correctly when perBytePrice is very low', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      x402: {
        enabled: true,
        network: 'base',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://facilitator.x402.rs',
        perBytePrice: 0.0000000001, // Very low price
        minPrice: 0.01, // High min
        maxPrice: 1.0,
        capacityMultiplier: 10,
      },
    });

    const costs = result.x402.dataEgress.pricing.exampleCosts;

    // All costs should be at least minPrice
    assert.ok(costs['1KB'] >= 0.01);
    assert.ok(costs['1MB'] >= 0.01);
    assert.ok(costs['1GB'] >= 0.01);
  });

  it('should apply maxPrice correctly when calculated cost is very high', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      x402: {
        enabled: true,
        network: 'base',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://facilitator.x402.rs',
        perBytePrice: 0.001, // High price per byte
        minPrice: 0.001,
        maxPrice: 10.0, // Low max
        capacityMultiplier: 10,
      },
    });

    const costs = result.x402.dataEgress.pricing.exampleCosts;

    // 1GB cost should be capped at maxPrice
    assert.ok(costs['1GB'] <= 10.0);
    assert.strictEqual(costs['1GB'], 10.0); // Should hit the max
  });

  it('should not expose internal implementation details', () => {
    const result = buildArIoInfo({
      wallet: 'test-wallet',
      processId: 'test-process',
      ans104UnbundleFilter: {},
      ans104IndexFilter: {},
      release: 'r123',
      rateLimiter: {
        enabled: true,
        resourceCapacity: 1000000,
        resourceRefillRate: 100,
        ipCapacity: 100000,
        ipRefillRate: 20,
      },
      x402: {
        enabled: true,
        network: 'base',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        facilitatorUrl: 'https://facilitator.x402.rs',
        perBytePrice: 0.0000000001,
        minPrice: 0.001,
        maxPrice: 1.0,
        capacityMultiplier: 10,
      },
    });

    const resultStr = JSON.stringify(result);

    // Verify no internal details are exposed
    assert.strictEqual(resultStr.includes('CDP'), false);
    assert.strictEqual(resultStr.includes('REDIS'), false);
    assert.strictEqual(resultStr.toLowerCase().includes('allowlist'), false);
    assert.strictEqual(resultStr.includes('API_KEY'), false);

    // Verify structure doesn't include internal implementation details
    assert.strictEqual(result.rateLimiter.type, undefined);
    assert.strictEqual(
      result.rateLimiter.dataEgress.rateLimitedEndpoints,
      undefined,
    );
    assert.strictEqual(result.x402.ui, undefined);
  });
});
