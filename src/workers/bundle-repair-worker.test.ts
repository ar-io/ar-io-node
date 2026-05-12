/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import * as metrics from '../metrics.js';
import { BundleIndex } from '../types.js';
import { BundleRepairWorker } from './bundle-repair-worker.js';
import { TransactionFetcher } from './transaction-fetcher.js';

class FakeBundleIndex implements BundleIndex {
  failedBundleIds: string[] = [];
  saveBundleRetriesCalls: string[] = [];
  pendingCount = 0;
  throwOn: Partial<Record<keyof BundleIndex, Error>> = {};

  // unused but required by the interface
  saveBundle(): Promise<any> {
    throw new Error('not used');
  }
  async saveBundleRetries(id: string): Promise<void> {
    if (this.throwOn.saveBundleRetries) throw this.throwOn.saveBundleRetries;
    this.saveBundleRetriesCalls.push(id);
  }
  async getFailedBundleIds(): Promise<string[]> {
    if (this.throwOn.getFailedBundleIds) throw this.throwOn.getFailedBundleIds;
    return this.failedBundleIds;
  }
  async getRepairBacklogCount(): Promise<number> {
    if (this.throwOn.getRepairBacklogCount)
      throw this.throwOn.getRepairBacklogCount;
    return this.pendingCount;
  }
  async updateBundlesFullyIndexedAt(): Promise<void> {
    if (this.throwOn.updateBundlesFullyIndexedAt)
      throw this.throwOn.updateBundlesFullyIndexedAt;
  }
  async updateBundlesForFilterChange(): Promise<void> {
    if (this.throwOn.updateBundlesForFilterChange)
      throw this.throwOn.updateBundlesForFilterChange;
  }
  async backfillBundles(): Promise<void> {
    if (this.throwOn.backfillBundles) throw this.throwOn.backfillBundles;
  }
}

class FakeTxFetcher {
  queued: string[] = [];
  queueTxId({ txId }: { txId: string }): void {
    this.queued.push(txId);
  }
}

async function getCounterValue(
  counter: { get: () => Promise<any> },
  labels: Record<string, string>,
): Promise<number> {
  const out = await counter.get();
  const match = out.values.find((v: any) =>
    Object.entries(labels).every(([k, v2]) => v.labels[k] === v2),
  );
  return match?.value ?? 0;
}

async function getHistogramCount(
  histogram: { get: () => Promise<any> },
  labels: Record<string, string>,
): Promise<number> {
  const out = await histogram.get();
  // prom-client v15 emits the count as a sample with metricName_count
  const match = out.values.find(
    (v: any) =>
      v.metricName?.endsWith('_count') &&
      Object.entries(labels).every(([k, v2]) => v.labels[k] === v2),
  );
  return match?.value ?? 0;
}

describe('BundleRepairWorker metrics', () => {
  let log: ReturnType<typeof createTestLogger>;
  let bundleIndex: FakeBundleIndex;
  let txFetcher: FakeTxFetcher;
  let worker: BundleRepairWorker;

  beforeEach(() => {
    log = createTestLogger({ suite: 'BundleRepairWorker' });
    bundleIndex = new FakeBundleIndex();
    txFetcher = new FakeTxFetcher();
    worker = new BundleRepairWorker({
      log,
      bundleIndex,
      txFetcher: txFetcher as unknown as TransactionFetcher,
      unbundleFilter: '{}',
      indexFilter: '{}',
      shouldBackfillBundles: false,
      filtersChanged: false,
    });
  });

  it('increments retries counter once per re-queued bundle', async () => {
    bundleIndex.failedBundleIds = ['bundle-a', 'bundle-b', 'bundle-c'];
    const before = await getCounterValue(metrics.bundleRepairRetriesCounter, {
      kind: 'retry',
    });

    await worker.retryBundles();

    assert.equal(bundleIndex.saveBundleRetriesCalls.length, 3);
    assert.deepEqual(txFetcher.queued, ['bundle-a', 'bundle-b', 'bundle-c']);
    assert.equal(
      await getCounterValue(metrics.bundleRepairRetriesCounter, {
        kind: 'retry',
      }),
      before + 3,
    );
  });

  it('observes cycle duration in the histogram on success', async () => {
    bundleIndex.failedBundleIds = ['bundle-a'];
    const before = await getHistogramCount(
      metrics.bundleRepairCycleDurationHistogram,
      { kind: 'retry' },
    );

    await worker.retryBundles();

    assert.equal(
      await getHistogramCount(metrics.bundleRepairCycleDurationHistogram, {
        kind: 'retry',
      }),
      before + 1,
    );
  });

  it('increments errors counter when a cycle throws', async () => {
    bundleIndex.throwOn.getFailedBundleIds = new Error('select failed');
    const errBefore = await getCounterValue(metrics.bundleRepairErrorsCounter, {
      kind: 'retry',
    });

    await worker.retryBundles();

    // Errors counter incremented, retries counter NOT incremented,
    // worker did not crash (caught at the outer try in retryBundles).
    assert.equal(
      await getCounterValue(metrics.bundleRepairErrorsCounter, {
        kind: 'retry',
      }),
      errBefore + 1,
    );
  });

  it('refreshes the pending-bundles gauge after each timestamp update', async () => {
    bundleIndex.pendingCount = 1234;
    await worker.updateBundleTimestamps();
    assert.equal(
      (await metrics.bundleRepairPendingBundlesGauge.get()).values[0]?.value,
      1234,
    );

    bundleIndex.pendingCount = 7;
    await worker.updateBundleTimestamps();
    assert.equal(
      (await metrics.bundleRepairPendingBundlesGauge.get()).values[0]?.value,
      7,
    );
  });

  it('does not fail the cycle when pending-count refresh throws', async () => {
    bundleIndex.throwOn.getRepairBacklogCount = new Error('count failed');
    // updateBundlesFullyIndexedAt itself should still complete; only the
    // gauge refresh fails (non-fatal).
    await worker.updateBundleTimestamps();
    // No error counter increment for timestamp_update because the main
    // call succeeded; gauge refresh failure is logged and swallowed.
    const errors = await getCounterValue(metrics.bundleRepairErrorsCounter, {
      kind: 'timestamp_update',
    });
    assert.equal(errors, 0);
  });
});
