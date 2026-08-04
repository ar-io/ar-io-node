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

import { createTestLogger } from '../../test/test-logger.js';
import { CleanupContext, FsCleanupWorker } from './fs-cleanup-worker.js';

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
