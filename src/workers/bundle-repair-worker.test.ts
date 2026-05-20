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
import { Ans104Unbundler, UnbundleableItem } from './ans104-unbundler.js';

class FakeBundleIndex implements BundleIndex {
  failedBundleIds: string[] = [];
  saveBundleRetriesCalls: string[] = [];
  pendingCount = 0;
  fullBacklogCount = 0;
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
  async getFullRepairBacklogCount(): Promise<number> {
    if (this.throwOn.getFullRepairBacklogCount)
      throw this.throwOn.getFullRepairBacklogCount;
    return this.fullBacklogCount;
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

class FakeAns104Unbundler {
  // Records every queueItem call. The repair worker passes the failed
  // bundle's root_transaction_id as item.id; tests assert on that.
  queued: Array<{
    id: string;
    prioritized: boolean | undefined;
    bypassFilter: boolean;
  }> = [];
  async queueItem(
    item: UnbundleableItem,
    prioritized: boolean | undefined,
    bypassFilter = false,
  ): Promise<void> {
    this.queued.push({ id: item.id, prioritized, bypassFilter });
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
  let ans104Unbundler: FakeAns104Unbundler;
  let worker: BundleRepairWorker;

  beforeEach(() => {
    log = createTestLogger({ suite: 'BundleRepairWorker' });
    bundleIndex = new FakeBundleIndex();
    ans104Unbundler = new FakeAns104Unbundler();
    worker = new BundleRepairWorker({
      log,
      bundleIndex,
      ans104Unbundler: ans104Unbundler as unknown as Ans104Unbundler,
      unbundleFilter: '{}',
      indexFilter: '{}',
      shouldBackfillBundles: false,
      filtersChanged: false,
    });
  });

  it('queues each failed bundle to the unbundler with bypassFilter=true and increments the retries counter', async () => {
    // selectFailedBundleIds aliases bundles.root_transaction_id AS id, so
    // the ids handed to the worker are L1/parent ids. For BDIs that's the
    // parent L1; for L1s it's the L1's own id. Either way the repair
    // worker should hand them to the unbundler directly — bypassing
    // TransactionFetcher — so the unbundle attempt is guaranteed to fire
    // this cycle rather than depending on a (possibly-deduped or already-
    // imported) txFetcher path.
    bundleIndex.failedBundleIds = ['bundle-a', 'bundle-b', 'bundle-c'];
    const before = await getCounterValue(metrics.bundleRepairRetriesCounter, {
      kind: 'retry',
    });

    await worker.retryBundles();

    assert.equal(bundleIndex.saveBundleRetriesCalls.length, 3);
    assert.deepEqual(
      ans104Unbundler.queued.map((q) => q.id),
      ['bundle-a', 'bundle-b', 'bundle-c'],
    );
    // Every retry should bypass the filter (we're explicitly re-trying a
    // bundle that was previously accepted; the filter has nothing new to
    // say) and run as non-prioritized so it doesn't preempt chain-tip
    // ingest.
    for (const q of ans104Unbundler.queued) {
      assert.equal(q.bypassFilter, true);
      assert.equal(q.prioritized, false);
    }
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

  it('refreshes the pending and full-backlog gauges after each timestamp update', async () => {
    bundleIndex.pendingCount = 1234;
    bundleIndex.fullBacklogCount = 9_000_000;
    await worker.updateBundleTimestamps();
    assert.equal(
      (await metrics.bundleRepairPendingBundlesGauge.get()).values[0]?.value,
      1234,
    );
    assert.equal(
      (await metrics.bundleRepairBacklogBundlesGauge.get()).values[0]?.value,
      9_000_000,
    );

    bundleIndex.pendingCount = 7;
    bundleIndex.fullBacklogCount = 11;
    await worker.updateBundleTimestamps();
    assert.equal(
      (await metrics.bundleRepairPendingBundlesGauge.get()).values[0]?.value,
      7,
    );
    assert.equal(
      (await metrics.bundleRepairBacklogBundlesGauge.get()).values[0]?.value,
      11,
    );
  });

  it('does not fail the cycle when pending-count refresh throws', async () => {
    bundleIndex.throwOn.getRepairBacklogCount = new Error('count failed');
    // Counters are global module state across the test process, so a prior
    // test (or any future addition above this one) could have already
    // incremented the timestamp_update error counter. Assert that this
    // call does not move it, rather than that its absolute value is zero.
    const before = await getCounterValue(metrics.bundleRepairErrorsCounter, {
      kind: 'timestamp_update',
    });
    await worker.updateBundleTimestamps();
    // No error counter increment for timestamp_update because the main
    // call succeeded; gauge refresh failure is logged and swallowed.
    assert.equal(
      await getCounterValue(metrics.bundleRepairErrorsCounter, {
        kind: 'timestamp_update',
      }),
      before,
    );
  });
});
