/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import * as metrics from '../metrics.js';
import {
  IMPORT_ALLOCATOR_ENV,
  importEnv,
  L2BandImportWorker,
  L2ImportRunner,
  L2ImportSummary,
} from './l2-band-import-worker.js';

const log = createTestLogger({ suite: 'L2BandImportWorker' });

/** A runner that answers from a list, recording each run's arguments. */
function runner(
  answers: Array<{ code: number; summary?: L2ImportSummary }>,
): L2ImportRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: L2ImportRunner = async (args) => {
    calls.push(args);
    const answer = answers.shift() ?? { code: 0, summary: { imported: 0 } };
    return { ...answer, tail: '' };
  };
  return Object.assign(run, { calls });
}

const worker = (
  runImport: L2ImportRunner,
  extra: Partial<ConstructorParameters<typeof L2BandImportWorker>[0]> = {},
) =>
  new L2BandImportWorker({
    log,
    indexes: ['ardrive-l2'],
    publication: 'https://publisher.example/ar-io/indexes',
    registryUrl: 'http://localhost:4000',
    intervalMs: 60_000,
    runImport,
    invocation: ['cli.js'],
    listDir: async () => ['l2-h0-99999-3078e8b8-000000000000~1'],
    ...extra,
  });

const runs = async (result: string) =>
  (await metrics.l2BandImportRunsTotal.get()).values.find(
    (v) => v.labels.result === result,
  )?.value ?? 0;

describe('importEnv', () => {
  it("adds glibc's allocator settings, and keeps an operator's own", () => {
    assert.deepEqual(importEnv({ PATH: '/bin' }), {
      ...IMPORT_ALLOCATOR_ENV,
      PATH: '/bin',
    });
    assert.equal(importEnv({ MALLOC_ARENA_MAX: '4' }).MALLOC_ARENA_MAX, '4');
  });
});

describe('L2BandImportWorker', () => {
  it('runs index-l2-import into ClickHouse for each index', async () => {
    const run = runner([]);
    const w = worker(run, {
      indexes: ['ardrive-l2', 'other-l2'],
      arweaveNodes: ['http://node-a:1984', 'http://node-b:1984'],
      maxQueued: 3,
      maxUnchecked: 2,
    });
    await w.runOnce('ardrive-l2');
    await w.runOnce('other-l2');
    assert.deepEqual(run.calls[0], [
      'cli.js',
      'index-l2-import',
      '--target',
      'clickhouse',
      '--bands-dir',
      'data/indexes/installed/ardrive-l2',
      '--publication',
      'https://publisher.example/ar-io/indexes',
      '--registry-url',
      'http://localhost:4000',
      '--arweave-nodes',
      'http://node-a:1984,http://node-b:1984',
      '--max-queued',
      '3',
      '--max-unchecked',
      '2',
    ]);
    assert.equal(run.calls[1][5], 'data/indexes/installed/other-l2');
  });

  it('starts no import when stopped while it read the bands directory', async () => {
    const run = runner([]);
    let w: L2BandImportWorker | undefined = undefined;
    w = worker(run, {
      firstRunDelayMs: 0,
      listDir: async () => {
        // Shutdown begins while the directory is read; stop() sets the flag
        // at once and then waits for this run, so it is not awaited here.
        void w?.stop();
        return ['band-a'];
      },
    });
    w.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.stop();
    assert.equal(run.calls.length, 0);
  });

  it('leaves out --max-unchecked at its default of 0', async () => {
    const run = runner([]);
    await worker(run).runOnce('ardrive-l2');
    assert.equal(run.calls[0].includes('--max-unchecked'), false);
  });

  it('is idle, and runs nothing, while no band is installed', async () => {
    const run = runner([]);
    const before = await runs('idle');
    const w = worker(run, {
      listDir: async () => {
        throw Object.assign(new Error('no such directory'), {
          code: 'ENOENT',
        });
      },
    });
    assert.equal(await w.runOnce('ardrive-l2'), undefined);
    assert.equal(run.calls.length, 0);
    assert.equal(await runs('idle'), before + 1);
  });

  it('counts rows queued and conflicts', async () => {
    const rowsBefore = (await metrics.l2BandImportRowsTotal.get()).values[0]
      .value;
    const conflictsBefore = (await metrics.l2BandImportConflictsTotal.get())
      .values[0].value;
    const run = runner([
      {
        code: 0,
        summary: {
          imported: 2,
          jobs: [
            { band: 'a', counts: { written: 100, conflicting: 2 } },
            { band: 'b', job: null, counts: { written: 0, conflicting: 5 } },
          ],
        },
      },
    ]);
    await worker(run).runOnce('ardrive-l2');
    assert.equal(
      (await metrics.l2BandImportRowsTotal.get()).values[0].value,
      rowsBefore + 100,
    );
    assert.equal(
      (await metrics.l2BandImportConflictsTotal.get()).values[0].value,
      conflictsBefore + 7,
    );
  });

  it('waits, twice as long each time, while the same bands are refused', async () => {
    let now = 0;
    const refused = {
      code: 1,
      summary: { refused: 'band: a check failed', refusal: 'refused' as const },
    };
    const run = runner([refused, refused, refused]);
    const w = worker(run, { now: () => now });
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 1);
    now = 30_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 1, 'deferred within the interval');
    now = 60_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 2, 'tried again after the interval');
    now = 60_000 + 90_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 2, 'the wait doubled to 120 s');
    now = 60_000 + 120_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 3);
  });

  it('tries a refused index again at once when its bands change', async () => {
    let now = 0;
    let entries = ['band-a'];
    const run = runner([
      { code: 1, summary: { refused: 'band-a: a check failed' } },
      { code: 0, summary: { imported: 1 } },
    ]);
    const w = worker(run, { now: () => now, listDir: async () => entries });
    await w.runOnce('ardrive-l2');
    now = 1_000;
    entries = ['band-b'];
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 2);
  });

  it('waits after a run that failed without refusing, at most two hours', async () => {
    let now = 0;
    const crashed = { code: 1 };
    const run = runner([crashed, crashed, crashed]);
    const w = worker(run, { now: () => now });
    await w.runOnce('ardrive-l2');
    now = 30_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 1, 'not retried within the interval');
    now = 60_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 2);
    now = 60_000 + 90_000;
    await w.runOnce('ardrive-l2');
    assert.equal(run.calls.length, 2, 'the wait doubled');
  });

  it('counts an unreadable sample apart from a refusal', async () => {
    const before = await runs('unreadable');
    const run = runner([
      {
        code: 1,
        summary: { refused: 'band: a check failed', refusal: 'unreadable' },
      },
    ]);
    await worker(run).runOnce('ardrive-l2');
    assert.equal(await runs('unreadable'), before + 1);
  });
});
