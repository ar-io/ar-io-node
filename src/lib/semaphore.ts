/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A simple async semaphore for limiting concurrency.
 *
 * Usage:
 *   const sem = new Semaphore(4);  // Allow 4 concurrent operations
 *
 *   async function doWork() {
 *     await sem.acquire();
 *     try {
 *       // ... do work ...
 *     } finally {
 *       sem.release();
 *     }
 *   }
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  /**
   * @param permits Maximum number of concurrent acquisitions allowed
   */
  constructor(permits: number) {
    if (permits < 1) {
      throw new Error('Semaphore permits must be at least 1');
    }
    this.permits = permits;
  }

  /**
   * Acquire a permit. Resolves immediately if permits are available,
   * otherwise waits until a permit is released or timeout expires.
   *
   * @param timeoutMs Optional timeout in milliseconds. If specified and the
   *   permit cannot be acquired within this time, the promise rejects.
   */
  acquire(timeoutMs?: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiting.push(waiter);

      if (timeoutMs !== undefined) {
        setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Release a permit, allowing a waiting acquisition to proceed.
   */
  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.resolve();
    } else {
      this.permits++;
    }
  }

  /**
   * Returns the number of available permits.
   */
  availablePermits(): number {
    return this.permits;
  }

  /**
   * Returns the number of waiters queued for permits.
   */
  queueLength(): number {
    return this.waiting.length;
  }
}
