/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';

import {
  createRecordingTestLogger,
  createTestLogger,
} from '../../test/test-logger.js';
import {
  ChunkDataCacheEvictionCandidate,
  ChunkDataCacheEvictor,
  ChunkDataCacheEvictorIndex,
  ChunkDataRootStore,
} from './chunk-data-cache-evictor.js';
import { currentUnixTimestamp } from '../lib/time.js';
import promClient from 'prom-client';

const log = createTestLogger();

const MIN_AGE_SECONDS = 3600;

// Must match the clock the evictor and the write hook use.
// currentUnixTimestamp() ROUNDS rather than floors, so flooring here would
// disagree with the evictor by a second whenever Date.now()'s fractional part
// is >= 500ms -- which made the cutoff assertion below intermittently fail.
function nowSeconds() {
  return currentUnixTimestamp();
}

// blocks:100 makes bavail count percentage points, so `usedPercent` maps
// straight onto the numbers the evictor reads back out of statfs.
function fakeStatfs(usedPercent: number) {
  const blocks = 100;
  const bavail = Math.max(0, blocks - usedPercent);
  return { blocks, bavail, bsize: 1_000_000_000 } as unknown as fs.StatsFs;
}

type Entry = ChunkDataCacheEvictionCandidate;

/**
 * A mutable in-memory stand-in for the chunk cleanup index. Entries are held in
 * insertion order, which stands in for `ORDER BY tier ASC, last_access ASC`
 * (i.e. insertion order = coldest first). Each evicted data root frees
 * `freePerEvict` percentage points of the usage statfs reports back.
 */
function makeHarness(opts: {
  initialUsedPercent: number;
  entries: Entry[];
  freePerEvict: number;
  deleteReturnsZeroFor?: Set<string>;
  absentOnDisk?: Set<string>;
  // Simulates an index query that has stopped applying the age floor, so the
  // evictor's own floor check is the only thing standing between an in-flight
  // upload and a half-deleted data root.
  ignoreFloor?: boolean;
  // Forces the "no candidates" path regardless of what the index holds.
  alwaysEmpty?: boolean;
}) {
  const state = { used: opts.initialUsedPercent };
  const remaining = new Map<string, Entry>();
  for (const entry of opts.entries) {
    remaining.set(entry.dataRoot, entry);
  }
  const unlinked: string[] = [];
  const selectCalls: { maxLastWrite: number; limit: number }[] = [];
  const deleteCalls: string[][] = [];
  const deleteFloors: number[] = [];
  const unlinkFloors: (number | undefined)[] = [];

  const cacheIndex = {
    countChunkDataCacheEntries: async () => remaining.size,
    sumChunkDataCacheBytes: async () =>
      [...remaining.values()].reduce((sum, e) => sum + e.size, 0),
    selectChunkDataCacheEvictionCandidates: async (
      maxLastWrite: number,
      limit: number,
    ) => {
      selectCalls.push({ maxLastWrite, limit });
      if (opts.alwaysEmpty === true) return [];
      return [...remaining.values()]
        .filter((e) => opts.ignoreFloor === true || e.lastWrite <= maxLastWrite)
        .slice(0, limit);
    },
    deleteChunkDataCacheEntries: async (
      dataRoots: string[],
      maxLastWrite: number,
    ) => {
      deleteCalls.push([...dataRoots]);
      deleteFloors.push(maxLastWrite);
      const deleted: string[] = [];
      for (const dataRoot of dataRoots) {
        if (opts.deleteReturnsZeroFor?.has(dataRoot)) continue;
        const entry = remaining.get(dataRoot);
        if (entry === undefined) continue;
        // Mirror the real statement's TOCTOU guard: the DELETE re-applies the
        // age floor, so a row whose last_write advanced past it since being
        // selected deletes nothing. Without this the fake would be more
        // permissive than production and hide the bug it exists to catch.
        if (entry.lastWrite > maxLastWrite) continue;
        remaining.delete(dataRoot);
        state.used = Math.max(0, state.used - opts.freePerEvict);
        deleted.push(dataRoot);
      }
      return deleted;
    },
  } as unknown as ChunkDataCacheEvictorIndex;

  const chunkDataStore = {
    delDataRoot: async (dataRoot: string, maxMtimeSeconds?: number) => {
      unlinked.push(dataRoot);
      unlinkFloors.push(maxMtimeSeconds);
      // Model the real store: a data root whose files are already gone
      // reclaims nothing, which is what a row that outlived its files looks
      // like. Bytes come from the filesystem, never from the index row.
      if (opts.absentOnDisk?.has(dataRoot) ?? false) {
        return {
          removedFiles: 0,
          removedBytes: 0,
          keptFiles: 0,
          failedFiles: 0,
        };
      }
      const entry = opts.entries.find((e) => e.dataRoot === dataRoot);
      return {
        removedFiles: entry?.chunkCount ?? 1,
        removedBytes: entry?.size ?? 0,
        keptFiles: 0,
        failedFiles: 0,
      };
    },
  } as unknown as ChunkDataRootStore;

  mock.method(fs.promises, 'statfs', async () => fakeStatfs(state.used));

  return {
    state,
    remaining,
    unlinked,
    selectCalls,
    deleteCalls,
    deleteFloors,
    unlinkFloors,
    cacheIndex,
    chunkDataStore,
  };
}

