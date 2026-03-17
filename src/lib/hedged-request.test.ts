/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { executeHedgedRequest } from './hedged-request.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('executeHedgedRequest', () => {
  it('should return first candidate result when it succeeds within delay', async () => {
    const callOrder: string[] = [];

    const result = await executeHedgedRequest({
      candidates: ['a', 'b', 'c'],
      execute: async (candidate) => {
        callOrder.push(candidate);
        return `result-${candidate}`;
      },
      hedgeDelayMs: 1000,
      maxConcurrent: 3,
    });

    assert.equal(result, 'result-a');
    assert.equal(callOrder.length, 1);
    assert.equal(callOrder[0], 'a');
  });

  it('should fire hedge when first candidate is slow', async () => {
    const callOrder: string[] = [];

    const result = await executeHedgedRequest({
      candidates: ['slow', 'fast'],
      execute: async (candidate) => {
        callOrder.push(candidate);
        if (candidate === 'slow') {
          await delay(500);
          return 'slow-result';
        }
        return 'fast-result';
      },
      hedgeDelayMs: 50,
      maxConcurrent: 2,
    });

    assert.equal(result, 'fast-result');
    assert.ok(callOrder.includes('slow'));
    assert.ok(callOrder.includes('fast'));
  });

  it('should advance immediately on failure without waiting for delay', async () => {
    const callTimes: number[] = [];
    const start = Date.now();

    const result = await executeHedgedRequest({
      candidates: ['fail', 'succeed'],
      execute: async (candidate) => {
        callTimes.push(Date.now() - start);
        if (candidate === 'fail') {
          throw new Error('failed');
        }
        return 'success';
      },
      hedgeDelayMs: 5000, // long delay — should not wait for this
      maxConcurrent: 3,
    });

    assert.equal(result, 'success');
    // Second candidate should have been launched almost immediately
    assert.ok(
      callTimes[1] - callTimes[0] < 500,
      `Expected fast failover, got ${callTimes[1] - callTimes[0]}ms gap`,
    );
  });

  it('should throw AggregateError when all candidates fail', async () => {
    await assert.rejects(
      executeHedgedRequest({
        candidates: ['a', 'b', 'c'],
        execute: async (candidate) => {
          throw new Error(`${candidate} failed`);
        },
        hedgeDelayMs: 10,
        maxConcurrent: 3,
      }),
      (err: any) => {
        assert.ok(err instanceof AggregateError);
        assert.equal(err.errors.length, 3);
        return true;
      },
    );
  });

  it('should abort on client signal', async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 50);

    await assert.rejects(
      executeHedgedRequest({
        candidates: ['a', 'b', 'c'],
        execute: async (_candidate, signal) => {
          await delay(5000);
          signal.throwIfAborted();
          return 'should-not-reach';
        },
        hedgeDelayMs: 10,
        maxConcurrent: 3,
        signal: controller.signal,
      }),
      (err: any) => {
        assert.ok(
          err.name === 'AbortError' || err instanceof DOMException,
          `Expected AbortError, got ${err.name}: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('should skip candidates when canAttempt returns false', async () => {
    const attempted: string[] = [];

    const result = await executeHedgedRequest({
      candidates: ['skip-me', 'also-skip', 'use-me'],
      execute: async (candidate) => {
        attempted.push(candidate);
        return `result-${candidate}`;
      },
      canAttempt: (candidate) => candidate === 'use-me',
      hedgeDelayMs: 10,
      maxConcurrent: 3,
    });

    assert.equal(result, 'result-use-me');
    assert.deepEqual(attempted, ['use-me']);
  });

  it('should cap in-flight requests at maxConcurrent', async () => {
    let maxInFlight = 0;
    let currentInFlight = 0;

    await executeHedgedRequest({
      candidates: ['a', 'b', 'c', 'd'],
      execute: async () => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await delay(100);
        currentInFlight--;
        return 'ok';
      },
      hedgeDelayMs: 10,
      maxConcurrent: 2,
    });

    assert.ok(maxInFlight <= 2, `Expected max 2 in-flight, got ${maxInFlight}`);
  });

  it('should behave sequentially when hedgeDelayMs is 0', async () => {
    const callOrder: string[] = [];

    const result = await executeHedgedRequest({
      candidates: ['fail1', 'fail2', 'succeed'],
      execute: async (candidate) => {
        callOrder.push(candidate);
        if (candidate.startsWith('fail')) {
          throw new Error(`${candidate} failed`);
        }
        return 'success';
      },
      hedgeDelayMs: 0,
      maxConcurrent: 3,
    });

    assert.equal(result, 'success');
    assert.deepEqual(callOrder, ['fail1', 'fail2', 'succeed']);
  });

  it('should call onAcquire and onRelease for each attempt', async () => {
    const acquired: string[] = [];
    const released: string[] = [];

    await executeHedgedRequest({
      candidates: ['a', 'b'],
      execute: async (candidate) => {
        if (candidate === 'a') throw new Error('fail');
        return 'ok';
      },
      onAcquire: (c) => acquired.push(c),
      onRelease: (c) => released.push(c),
      hedgeDelayMs: 0,
      maxConcurrent: 3,
    });

    // Allow microtasks to complete (finally blocks may still be pending)
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(acquired, ['a', 'b']);
    assert.deepEqual(released, ['a', 'b']);
  });

  it('should throw when no eligible candidates are available', async () => {
    await assert.rejects(
      executeHedgedRequest({
        candidates: ['a', 'b'],
        execute: async () => 'should not run',
        canAttempt: () => false,
        hedgeDelayMs: 10,
        maxConcurrent: 3,
      }),
      /No eligible candidates available|All hedged request candidates failed/,
    );
  });
});
