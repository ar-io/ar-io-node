/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import * as config from '../config.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  CleanupContext,
  FsCleanupWorker,
  warnIfWalkConcurrencyUnsafe,
  NORMAL_CONTEXT,
  scaledThresholdSeconds,
} from './fs-cleanup-worker.js';

const log = createTestLogger();

// Build a fake statfs result that yields the requested used-percent and free
// bytes. Only blocks/bavail/bsize are read by the worker.
function fakeStatfs(usedPercent: number, freeBytes: number) {
  const blocks = 1_000_000;
  const bavail = Math.round(blocks * (1 - usedPercent / 100));
  const bsize = bavail > 0 ? freeBytes / bavail : 0;
  return { blocks, bavail, bsize } as unknown as fs.StatsFs;
}

function mockStatfs(usedPercent: number, freeBytes = Number.MAX_SAFE_INTEGER) {
  return mock.method(fs.promises, 'statfs', async () =>
    fakeStatfs(usedPercent, freeBytes),
  );
}

function makeWorker(opts: Record<string, unknown> = {}) {
  return new FsCleanupWorker({
    log,
    basePath: 'data/contiguous',
    dataType: 'contiguous_data',
    batchSize: 100,
    pauseDuration: 1000,
    ...opts,
  });
}

describe('FsCleanupWorker.decideCleanup', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('runs normal cleanup without statfs when watermarks are disabled', async () => {
    const spy = mockStatfs(99);
    const worker = makeWorker(); // no watermarks
    const decision = await worker.decideCleanup();

    assert.equal(spy.mock.callCount(), 0, 'statfs must not be called');
    assert.equal(decision.action, 'clean');
    if (decision.action === 'clean') {
      assert.equal(decision.ctx.regime, 'normal');
      assert.equal(decision.ctx.thresholdScale, 1);
      assert.equal(decision.ctx.minAgeSeconds, 0);
      assert.equal(decision.batchSize, 100);
      assert.equal(decision.pauseMs, 1000);
    }
  });

  it('skips cleanup below the low watermark', async () => {
    mockStatfs(40);
    const worker = makeWorker({
      lowWatermarkPercent: 50,
      highWatermarkPercent: 80,
    });
    const decision = await worker.decideCleanup();
    assert.equal(decision.action, 'skip');
  });

  it('runs normal cleanup between the watermarks', async () => {
    mockStatfs(65);
    const worker = makeWorker({
      lowWatermarkPercent: 50,
      highWatermarkPercent: 80,
    });
    const decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    if (decision.action === 'clean') {
      assert.equal(decision.ctx.regime, 'normal');
      assert.equal(decision.ctx.thresholdScale, 1);
    }
  });

  it('escalates above the high watermark with a scaled-down threshold', async () => {
    mockStatfs(90); // high=80 => span 20, pressure 0.5
    const worker = makeWorker({
      lowWatermarkPercent: 50,
      highWatermarkPercent: 80,
      aggressiveMinAgeSeconds: 3600,
    });
    const decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    if (decision.action === 'clean') {
      assert.equal(decision.ctx.regime, 'aggressive');
      assert.ok(Math.abs(decision.ctx.thresholdScale - 0.5) < 1e-9);
      assert.equal(decision.ctx.minAgeSeconds, 3600);
      assert.ok(decision.batchSize > 100, 'batch grows under pressure');
      assert.ok(decision.pauseMs < 1000, 'pause shrinks under pressure');
    }
  });

  it('stays aggressive until usage recovers below the low watermark (hysteresis)', async () => {
    let usage = 90;
    mock.method(fs.promises, 'statfs', async () =>
      fakeStatfs(usage, Number.MAX_SAFE_INTEGER),
    );
    const worker = makeWorker({
      lowWatermarkPercent: 50,
      highWatermarkPercent: 80,
      aggressiveMinAgeSeconds: 3600,
    });

    // Above the high watermark: aggressive.
    let decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    assert.equal(
      decision.action === 'clean' && decision.ctx.regime,
      'aggressive',
    );

    // Back between the watermarks: still draining, so still aggressive (no flap).
    usage = 65;
    decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    assert.equal(
      decision.action === 'clean' && decision.ctx.regime,
      'aggressive',
    );

    // Recovered below the low watermark: drain complete, resume skipping.
    usage = 40;
    decision = await worker.decideCleanup();
    assert.equal(decision.action, 'skip');
  });

  it('forces maximum pressure when free space is below the floor, even below the low watermark', async () => {
    mockStatfs(10, 500); // usage low, but only 500 free bytes
    const worker = makeWorker({
      lowWatermarkPercent: 50,
      highWatermarkPercent: 80,
      minFreeBytes: 1000,
      aggressiveMinAgeSeconds: 3600,
    });
    const decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    if (decision.action === 'clean') {
      assert.equal(decision.ctx.regime, 'aggressive');
      assert.equal(decision.ctx.thresholdScale, 0); // pressure = 1
      assert.equal(decision.ctx.minAgeSeconds, 3600);
    }
  });

  it('falls back to normal cleanup when statfs fails', async () => {
    mock.method(fs.promises, 'statfs', async () => {
      throw new Error('ENOSYS');
    });
    const worker = makeWorker({ lowWatermarkPercent: 50 });
    const decision = await worker.decideCleanup();
    assert.equal(decision.action, 'clean');
    if (decision.action === 'clean') {
      assert.equal(decision.ctx.regime, 'normal');
    }
  });
});