// `count` cold data roots of `size` bytes each, all comfortably older than the
// age floor so they are legitimate eviction candidates.
function coldEntries(count: number, size: number, prefix = 'dr'): Entry[] {
  const lastWrite = nowSeconds() - MIN_AGE_SECONDS - 10_000;
  return Array.from({ length: count }, (_, i) => ({
    dataRoot: `${prefix}${String(i).padStart(4, '0')}`,
    size,
    chunkCount: Math.max(1, Math.round(size / 262_144)),
    lastWrite,
  }));
}

// Read a counter straight out of the shared prom-client registry. The metrics
// are the operator's only view of this subsystem and nothing else in the suite
// touches them, so assert on the real registry rather than a stand-in.
async function readCounter(name: string): Promise<number> {
  const metric = await promClient.register.getSingleMetric(name)?.get();
  return (metric?.values ?? []).reduce(
    (sum: number, v: any) => sum + (v.value ?? 0),
    0,
  );
}

function makeEvictor(
  h: ReturnType<typeof makeHarness>,
  extra: Record<string, unknown> = {},
) {
  return new ChunkDataCacheEvictor({
    log,
    chunkDataStore: h.chunkDataStore,
    cacheIndex: h.cacheIndex,
    usagePath: '/chunk-cache',
    lowWatermarkPercent: 60,
    highWatermarkPercent: 80,
    minFreeBytes: 0,
    batchSize: 3,
    intervalMs: 999_999,
    minAgeSeconds: MIN_AGE_SECONDS,
    targetBytes: 3000,
    ...extra,
  });
}

