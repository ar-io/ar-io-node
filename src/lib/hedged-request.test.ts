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
          await delay(100);
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
    let resolveStarted!: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });

    const requestPromise = executeHedgedRequest({
      candidates: ['a', 'b', 'c'],
      execute: async (_candidate, signal) => {
        resolveStarted();
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason ?? new DOMException('Aborted', 'AbortError'),
              ),
            { once: true },
          );
        });
        return 'should-not-reach';
      },
      hedgeDelayMs: 10,
      maxConcurrent: 3,
      signal: controller.signal,
    });

    await started;
    controller.abort();

    await assert.rejects(requestPromise, (err: any) => {
      assert.ok(
        err.name === 'AbortError' || err instanceof DOMException,
        `Expected AbortError, got ${err.name}: ${err.message}`,
      );
      return true;
    });
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

  it('should call acquire and onRelease for each attempt', async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    let releaseCount = 0;
    let resolveAllReleased!: () => void;
    const allReleased = new Promise<void>((r) => {
      resolveAllReleased = r;
    });

    await executeHedgedRequest({
      candidates: ['a', 'b'],
      execute: async (candidate) => {
        if (candidate === 'a') throw new Error('fail');
        return 'ok';
      },
      acquire: (c) => {
        acquired.push(c);
        return true;
      },
      onRelease: (c) => {
        released.push(c);
        if (++releaseCount === 2) resolveAllReleased();
      },
      hedgeDelayMs: 0,
      maxConcurrent: 3,
    });

    await allReleased;

    assert.deepEqual(acquired, ['a', 'b']);
    assert.deepEqual(released, ['a', 'b']);
  });

  it('should not launch second candidate while saturated, then resume when slot frees', async () => {
    const events: string[] = [];
    let resolveFirst!: () => void;
    const firstBarrier = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const resultPromise = executeHedgedRequest({
      candidates: ['a', 'b'],
      execute: async (candidate) => {
        events.push(`start:${candidate}`);
        if (candidate === 'a') {
          await firstBarrier;
          events.push(`end:a`);
          throw new Error('a failed');
        }
        events.push(`end:b`);
        return 'ok-b';
      },
      hedgeDelayMs: 20,
      maxConcurrent: 1,
    });

    // Wait well past the hedge delay — 'b' must NOT have launched yet (saturated)
    await delay(60);
    assert.ok(
      !events.includes('start:b'),
      'b should not launch while slot is saturated',
    );

    // Release the first slot — 'b' should now launch via .finally() resume
    resolveFirst();

    const result = await resultPromise;
    assert.equal(result, 'ok-b');

    const startBIdx = events.indexOf('start:b');
    const endAIdx = events.indexOf('end:a');
    assert.ok(
      startBIdx > endAIdx,
      `b (index ${startBIdx}) should start after a ends (index ${endAIdx})`,
    );
  });

  it('should skip candidate and not call onRelease when acquire returns false', async () => {
    const attempted: string[] = [];
    const released: string[] = [];
    let resolveReleased!: () => void;
    const releaseBarrier = new Promise<void>((r) => {
      resolveReleased = r;
    });

    const result = await executeHedgedRequest({
      candidates: ['blocked', 'allowed'],
      execute: async (candidate) => {
        attempted.push(candidate);
        return `ok-${candidate}`;
      },
      acquire: (candidate) => candidate !== 'blocked',
      onRelease: (c) => {
        released.push(c);
        resolveReleased();
      },
      hedgeDelayMs: 0,
      maxConcurrent: 3,
    });

    await releaseBarrier;

    assert.equal(result, 'ok-allowed');
    assert.deepEqual(attempted, ['allowed']);
    assert.deepEqual(released, ['allowed']);
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
      /No eligible candidates available/,
    );
  });
});
