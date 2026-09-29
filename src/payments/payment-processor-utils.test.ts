/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { Request } from 'express';

import { createTestLogger } from '../../test/test-logger.js';
import * as metrics from '../metrics.js';
import { RateLimiter } from '../limiter/types.js';
import { processPaymentAndTopUp } from './payment-processor-utils.js';
import { X402UsdcProcessor } from './x402-usdc-processor.js';

const log = createTestLogger({ suite: 'processPaymentAndTopUp' });

const req = (headers: Record<string, string> = { host: 'example.com' }) => {
  const mockRequest = {
    method: 'GET',
    originalUrl: '/ar-io/x402/test',
    protocol: 'https',
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  };
  return mockRequest as unknown as Request;
};

const rateLimiter = {
  topOffPaidTokens: async () => undefined,
  topOffPaidTokensForResource: async () => undefined,
} as unknown as RateLimiter;

// A processor that passes the `instanceof X402UsdcProcessor` checks while its
// network calls are stubbed. Payment amounts are USDC atomic units (6 decimals).
function makeProcessor(overrides: Record<string, unknown> = {}) {
  const processor = new X402UsdcProcessor({
    walletAddress: '0x1234567890123456789012345678901234567890',
    network: 'base',
    perBytePrice: 0.000001,
    minPrice: 0.001,
    maxPrice: 1.0,
    facilitatorUrl: 'https://facilitator.example.com',
    settleTimeoutMs: 5000,
    version: 1,
    log,
  } as any);
  Object.assign(processor, {
    extractPayment: () => ({
      network: 'base',
      scheme: 'exact',
      payload: { authorization: { value: '250000' } }, // $0.25
    }),
    calculateRequirements: () => ({}) as any,
    verifyPayment: async () => ({ isValid: true }),
    settlePayment: async () => ({ success: true, responseHeader: 'header' }),
    paymentToContentSize: () => 1000,
    paymentToTokens: () => 10,
    ...overrides,
  });
  return processor;
}

async function outcomeCount(outcome: string, target = 'ip') {
  const { values } = await metrics.x402PaymentCounter.get();
  return (
    values.find(
      (v: any) => v.labels.outcome === outcome && v.labels.target === target,
    )?.value ?? 0
  );
}

async function settledUsdc(target = 'ip') {
  const { values } = await metrics.x402PaymentSettledUsdcCounter.get();
  return values.find((v: any) => v.labels.target === target)?.value ?? 0;
}

describe('processPaymentAndTopUp metrics', () => {
  afterEach(() => mock.restoreAll());

  it('counts a settled payment and its USDC amount', async () => {
    const before = await outcomeCount('settled');
    const beforeUsdc = await settledUsdc();

    const result = await processPaymentAndTopUp(
      rateLimiter,
      makeProcessor() as any,
      req(),
      log,
      { type: 'ip' },
    );

    assert.equal(result.success, true);
    assert.equal(await outcomeCount('settled'), before + 1);
    // 250000 atomic units = $0.25
    assert.ok(Math.abs((await settledUsdc()) - (beforeUsdc + 0.25)) < 1e-9);
  });

  // The case that motivated this: a mainnet deployment whose facilitator cannot
  // settle keeps serving 402s and earning nothing. 402 counts alone look
  // identical to a healthy paywall nobody has paid yet.
  it('counts a settlement failure separately from a verification failure', async () => {
    const beforeSettle = await outcomeCount('settle_failed');
    const beforeVerify = await outcomeCount('verify_failed');

    await processPaymentAndTopUp(
      rateLimiter,
      makeProcessor({
        settlePayment: async () => ({
          success: false,
          errorReason: 'facilitator does not support this network',
        }),
      }) as any,
      req(),
      log,
      { type: 'ip' },
    );
    assert.equal(await outcomeCount('settle_failed'), beforeSettle + 1);

    await processPaymentAndTopUp(
      rateLimiter,
      makeProcessor({
        verifyPayment: async () => ({
          isValid: false,
          invalidReason: 'insufficient_funds',
        }),
      }) as any,
      req(),
      log,
      { type: 'ip' },
    );
    assert.equal(await outcomeCount('verify_failed'), beforeVerify + 1);
  });

  // A payment that settles on-chain and then fails to grant access is the worst
  // case to misreport: the funds moved. It must not be filed as a generic
  // error, and the revenue must still be counted.
  it('records settled USDC and topup_failed when the top-up throws after settlement', async () => {
    const beforeUsdc = await settledUsdc();
    const beforeTopup = await outcomeCount('topup_failed');
    const beforeError = await outcomeCount('error');
    const beforeSettled = await outcomeCount('settled');

    const failingLimiter = {
      topOffPaidTokens: async () => {
        throw new Error('redis unavailable');
      },
      topOffPaidTokensForResource: async () => undefined,
    } as unknown as RateLimiter;

    const result = await processPaymentAndTopUp(
      failingLimiter,
      makeProcessor() as any,
      req(),
      log,
      { type: 'ip' },
    );

    assert.equal(result.success, false);
    // The payment settled, so the money is counted...
    assert.ok(Math.abs((await settledUsdc()) - (beforeUsdc + 0.25)) < 1e-9);
    // ...attributed to the stage that actually failed...
    assert.equal(await outcomeCount('topup_failed'), beforeTopup + 1);
    // ...and not double-counted as a generic error or a clean success.
    assert.equal(await outcomeCount('error'), beforeError);
    assert.equal(await outcomeCount('settled'), beforeSettled);
  });

  it('counts a request that carried no payment header', async () => {
    const before = await outcomeCount('no_payment_header');

    const result = await processPaymentAndTopUp(
      rateLimiter,
      makeProcessor({ extractPayment: () => undefined }) as any,
      req(),
      log,
      { type: 'ip' },
    );

    assert.equal(result.success, false);
    assert.equal(await outcomeCount('no_payment_header'), before + 1);
  });

  it('does not record settled USDC when nothing settled', async () => {
    const beforeUsdc = await settledUsdc();

    await processPaymentAndTopUp(
      rateLimiter,
      makeProcessor({
        settlePayment: async () => ({ success: false, errorReason: 'nope' }),
      }) as any,
      req(),
      log,
      { type: 'ip' },
    );

    assert.equal(await settledUsdc(), beforeUsdc);
  });
});