describe('FsCleanupWorker.getBatch', () => {
  let dir: string;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fscw-'));
    await fs.promises.writeFile(path.join(dir, 'file-a'), 'hello');
  });

  after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('threads the cleanup context through to shouldDelete', async () => {
    let seen: CleanupContext | undefined;
    const worker = makeWorker({
      basePath: dir,
      shouldDelete: async (_p: string, _s: fs.Stats, ctx: CleanupContext) => {
        seen = ctx;
        return false;
      },
    });
    const ctx: CleanupContext = {
      thresholdScale: 0.25,
      minAgeSeconds: 3600,
      regime: 'aggressive',
    };
    await worker.getBatch(dir, null, ctx, 10);
    assert.deepEqual(seen, ctx);
  });
});

describe('FsCleanupWorker.getBatch parallel walk', () => {
  let root: string;
  let files: string[];

  after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fscw-par-'));
    await fs.promises.mkdir(path.join(root, 'aa'));
    await fs.promises.mkdir(path.join(root, 'bb'));
    await fs.promises.writeFile(path.join(root, 'aa', 'f1'), 'x');
    await fs.promises.writeFile(path.join(root, 'aa', 'f2'), 'x');
    await fs.promises.writeFile(path.join(root, 'bb', 'f3'), 'x');
    await fs.promises.writeFile(path.join(root, 'bb', 'f4'), 'x');
    await fs.promises.writeFile(path.join(root, 'zz'), 'x'); // file at root level
    files = [
      path.join(root, 'aa', 'f1'),
      path.join(root, 'aa', 'f2'),
      path.join(root, 'bb', 'f3'),
      path.join(root, 'bb', 'f4'),
      path.join(root, 'zz'),
    ];
  });

  const deleteAll = async () => true;

  it('returns deletables in sorted order across the tree (concurrency > 1)', async () => {
    const worker = makeWorker({
      basePath: root,
      shouldDelete: deleteAll,
      walkConcurrency: 4,
    });
    const { batch } = await worker.getBatch(root, root);
    assert.deepEqual(batch, files);
  });

  it('respects the batchSize budget', async () => {
    const worker = makeWorker({
      basePath: root,
      shouldDelete: deleteAll,
      walkConcurrency: 4,
    });
    const { batch } = await worker.getBatch(root, root, undefined, 3);
    assert.deepEqual(batch, files.slice(0, 3));
  });

  it('resumes after lastPath without skipping or repeating', async () => {
    const worker = makeWorker({
      basePath: root,
      shouldDelete: deleteAll,
      walkConcurrency: 4,
    });
    // Resume just after the 3rd file (bb/f3) -> should return exactly f4, zz.
    const { batch } = await worker.getBatch(root, files[2]);
    assert.deepEqual(batch, files.slice(3));
  });

  it('counts kept files when nothing is deletable', async () => {
    const worker = makeWorker({
      basePath: root,
      shouldDelete: async () => false,
      walkConcurrency: 4,
    });
    const { batch, keptFileCount } = await worker.getBatch(root, root);
    assert.equal(batch.length, 0);
    assert.equal(keptFileCount, files.length);
  });
});

describe('FsCleanupWorker.processBatch', () => {
  let root: string;

  afterEach(() => {
    mock.restoreAll();
  });

  after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  before(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fscw-del-'));
    await fs.promises.writeFile(path.join(root, 'a-gone'), 'x');
    await fs.promises.writeFile(path.join(root, 'b-present'), 'x');
    await fs.promises.writeFile(path.join(root, 'c-present'), 'x');
  });

  // A selected file can legitimately disappear between the stat that selected
  // it and the unlink: a concurrent cleaner removed it, or -- in a staging
  // directory -- FsDataStore.finalize() renamed it into the blob tree. That
  // must not abort the batch, because an aborted batch also skips the lastPath
  // advance and the walk stops making progress.
  it('tolerates files that vanish before deletion and still advances', async () => {
    const deleted: string[] = [];
    const worker = makeWorker({
      basePath: root,
      shouldDelete: async () => true,
      walkConcurrency: 2,
      deleteCallback: async (file: string) => {
        if (file.endsWith('a-gone')) {
          const err: any = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        deleted.push(file);
      },
    });

    await assert.doesNotReject(() => worker.processBatch());

    // The surviving files were still deleted despite the ENOENT.
    assert.deepEqual(deleted.sort(), [
      path.join(root, 'b-present'),
      path.join(root, 'c-present'),
    ]);
  });
});

