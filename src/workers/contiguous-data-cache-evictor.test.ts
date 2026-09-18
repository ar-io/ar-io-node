/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { ContiguousDataCacheIndex, ContiguousDataStore } from '../types.js';
import { ContiguousDataCacheEvictor } from './contiguous-data-cache-evictor.js';

const log = createTestLogger();

function fakeStatfs(usedPercent: number) {
  const blocks = 100;
  const bavail = Math.max(0, blocks - usedPercent);
  return { blocks, bavail, bsize: 1_000_000_000 } as unknown as fs.StatsFs;
}

// A mutable in-memory stand-in for the cleanup index. Each eviction frees
// `freePerEvict` percentage points of disk usage (the usage read back by statfs).
function makeHarness(opts: {
  initialUsedPercent: number;
  entryCount: number;
  freePerEvict: number;
  deleteReturnsZeroFor?: Set<string>;
}) {
  const state = { used: opts.initialUsedPercent };
  const remaining = new Map<string, { hash: string; size: number }>();
  for (let i = 0; i < opts.entryCount; i++) {
    const hash = `h${String(i).padStart(4, '0')}`; // insertion order = oldest first
    remaining.set(hash, { hash, size: 1000 });
  }
  const unlinked: string[] = [];

  const cacheIndex = {
    saveContiguousDataCacheEntry: async () => undefined,
    sumContiguousDataCacheBytes: async () => remaining.size * 1000,
    countContiguousDataCacheEntries: async () => remaining.size,
    selectContiguousDataCacheEvictionCandidates: async (limit: number) =>
      Array.from(remaining.values()).slice(0, limit),
    deleteContiguousDataCacheEntries: async (hashes: string[]) => {
      const deleted: string[] = [];
      for (const hash of hashes) {
        if (opts.deleteReturnsZeroFor?.has(hash)) continue;
        if (!remaining.has(hash)) continue;
        remaining.delete(hash);
        state.used = Math.max(0, state.used - opts.freePerEvict);
        deleted.push(hash);
      }
      return deleted;
    },
  } as unknown as ContiguousDataCacheIndex;

  const dataStore = {
    delete: async (hash: string) => {
      unlinked.push(hash);
    },
  } as unknown as ContiguousDataStore;

  mock.method(fs.promises, 'statfs', async () => fakeStatfs(state.used));

  return { state, remaining, unlinked, cacheIndex, dataStore };
}

function makeEvictor(
  h: ReturnType<typeof makeHarness>,
  extra: Record<string, unknown> = {},
) {
  return new ContiguousDataCacheEvictor({
    log,
    dataStore: h.dataStore,
    cacheIndex: h.cacheIndex,
    usagePath: '/cache',
    lowWatermarkPercent: 60,
    highWatermarkPercent: 80,
    minFreeBytes: 0,
    batchSize: 3,
    intervalMs: 999_999,
    ...extra,
  });
}

describe('ContiguousDataCacheEvictor', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('does not evict when below the high watermark', async () => {
    const h = makeHarness({
      initialUsedPercent: 70, // between low(60) and high(80): not over pressure
      entryCount: 20,
      freePerEvict: 5,
    });
    await makeEvictor(h).sweep();
    assert.equal(h.unlinked.length, 0);
    assert.equal(h.remaining.size, 20);
  });

  // Every unlink occupies a libuv thread for its duration, so an unbounded (or
  // hard-coded 50) fan-out takes the whole pool on a stock node and queues every
  // other file operation behind it — on a disk that is already saturated, which
  // is why the evictor is running at all.
  it('never exceeds the configured unlink concurrency', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entryCount: 200,
      freePerEvict: 1,
    });
    let inFlight = 0;
    let peak = 0;
    (h.dataStore as any).delete = async (hash: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      h.unlinked.push(hash);
    };

    await makeEvictor(h, { batchSize: 50, unlinkConcurrency: 4 }).sweep();

    assert.ok(
      h.unlinked.length > 4,
      `expected real work, got ${h.unlinked.length}`,
    );
    assert.ok(peak <= 4, `peak concurrent unlinks was ${peak}, limit was 4`);
  });

  it('bounds unlinks per sweep by batchSize * maxBatchesPerSweep', async () => {
    const h = makeHarness({
      initialUsedPercent: 99,
      entryCount: 500,
      freePerEvict: 0, // never recovers: only the sweep bound can stop it
    });

    await makeEvictor(h, { batchSize: 5, maxBatchesPerSweep: 3 }).sweep();

    // The sweep must stop at the bound rather than draining the index, so the
    // next sweep resumes instead of one pass holding the disk indefinitely.
    assert.equal(h.unlinked.length, 15);
    assert.equal(h.remaining.size, 485);
  });

  it('evicts oldest-first until usage recovers below the low watermark', async () => {
    const h = makeHarness({
      initialUsedPercent: 90, // over high(80)
      entryCount: 50,
      freePerEvict: 5, // need ~7 evictions to cross below 60
    });
    await makeEvictor(h).sweep();
    assert.ok(h.state.used < 60, `expected recovery, used=${h.state.used}`);
    assert.ok(h.unlinked.length >= 7, `evicted ${h.unlinked.length}`);
    // Eviction is oldest-first: every evicted hash is older (lower) than every
    // one still in the index. (Unlink order itself is now parallel/unordered.)
    const evictedMax = [...h.unlinked].sort().at(-1)!;
    assert.equal([...h.unlinked].sort()[0], 'h0000'); // the oldest went first
    for (const [hash] of h.remaining) {
      assert.ok(
        hash > evictedMax,
        `remaining ${hash} should be newer than all evicted (<= ${evictedMax})`,
      );
    }
  });

  it('stops (and warns) when the index drains while still over pressure', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entryCount: 2, // not enough to recover
      freePerEvict: 5,
    });
    await makeEvictor(h).sweep();
    assert.equal(h.unlinked.length, 2);
    assert.equal(h.remaining.size, 0);
    assert.ok(h.state.used >= 60); // never recovered
  });

  it('does not unlink a blob whose index row was already gone', async () => {
    const h = makeHarness({
      initialUsedPercent: 90,
      entryCount: 50,
      freePerEvict: 5,
      deleteReturnsZeroFor: new Set(['h0000']), // simulate concurrent delete
    });
    await makeEvictor(h).sweep();
    assert.ok(!h.unlinked.includes('h0000'));
  });
});
