/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  describe('constructor', () => {
    it('should create a semaphore with the specified permits', () => {
      const sem = new Semaphore(3);
      assert.strictEqual(sem.availablePermits(), 3);
    });

    it('should throw if permits is less than 1', () => {
      assert.throws(() => new Semaphore(0), /at least 1/);
      assert.throws(() => new Semaphore(-1), /at least 1/);
    });
  });

  describe('acquire and release', () => {
    let sem: Semaphore;

    beforeEach(() => {
      sem = new Semaphore(2);
    });

    it('should acquire immediately when permits are available', async () => {
      await sem.acquire();
      assert.strictEqual(sem.availablePermits(), 1);

      await sem.acquire();
      assert.strictEqual(sem.availablePermits(), 0);
    });

    it('should release and increase available permits', async () => {
      await sem.acquire();
      assert.strictEqual(sem.availablePermits(), 1);

      sem.release();
      assert.strictEqual(sem.availablePermits(), 2);
    });

    it('should queue waiters when no permits available', async () => {
      await sem.acquire();
      await sem.acquire();
      assert.strictEqual(sem.availablePermits(), 0);
      assert.strictEqual(sem.queueLength(), 0);

      // Start a third acquire that will wait
      let resolved = false;
      const acquirePromise = sem.acquire().then(() => {
        resolved = true;
      });

      // Let microtasks run
      await Promise.resolve();
      assert.strictEqual(resolved, false);
      assert.strictEqual(sem.queueLength(), 1);

      // Release one permit
      sem.release();

      // Wait for the acquire to complete
      await acquirePromise;
      assert.strictEqual(resolved, true);
      assert.strictEqual(sem.queueLength(), 0);
    });

    it('should process waiters in FIFO order', async () => {
      await sem.acquire();
      await sem.acquire();

      const order: number[] = [];

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      // Let microtasks run
      await Promise.resolve();
      assert.strictEqual(sem.queueLength(), 3);

      // Release all three
      sem.release();
      sem.release();
      sem.release();

      await Promise.all([p1, p2, p3]);

      assert.deepStrictEqual(order, [1, 2, 3]);
    });
  });

  describe('concurrency limiting', () => {
    it('should limit concurrent operations', async () => {
      const sem = new Semaphore(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const doWork = async () => {
        await sem.acquire();
        try {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
          concurrent--;
          sem.release();
        }
      };

      // Start 5 concurrent operations
      await Promise.all([doWork(), doWork(), doWork(), doWork(), doWork()]);

      assert.strictEqual(maxConcurrent, 2);
      assert.strictEqual(concurrent, 0);
      assert.strictEqual(sem.availablePermits(), 2);
    });
  });
});