describe('warnIfWalkConcurrencyUnsafe', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // config reads UV_THREADPOOL_SIZE once at import, so these assert relative to
  // the value the module actually resolved rather than mutating the environment.
  const pool = config.UV_THREADPOOL_SIZE;
  const budget = Math.max(1, Math.floor(pool / 2));

  function captureWarn() {
    const calls: any[] = [];
    const child = log.child({});
    mock.method(child, 'warn', (...args: any[]) => calls.push(args));
    return { child, calls };
  }

  it('warns when workers collectively exceed half the thread pool', () => {
    const { child, calls } = captureWarn();
    // Two workers each taking the whole pool: unambiguously over budget.
    const workers = [1, 2].map(() => makeWorker({ walkConcurrency: pool }));
    warnIfWalkConcurrencyUnsafe(workers, child);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].totalWalkConcurrency, pool * 2);
    assert.equal(calls[0][1].uvThreadpoolSize, pool);
    assert.equal(calls[0][1].recommendedMaxTotal, budget);
  });

  it('stays quiet for a single worker at the derived default', () => {
    const { child, calls } = captureWarn();
    const workers = [
      makeWorker({
        walkConcurrency: config.FS_CLEANUP_WORKER_WALK_CONCURRENCY,
      }),
    ];
    warnIfWalkConcurrencyUnsafe(workers, child);
    assert.equal(calls.length, 0);
  });

  // On a stock pool (4) the minimum viable concurrency of 1 per worker already
  // reaches the whole pool once several workers are enabled, so the warning
  // fires and tells the operator to raise UV_THREADPOOL_SIZE. That is the
  // intended advice, not a false positive -- assert it rather than tune it away.
  it('derives a default that scales with the pool', () => {
    assert.equal(
      config.FS_CLEANUP_WORKER_WALK_CONCURRENCY,
      Math.max(1, Math.floor(config.UV_THREADPOOL_SIZE / 16)),
    );
    assert.ok(config.FS_CLEANUP_WORKER_WALK_CONCURRENCY >= 1);
    assert.ok(
      config.FS_CLEANUP_WORKER_WALK_CONCURRENCY <= config.UV_THREADPOOL_SIZE,
    );
  });

  it('ignores undefined (disabled) workers', () => {
    const { child, calls } = captureWarn();
    warnIfWalkConcurrencyUnsafe([undefined, undefined], child);
    assert.equal(calls.length, 0);
  });
});

describe('scaledThresholdSeconds', () => {
  it('returns the base threshold unchanged under NORMAL_CONTEXT', () => {
    // This is the no-regression guarantee for callers that leave watermarks
    // disabled: every batch runs with NORMAL_CONTEXT, so retention must be
    // byte-for-byte what it was before the context was threaded through.
    for (const base of [0, 1, 3600, 14_400, 2_592_000]) {
      assert.equal(scaledThresholdSeconds(base, NORMAL_CONTEXT), base);
    }
  });

  it('tightens retention as pressure rises', () => {
    const ctx: CleanupContext = {
      thresholdScale: 0.25,
      minAgeSeconds: 0,
      regime: 'aggressive',
    };
    assert.equal(scaledThresholdSeconds(14_400, ctx), 3600);
  });

  it('never evicts below the minimum-age floor', () => {
    // thresholdScale 0 would otherwise make everything eligible; the floor is
    // what stops aggressive cleanup from evicting freshly-written data.
    const ctx: CleanupContext = {
      thresholdScale: 0,
      minAgeSeconds: 3600,
      regime: 'aggressive',
    };
    assert.equal(scaledThresholdSeconds(14_400, ctx), 3600);
  });

  it('takes the floor when it exceeds the scaled threshold', () => {
    const ctx: CleanupContext = {
      thresholdScale: 0.1,
      minAgeSeconds: 7200,
      regime: 'aggressive',
    };
    // scaled = 1440s, floor = 7200s -> floor wins
    assert.equal(scaledThresholdSeconds(14_400, ctx), 7200);
  });
});
