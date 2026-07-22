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
    deleteContiguousDataCacheEntry: async (hash: string) => {
      if (opts.deleteReturnsZeroFor?.has(hash)) return 0;
      if (!remaining.has(hash)) return 0;
      remaining.delete(hash);
      state.used = Math.max(0, state.used - opts.freePerEvict);
      return 1;
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

  it('evicts oldest-first until usage recovers below the low watermark', async () => {
    const h = makeHarness({
      initialUsedPercent: 90, // over high(80)
      entryCount: 50,
      freePerEvict: 5, // need ~7 evictions to cross below 60
    });
    await makeEvictor(h).sweep();
    assert.ok(h.state.used < 60, `expected recovery, used=${h.state.used}`);
    assert.ok(h.unlinked.length >= 7, `evicted ${h.unlinked.length}`);
    // Oldest evicted first, and every deleted row was also unlinked.
    assert.equal(h.unlinked[0], 'h0000');
    assert.deepEqual([...h.unlinked].sort(), h.unlinked); // ascending == oldest-first
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