describe('ChunkDataCacheEvictor', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('does not evict when below the high watermark', async () => {
    const h = makeHarness({
      initialUsedPercent: 70, // between low(60) and high(80): not over pressure
      entries: coldEntries(20, 1000),
      freePerEvict: 5,
    });
    await makeEvictor(h).sweep();
    assert.equal(h.unlinked.length, 0);
    assert.equal(h.remaining.size, 20);
    assert.equal(h.selectCalls.length, 0);
  });

  it('evicts coldest-first until usage recovers below the low watermark', async () => {
    const h = makeHarness({
      initialUsedPercent: 90, // over high(80)
      entries: coldEntries(50, 1000),
      freePerEvict: 5, // need ~7 evictions to cross below 60
    });
    await makeEvictor(h).sweep();
    assert.ok(h.state.used < 60, `expected recovery, used=${h.state.used}`);
    assert.ok(h.unlinked.length >= 7, `evicted ${h.unlinked.length}`);
    assert.ok(h.remaining.size > 0, 'should have stopped, not drained');
    // Eviction is coldest-first: every evicted data root is colder (lower) than
    // every one still in the index. (Unlink order itself is parallel/unordered.)
    const evictedMax = [...h.unlinked].sort().at(-1)!;
    assert.equal([...h.unlinked].sort()[0], 'dr0000'); // the coldest went first
    for (const [dataRoot] of h.remaining) {
      assert.ok(
        dataRoot > evictedMax,
        `remaining ${dataRoot} should be newer than all evicted (<= ${evictedMax})`,
      );
    }
  });

  it('never unlinks a data root inside the age floor, even at 100% full', async () => {
    // The index query has (hypothetically) stopped applying the floor, so the
    // only remaining candidate is a data root written seconds ago -- exactly the
    // in-flight upload the floor exists to protect.
    const hot: Entry = {
      dataRoot: 'drHOT',
      size: 5_000_000,
      chunkCount: 20,
      lastWrite: nowSeconds() - 5,
    };
    const h = makeHarness({
      initialUsedPercent: 100, // as much pressure as the disk can express
      entries: [hot],
      freePerEvict: 5,
      ignoreFloor: true,
    });
    await makeEvictor(h).sweep();

    assert.ok(
      !h.unlinked.includes('drHOT'),
      'drHOT must never reach the chunk data store',
    );
    assert.equal(
      h.unlinked.length,
      0,
      'nothing inside the floor may be unlinked',
    );
    assert.equal(h.deleteCalls.length, 0, 'its index row must not be deleted');
    assert.equal(h.remaining.size, 1);
  });

  it('passes now - minAgeSeconds as the candidate query cutoff', async () => {
    const minAgeSeconds = 1234;
    const h = makeHarness({
      initialUsedPercent: 90,
      entries: coldEntries(5, 1000),
      freePerEvict: 50, // recover after the first batch: one select call
    });
    const before = nowSeconds();
    await makeEvictor(h, { minAgeSeconds }).sweep();
    const after = nowSeconds();

    assert.ok(h.selectCalls.length >= 1, 'the index was never queried');
    const { maxLastWrite, limit } = h.selectCalls[0];
    assert.equal(limit, 3);
    assert.ok(
      maxLastWrite >= before - minAgeSeconds &&
        maxLastWrite <= after - minAgeSeconds,
      `cutoff ${maxLastWrite} is not now - ${minAgeSeconds} ` +
        `(expected ${before - minAgeSeconds}..${after - minAgeSeconds})`,
    );
  });

  it('accumulates candidates to the byte target instead of evicting a fixed count', async () => {
    // Three small data roots, then one big one, then a long tail of small ones.
    // Reaching the 10 MiB target takes the first four; a count-based evictor
    // would take the whole batch of 44 and reclaim the tail for nothing.
    const entries = [
      ...coldEntries(3, 1_000_000, 'a'),
      ...coldEntries(1, 20_000_000, 'b'),
      ...coldEntries(40, 1_000_000, 'c'),
    ];
    const h = makeHarness({
      initialUsedPercent: 90,
      entries,
      freePerEvict: 8, // 4 evictions => 58% => recovered after one batch
    });
    await makeEvictor(h, {
      batchSize: 44,
      targetBytes: 10_000_000,
    }).sweep();

    assert.equal(h.deleteCalls.length, 1, 'expected a single batch');
    assert.deepEqual(h.deleteCalls[0], ['a0000', 'a0001', 'a0002', 'b0000']);
    assert.equal(h.unlinked.length, 4);
    assert.ok(h.unlinked.includes('b0000'), 'the large data root was skipped');
    assert.ok(
      !h.unlinked.some((dataRoot) => dataRoot.startsWith('c')),
      'the tail past the byte target must not be evicted',
    );
    assert.equal(h.remaining.size, 40);
  });

  it('does not unlink a data root whose index row was already gone', async () => {
    const h = makeHarness({
      initialUsedPercent: 90,
      entries: coldEntries(50, 1000),
      freePerEvict: 5,
      deleteReturnsZeroFor: new Set(['dr0000']), // simulate a concurrent delete
    });
    await makeEvictor(h).sweep();
    assert.ok(h.deleteCalls[0].includes('dr0000'), 'it was a candidate');
    assert.ok(
      !h.unlinked.includes('dr0000'),
      'a row the DB did not delete must not be unlinked',
    );
  });

  it('logs the benign floor message (not the drift warning) when every entry is too young', async () => {
    const { logger, entries: logEntries } = createRecordingTestLogger({
      suite: 'ChunkDataCacheEvictor',
    });
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(5, 1000),
      freePerEvict: 5,
      alwaysEmpty: true, // the floor filtered everything out
    });
    await makeEvictor(h, { log: logger }).sweep();

    const messages = logEntries.map((e) => `${e.level}:${e.message}`);
    assert.ok(
      messages.some(
        (m) => m.startsWith('info:') && m.includes('inside the age floor'),
      ),
      `expected the benign age-floor message, got ${JSON.stringify(messages)}`,
    );
    assert.ok(
      !messages.some((m) => m.includes('drained but still over pressure')),
      `drift warning must not fire, got ${JSON.stringify(messages)}`,
    );
    assert.equal(h.unlinked.length, 0);
  });

  it('warns about drift when the index is genuinely drained while over pressure', async () => {
    const { logger, entries: logEntries } = createRecordingTestLogger({
      suite: 'ChunkDataCacheEvictor',
    });
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(2, 1000),
      freePerEvict: 5, // not enough to recover
    });
    await makeEvictor(h, { log: logger }).sweep();

    assert.equal(h.unlinked.length, 2);
    assert.equal(h.remaining.size, 0);
    assert.ok(h.state.used >= 60); // never recovered
    const messages = logEntries.map((e) => `${e.level}:${e.message}`);
    assert.ok(
      messages.some(
        (m) =>
          m.startsWith('warn:') &&
          m.includes('drained but still over pressure'),
      ),
      `expected the drift warning, got ${JSON.stringify(messages)}`,
    );
  });

  // Regression: the age floor is evaluated when candidates are SELECTED, but a
  // chunk can land before the DELETE runs. Eviction unlinks the whole data root
  // directory, so unless the same cutoff is carried into the delete, the
  // evictor destroys a just-written chunk and reports success. The floor alone
  // does not close this -- the delete-time guard does.
  it('carries the same age-floor cutoff into the delete', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(6, 10_000_000),
      freePerEvict: 10,
    });
    const evictor = makeEvictor(h, { minAgeSeconds: 4321 });

    await evictor.sweep();

    assert.ok(h.deleteFloors.length > 0, 'expected at least one delete');
    for (let i = 0; i < h.deleteFloors.length; i++) {
      assert.equal(
        h.deleteFloors[i],
        h.selectCalls[i].maxLastWrite,
        `delete cutoff ${h.deleteFloors[i]} != select cutoff ${h.selectCalls[i].maxLastWrite}`,
      );
    }
  });

  it('never unlinks a data root written to between select and delete', async () => {
    const h = makeHarness({
      initialUsedPercent: 99,
      entries: coldEntries(3, 10_000_000),
      freePerEvict: 1,
    });
    // The real race: the SELECT returns the row as it was (old, evictable),
    // and only afterwards does a chunk land and advance last_write. The
    // candidate handed to the evictor must therefore keep the OLD value --
    // copying it is the point, since sharing the object would instead trip the
    // evictor's defensive in-memory floor check and prove nothing about the
    // delete-time guard.
    const victim = 'dr0000';
    const original = h.cacheIndex.selectChunkDataCacheEvictionCandidates.bind(
      h.cacheIndex,
    );
    (h.cacheIndex as any).selectChunkDataCacheEvictionCandidates = async (
      maxLastWrite: number,
      limit: number,
    ) => {
      const out = (await original(maxLastWrite, limit)).map((c: any) => ({
        ...c,
      }));
      const entry = h.remaining.get(victim);
      if (entry !== undefined) {
        entry.lastWrite = Math.floor(Date.now() / 1000) + 10_000;
      }
      return out;
    };
    const evictor = makeEvictor(h, { minAgeSeconds: 60 });

    await evictor.sweep();

    assert.ok(
      h.deleteCalls.flat().includes(victim),
      'precondition: it must have been selected and offered to the delete',
    );
    assert.ok(
      !h.unlinked.includes(victim),
      'a data root written to after selection must never be unlinked',
    );
    assert.ok(h.remaining.has(victim), 'and its index row must survive');
  });

  // The write hook stamps last_write with currentUnixTimestamp(), which ROUNDS
  // (`.toFixed(0)`), so a chunk written at T.7s is recorded as T+1. If the
  // evictor floored instead, its cutoff would be T and that row would look like
  // it was written in the future -- silently unevictable for up to a second.
  // Hidden behind an hours-long floor, but it made the end-to-end test
  // nondeterministic, so pin the clock the evictor uses.
  it('computes its cutoff with the same rounding clock as the write hook', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(2, 1_000),
      freePerEvict: 50,
    });
    const evictor = makeEvictor(h, { minAgeSeconds: 0 });

    // A moment whose fractional part rounds UP.
    const base = 1_700_000_000;
    mock.method(Date, 'now', () => base * 1000 + 700);
    try {
      await evictor.sweep();
    } finally {
      mock.restoreAll();
    }

    assert.ok(h.selectCalls.length > 0, 'expected a select');
    assert.equal(
      h.selectCalls[0].maxLastWrite,
      base + 1,
      'cutoff must round like currentUnixTimestamp(), not floor',
    );
  });

  // Blocker 1: index rows outlive their files, because the ingest GC, the
  // filesystem-walk worker and manual sweeps all unlink chunks without
  // touching this index. Those rows are the coldest, so they sort FIRST. If
  // their bytes were booked as reclaimed, the evictor would report gigabytes
  // freed while df did not move -- the exact failure the index exists to
  // surface.
  it('does not count bytes for rows whose data root was already gone', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(4, 10_000_000),
      freePerEvict: 0, // nothing is actually reclaimed
      absentOnDisk: new Set(['dr0000', 'dr0001', 'dr0002', 'dr0003']),
    });
    const evictedBefore = await readCounter(
      'chunk_cache_index_evicted_bytes_total',
    );
    const missingBefore = await readCounter(
      'chunk_cache_index_evicted_missing_total',
    );

    await makeEvictor(h, { minAgeSeconds: 0 }).sweep();

    assert.equal(
      await readCounter('chunk_cache_index_evicted_bytes_total'),
      evictedBefore,
      'bytes must not be booked for data roots that were already absent',
    );
    assert.ok(
      (await readCounter('chunk_cache_index_evicted_missing_total')) >
        missingBefore,
      'absent data roots must be counted on their own series',
    );
    // The rows are still purged, so the index self-heals of stale entries.
    assert.equal(h.remaining.size, 0);
  });

  // Blocker 2: with neither pressure trigger set, overPressure() can never be
  // true, so the hooks pay their full cost and nothing is ever evicted. That
  // is indistinguishable from a healthy idle evictor unless it says so.
  it('warns at startup when no pressure trigger is configured', () => {
    const { logger, entries: logEntries } = createRecordingTestLogger({
      suite: 'ChunkDataCacheEvictor',
    });
    const h = makeHarness({
      initialUsedPercent: 10,
      entries: coldEntries(1, 1000),
      freePerEvict: 1,
    });
    const evictor = makeEvictor(h, {
      log: logger,
      highWatermarkPercent: 0,
      minFreeBytes: 0,
    });
    evictor.start();
    evictor.stop();

    assert.ok(
      logEntries.some(
        (e) => e.level === 'warn' && e.message.includes('no pressure trigger'),
      ),
      `expected a no-trigger warning, got ${JSON.stringify(logEntries)}`,
    );
  });

  // The min-free-bytes trigger is the ENOSPC backstop for a volume shared with
  // SQLite DBs and logs. Every other test here runs with minFreeBytes: 0, so
  // without this the whole path is dead code under test.
  it('evicts on the free-bytes floor even when the percentage looks healthy', async () => {
    const h = makeHarness({
      initialUsedPercent: 10, // far below any watermark
      entries: coldEntries(3, 1000),
      freePerEvict: 0,
    });
    // fakeStatfs gives bavail = 90 blocks * 1e9 = 90 GB free; demand 200 GB.
    const evictor = makeEvictor(h, {
      highWatermarkPercent: 0,
      lowWatermarkPercent: 0,
      minFreeBytes: 200_000_000_000,
      minAgeSeconds: 0,
    });

    await evictor.sweep();

    assert.ok(
      h.unlinked.length > 0,
      'a breached free-bytes floor must trigger eviction regardless of usage percent',
    );
  });

  // Sweeps must never overlap: two concurrent passes would select the same
  // rows twice and unlink the same data root twice. Asserted by observing that
  // a second sweep started while the first is in flight does no work at all --
  // checking for duplicate unlinks is not enough, because the first sweep's
  // deletes remove the rows the second would have selected, hiding the bug.
  it('does not run overlapping sweeps', async () => {
    const h = makeHarness({
      initialUsedPercent: 95,
      entries: coldEntries(6, 1000),
      freePerEvict: 50,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSelect = h.cacheIndex.selectChunkDataCacheEvictionCandidates;
    let gated = false;
    (h.cacheIndex as any).selectChunkDataCacheEvictionCandidates = async (
      maxLastWrite: number,
      limit: number,
    ) => {
      if (!gated) {
        gated = true;
        await gate; // hold the first sweep open
      }
      return realSelect(maxLastWrite, limit);
    };
    const evictor = makeEvictor(h, { minAgeSeconds: 0 });

    const inFlight = evictor.sweep();
    try {
      await Promise.resolve(); // let the first sweep reach the gated select
      const callsWhileBusy = h.selectCalls.length;

      await evictor.sweep(); // must be an immediate no-op

      assert.equal(
        h.selectCalls.length,
        callsWhileBusy,
        'a sweep started while another is in flight must not query the index',
      );
    } finally {
      // Always release, even when the assertion above throws: otherwise the
      // gated sweep stays pending and the runner hangs instead of reporting a
      // failure. A test that hangs costs a whole CI job; one that fails costs
      // a line of output.
      release();
      await inFlight;
    }
  });
});
