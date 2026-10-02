/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { bandPublisherTag } from '../lib/index-band/build.js';
import {
  BAND_FILE,
  L1_FIRST_END,
  L1_SPAN,
  PARQUET_L1_TABLES,
} from '../lib/parquet-l1/layout.js';
import { buildCoreDb } from '../../test/parquet-l1-core-db.js';
import { createTestLogger } from '../../test/test-logger.js';
import type { ExportConfig } from './config.js';
import { deriveL1Bands, runL1Step } from './kinds/parquet-l1/kind.js';
import { ExportService, L1_RUN_BUDGET_MS, RETRY_FIRST_MS } from './service.js';
import { emptyIndexState, indexState, loadState } from './state.js';

const log = createTestLogger({ suite: 'index-export service parquet-l1' });
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
const FIRST = 2_000_000;
/** core.db holds FIRST-1 to FIRST+29; the top band may hold up to FIRST+28. */
const TOP = FIRST + 28;

describe('ExportService parquet-l1', () => {
  let dir: string;
  let now: number;
  let clock: () => number;
  let freeBytes: number;

  const config = (): ExportConfig => ({
    kinds: ['parquet-l1'],
    coreDbPath: path.join(dir, 'core.db'),
    l1PublishDir: path.join(dir, 'published', 'parquet-l1'),
    publisher: PUBLISHER,
    sources: [],
    sourceEnv: {},
    runAtMinute: 240,
    recentMaxBlocks: 1000,
    startHeight: 0,
    headerCheckUrl: '',
    headerCheckTimeoutMs: 1000,
    metricsPort: 0,
    publishDir: path.join(dir, 'published', 'root-tx-index'),
    workDir: path.join(dir, 'export'),
  });
  const service = () =>
    new ExportService({
      config: config(),
      log,
      now: () => clock(),
      openSources: async () => {
        throw new Error('root-TX sources opened with only parquet-l1 enabled');
      },
      openRoots: () => {
        throw new Error('roots opened with only parquet-l1 enabled');
      },
      diskSpace: async () => ({ free: freeBytes, total: 1e13 }),
    });
  const live = () => deriveL1Bands(config().l1PublishDir, PUBLISHER);
  const stateOf = async (index: string) =>
    indexState(await loadState(path.join(dir, 'export', 'state.json')), index);
  const steps = (report: { l1Steps: any[] }) =>
    report.l1Steps.map((s) => [s.role, s.heightRange, s.result, s.reason]);

  /** Band files for every whole range below FIRST, as if published before. */
  async function publishedBelow(skip: number[] = []) {
    const tag = bandPublisherTag(PUBLISHER);
    const ranges: Array<[number, number]> = [[0, L1_FIRST_END]];
    for (let from = L1_FIRST_END + 1; from < FIRST; from += L1_SPAN) {
      ranges.push([from, from + L1_SPAN - 1]);
    }
    for (const [from, to] of ranges) {
      if (skip.includes(from)) continue;
      const id = `l1-h${from}-${to}-${tag}-000000000000`;
      await fs.mkdir(path.join(config().l1PublishDir, id), { recursive: true });
      await fs.writeFile(
        path.join(config().l1PublishDir, id, BAND_FILE),
        JSON.stringify({
          version: 1,
          schema: 'l1-1',
          heightRange: [from, to],
          tables: Object.fromEntries(
            PARQUET_L1_TABLES.map((t) => [
              t.name,
              { rows: 0, rowDigest: '0'.repeat(64) },
            ]),
          ),
          createdAt: '2026-10-01T00:00:00Z',
        }),
      );
    }
    return ranges.length - skip.length;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-l1-'));
    now = Date.parse('2026-10-02T04:00:00Z');
    clock = () => now;
    freeBytes = 1e13;
    await buildCoreDb(path.join(dir, 'core.db'), FIRST, 30, { genesis: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('publishes the tip band below the top, then rebuilds it as the top moves, naming each one it replaced', async () => {
    const below = await publishedBelow();
    let report = await service().runOnce({ toHeight: FIRST + 9 });
    assert.deepEqual(steps(report), [
      ['d', [FIRST, FIRST + 9], 'published', 'new'],
    ]);
    const first = report.l1Steps[0].id as string;
    assert.equal((await stateOf('parquet-l1')).lastSuccess.d, report.at);

    // Unmoved: nothing to build.
    report = await service().runOnce({ toHeight: FIRST + 9 });
    assert.deepEqual(report.l1Steps, []);

    report = await service().runOnce({ toHeight: FIRST + 19 });
    const second = report.l1Steps[0].id as string;
    report = await service().runOnce();
    assert.deepEqual(steps(report), [['d', [FIRST, TOP], 'published', 'new']]);
    const bands = await live();
    assert.equal(bands.length, below + 1);
    const tip = bands.at(-1);
    assert.deepEqual([tip?.from, tip?.to], [FIRST, TOP]);
    // The one it replaces, and the one before that, for a subscriber that
    // missed the second.
    assert.deepEqual(tip?.band.supersedes, [first, second]);
  });

  it('keeps each index’s outcome to itself: root-TX state is untouched', async () => {
    await publishedBelow();
    await service().runOnce();
    const file = await loadState(path.join(dir, 'export', 'state.json'));
    assert.deepEqual(Object.keys(file.indexes), ['parquet-l1']);
    assert.equal((await stateOf('parquet-l1')).lastRun?.outcome, 'published');
  });

  it('builds and checks on a dry run, but publishes and saves nothing', async () => {
    const below = await publishedBelow();
    const report = await service().runOnce({ dryRun: true });
    assert.deepEqual(steps(report), [
      ['d', [FIRST, TOP], 'dry_run', 'dry_run'],
    ]);
    assert.equal(report.l1Steps[0].rows?.blocks, 29);
    assert.equal((await live()).length, below);
    assert.deepEqual(await stateOf('parquet-l1'), emptyIndexState());
  });

  it('refuses a core.db that starts above height 0, without retrying', async () => {
    const db = new Sqlite(path.join(dir, 'core.db'));
    db.prepare('DELETE FROM stable_blocks WHERE height = 0').run();
    db.close();
    const report = await service().runOnce();
    assert.deepEqual(steps(report), [
      ['h', [0, 0], 'couldnt_check', 'incomplete'],
    ]);
    const state = await stateOf('parquet-l1');
    assert.match(state.lastRun?.detail ?? '', /starts at height 1999999/);
    assert.equal(state.retry, undefined);
  });

  it('stops at a range core.db lacks, as could-not-check, without retrying', async () => {
    await publishedBelow([FIRST - L1_SPAN]);
    const report = await service().runOnce();
    assert.deepEqual(steps(report), [
      ['h', [FIRST - L1_SPAN, FIRST - 1], 'couldnt_check', 'incomplete'],
    ]);
    const state = await stateOf('parquet-l1');
    assert.equal(state.lastRun?.outcome, 'couldnt_check');
    assert.equal(state.retry, undefined);
  });

  it('holds a rejected band for an operator as the top moves, then rebuilds it on a forced run', async () => {
    await publishedBelow();
    const db = new Sqlite(path.join(dir, 'core.db'));
    db.prepare(
      'UPDATE stable_blocks SET hash_list_merkle = ? WHERE height = ?',
    ).run(Buffer.alloc(48, 1), FIRST + 3);
    db.close();
    let report = await service().runOnce({ toHeight: FIRST + 20 });
    assert.deepEqual(steps(report), [
      ['d', [FIRST, FIRST + 20], 'rejected', 'chain'],
    ]);
    const rejectedAt = (await stateOf('parquet-l1')).lastRejection?.at;

    // A day later the top has moved: the tip band's range is new, its rows
    // aren't.
    now += 24 * 3600_000;
    report = await service().runOnce();
    assert.deepEqual(steps(report), [['d', [FIRST, TOP], 'rejected', 'held']]);
    assert.equal(report.l1Steps[0].seconds, 0);
    assert.equal((await stateOf('parquet-l1')).lastRejection?.at, rejectedAt);

    report = await service().runOnce({ force: true });
    assert.deepEqual(steps(report), [['d', [FIRST, TOP], 'rejected', 'chain']]);
  });

  it('starts no whole band after its time budget, and runs again soon for the rest', async () => {
    await publishedBelow([FIRST - 2 * L1_SPAN, FIRST - L1_SPAN]);
    let calls = 0;
    clock = () => now + calls++ * L1_RUN_BUDGET_MS;
    const report = await service().runOnce();
    assert.deepEqual(report.l1Steps, []);
    assert.deepEqual(report.l1Deferred, [
      [FIRST - 2 * L1_SPAN, FIRST - L1_SPAN - 1],
      [FIRST - L1_SPAN, FIRST - 1],
      [FIRST, TOP],
    ]);
    const { retry } = await stateOf('parquet-l1');
    assert.equal(retry?.attempts, 0);
    assert.match(retry?.reason ?? '', /3 bands left by the time budget/);
  });

  it('publishes nothing once another run has taken the lock', async () => {
    const below = await publishedBelow();
    await fs.mkdir(config().workDir, { recursive: true });
    const outcome = await runL1Step(
      { role: 'd', heightRange: [FIRST, TOP], supersedes: [] },
      {
        coreDbPath: config().coreDbPath,
        workDir: config().workDir,
        publishDir: config().l1PublishDir,
        publisher: PUBLISHER,
        dryRun: false,
        log,
        stillHeld: async () => false,
      },
    );
    assert.deepEqual(
      [outcome.result, outcome.reason],
      ['couldnt_check', 'lock_lost'],
    );
    assert.equal((await live()).length, below);
    assert.deepEqual(
      (await fs.readdir(config().workDir)).filter((n) => n.startsWith('.')),
      [],
    );
  });

  it('refuses a band without room on the disk, and retries it', async () => {
    const below = await publishedBelow();
    freeBytes = 15 * 2 ** 30;
    const report = await service().runOnce();
    assert.deepEqual(steps(report), [
      ['d', [FIRST, TOP], 'couldnt_check', 'disk'],
    ]);
    assert.equal((await live()).length, below);
    const { retry } = await stateOf('parquet-l1');
    assert.equal(retry?.attempts, 1);
    assert.equal(Date.parse(retry?.at ?? ''), now + RETRY_FIRST_MS);
    assert.match(retry?.reason ?? '', /^disk; 15 GiB free/);
    assert.equal(await service().nextRunAt(), now + RETRY_FIRST_MS);
  });
});
