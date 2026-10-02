/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  bundleAndSignData,
  createData,
  EthereumSigner,
} from '@dha-team/arbundles';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { scanBundle, ScannedDataItem } from '../lib/ans104-bundle-scan.js';
import { ByteRangeSource } from '../lib/byte-range-source.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import type { BandRecord } from '../lib/index-band/build.js';
import { BufferByteRangeSource } from '../../test/buffer-byte-range-source.js';
import { createTestLogger } from '../../test/test-logger.js';
import type { ExportConfig } from './config.js';
import { newSourceStats, RecordSource } from './kinds/root-tx/sources/rows.js';
import { ExportLock } from './lock.js';
import {
  ExportService,
  reportForOutput,
  RETRY_FIRST_MS,
  runResult,
} from './service.js';
import {
  deriveOwnBands,
  indexState,
  loadState,
  OwnBand,
  updateIndexState,
} from './state.js';

const log = createTestLogger({ suite: 'index-export service' });
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
const ROOT = Buffer.alloc(32, 9);
const DAY = 24 * 3600_000;

/** A source over records in memory, reaching up to `top`. */
class MemorySource implements RecordSource {
  readonly rank = 0;
  readonly stats = newSourceStats();
  top = 0;
  fail?: string;

  constructor(
    readonly name: string,
    private readonly all: () => BandRecord[],
  ) {}

  async stableHeight() {
    if (this.fail !== undefined) throw new Error(this.fail);
    return this.top;
  }

  async *records(from: number, to: number) {
    for (const record of this.all()) {
      const height = record.height ?? 0;
      if (height < from || height > to || height > this.top) continue;
      this.stats.records += 1;
      yield { ...record, source: this.name };
    }
  }

  async close() {}
}

/**
 * Every height from the bottom of the lowest band to `top` is in some live
 * band: what a subscriber relies on.
 */
function assertCovered(bands: OwnBand[], from: number, top: number) {
  const ranges = bands.map((b) => [b.from, b.to ?? Infinity] as const);
  for (let height = from; height <= top; height++) {
    assert.ok(
      ranges.some(([lo, hi]) => lo <= height && height <= hi),
      `height ${height} is covered`,
    );
  }
}

describe('ExportService', () => {
  let items: ScannedDataItem[];
  let bundle: Buffer;
  let records: BandRecord[];
  let dir: string;
  let now: number;
  let gw1: MemorySource;
  let rootsFail: boolean;

  before(async () => {
    const signer = new EthereumSigner(`0x${'11'.repeat(32)}`);
    const signed = await bundleAndSignData(
      Array.from({ length: 3300 }, (_, i) => createData(`item ${i}`, signer)),
      signer,
    );
    bundle = signed.getRaw();
    items = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(bundle),
      rootTxId: toB64Url(ROOT),
      bundleSize: bundle.length,
    })) {
      items.push(item);
    }
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-service-'));
    now = Date.parse('2026-10-02T04:00:00Z');
    rootsFail = false;
    freeBytes = 1e13;
    // 1,100 items in each of h [1000, 1999], r [2000, 2087] and the
    // overlap [2089, 2600] a delta reads.
    records = items.map((item, i) => ({
      id: fromB64Url(item.id),
      rootTxId: ROOT,
      height:
        i < 1100
          ? 1000 + (i % 1000)
          : i < 2200
            ? 2000 + (i % 88)
            : 2089 + (i % 512),
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
      size: item.dataItemSize,
    }));
    gw1 = new MemorySource('gw1', () => records);
    gw1.top = 2600;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const config = (more: Partial<ExportConfig> = {}): ExportConfig => ({
    publisher: PUBLISHER,
    sources: [],
    sourceEnv: {},
    runAtMinute: 240,
    recentMaxBlocks: 1000,
    startHeight: 1000,
    headerCheckUrl: 'http://gateway.test',
    headerCheckTimeoutMs: 1000,
    metricsPort: 0,
    publishDir: path.join(dir, 'published', 'root-tx-index'),
    workDir: path.join(dir, 'export'),
    ...more,
  });

  let freeBytes: number;
  const roots = () => ({
    openRoot: (): ByteRangeSource =>
      rootsFail
        ? ({
            read: async () => {
              throw new Error('Request failed with status code 503');
            },
            close: async () => undefined,
          } as unknown as ByteRangeSource)
        : new BufferByteRangeSource(bundle),
    close: () => undefined,
  });
  const service = (
    more: Partial<ExportConfig> = {},
    sources: () => Array<{ source: RecordSource; optional: boolean }> = () => [
      { source: gw1, optional: false },
    ],
  ) =>
    new ExportService({
      config: config(more),
      log,
      now: () => now,
      openSources: async () => sources(),
      openRoots: roots,
      diskSpace: async () => ({ free: freeBytes, total: 1e13 }),
      headerCheck: { retryDelayMs: 1 },
    });

  const live = () => deriveOwnBands(config().publishDir, PUBLISHER, {});
  const exportState = async () =>
    indexState(
      await loadState(path.join(dir, 'export', 'state.json')),
      'root-tx-index',
    );

  it('bootstraps h and r at fixed edges up to the stable top, and records success', async () => {
    const report = await service().runOnce();
    assert.deepEqual(
      report.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [1000, 1999], 'published'],
        ['r', [2000, 2600], 'published'],
      ],
    );
    assert.equal(runResult(report), 'published');
    const bands = await live();
    assert.deepEqual(
      bands.map((b) => b.role),
      ['h', 'r'],
    );
    assertCovered(bands, 1000, 2600);
    const state = await exportState();
    assert.deepEqual(Object.keys(state.lastSuccess).sort(), ['h', 'r']);
    assert.equal(state.lastFoldAt, report.at, 'the new r counts as a fold');
    assert.equal(state.lastRun?.outcome, 'published');
    assert.equal(state.retry, undefined);
    assert.deepEqual(await fs.readdir(path.join(dir, 'export')), [
      'state.json',
    ]);
  });

  it('builds a daily delta above the r, then skips it while unchanged, despite a new id', async () => {
    await service().runOnce();
    now += DAY;
    gw1.top = 2650;
    const second = await service().runOnce();
    assert.deepEqual(
      second.steps.map((s) => [s.role, s.heightRange, s.result]),
      [['d', [2089, null], 'published']],
    );
    const delta = (await live()).find((b) => b.role === 'd');
    assertCovered(await live(), 1000, 2650);
    now += DAY;
    const third = await service().runOnce();
    assert.deepEqual(
      third.steps.map((s) => [s.role, s.result, s.reason]),
      [['d', 'unchanged', 'same_content']],
    );
    assert.equal((await live()).find((b) => b.role === 'd')?.id, delta?.id);
  });

  it('folds weekly with the delta held at its start, so no installation order leaves a gap', async () => {
    await service().runOnce();
    now += DAY;
    gw1.top = 2650;
    await service().runOnce();
    const first = await live();
    const oldR = first.find((b) => b.role === 'r');
    const oldD = first.find((b) => b.role === 'd');
    // A week on, the sources reach higher: the last 1,100 items move up.
    now += 7 * DAY;
    for (const record of records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    gw1.top = 3200;
    const report = await service().runOnce();
    const [fold, delta] = report.steps;
    assert.equal(fold.role, 'r');
    assert.deepEqual(fold.heightRange, [2000, 2999]);
    assert.equal(fold.result, 'published');
    assert.deepEqual(fold.band?.supersedes, [oldR?.id]);
    assert.ok((fold.inputs.folded ?? 0) >= 2200, 'the old r was folded in');
    // On a fold day the delta keeps its start, so it covers what the old r
    // did while a subscriber still downloads the new one. (Its items only
    // moved height, which bands don't store: its content is the same.)
    assert.equal(delta.role, 'd');
    assert.deepEqual(delta.heightRange, [2089, null]);
    assert.equal(delta.result, 'unchanged');
    // Every installation order: new d alone (old r kept), new r alone (old d
    // kept), both.
    const newR = (await live()).find((b) => b.role === 'r') as OwnBand;
    const newD = (await live()).find((b) => b.role === 'd') as OwnBand;
    assert.equal(newD.id, oldD?.id);
    const h = first.find((b) => b.role === 'h') as OwnBand;
    for (const installed of [
      [h, oldR as OwnBand, newD],
      [h, newR, oldD as OwnBand],
      [h, newR, newD],
    ]) {
      assertCovered(installed, 1000, 3200);
    }

    // The next day the delta moves up over the new r, and names every delta
    // it replaces, the first one included.
    now += DAY;
    const next = await service().runOnce();
    assert.deepEqual(
      next.steps.map((s) => [s.role, s.heightRange]),
      [['d', [2488, null]]],
    );
    assert.equal(next.steps[0].result, 'published');
    assert.ok(next.steps[0].band?.supersedes.includes(oldD?.id as string));
    assertCovered(await live(), 1000, 3200);
  });

  it('names earlier superseded deltas too, for a subscriber that missed one', async () => {
    const all = records;
    const without = (from: number, to: number) =>
      all.filter((_, i) => i < from || i >= to);
    await service().runOnce();
    gw1.top = 2650;
    // Three days, three different deltas.
    records = without(3200, 3300);
    now += DAY;
    const first = (await service().runOnce()).steps[0];
    records = all;
    now += DAY;
    const second = (await service().runOnce()).steps[0];
    records = without(3100, 3200);
    now += DAY;
    const third = (await service().runOnce()).steps[0];
    for (const step of [first, second, third]) {
      assert.equal(step.result, 'published');
    }
    assert.deepEqual(second.band?.supersedes, [first.band?.id]);
    assert.deepEqual(
      [...(third.band?.supersedes ?? [])].sort(),
      [first.band?.id, second.band?.id].sort(),
      'the first delta too, though no longer offered',
    );
  });

  it('rejects a band whose sources conflict on more than 1% of it', async () => {
    await service().runOnce();
    now += DAY;
    gw1.top = 2650;
    // A second indexer giving 100 of the delta's items other offsets.
    const gw2 = new MemorySource('gw2', () =>
      records.slice(2200, 2300).map((r, i) => ({
        ...r,
        rootOffset: records[2300 + i].rootOffset,
        rootDataOffset: records[2300 + i].rootDataOffset,
      })),
    );
    gw2.top = 2650;
    const report = await service({}, () => [
      { source: gw1, optional: false },
      { source: gw2, optional: false },
    ]).runOnce();
    assert.equal(report.steps[0].result, 'rejected');
    assert.equal(report.steps[0].reason, 'conflicts');
    assert.match(report.steps[0].details?.[0] ?? '', /100 conflicting IDs/);
  });

  it('rejects a band with no offsets to check, rather than retry it forever', async () => {
    records = records.map(
      ({ rootOffset, rootDataOffset, size, ...rest }) => rest,
    );
    const report = await service().runOnce();
    assert.equal(report.steps[0].result, 'rejected');
    assert.equal(report.steps[0].reason, 'no_offsets');
    assert.equal((await exportState()).retry, undefined);
  });

  it('runs a dry run beside a run that holds the lock', async () => {
    await fs.mkdir(path.join(dir, 'export'), { recursive: true });
    const held = await ExportLock.acquire(path.join(dir, 'export', 'lock'));
    assert.ok(held.acquired);
    try {
      const report = await service().runOnce({ dryRun: true });
      assert.equal(report.locked, undefined);
      assert.ok(report.steps.length > 0);
    } finally {
      await held.lock.release();
    }
  });

  it('builds and checks on a dry run, but publishes, locks and saves nothing', async () => {
    const report = await service().runOnce({ dryRun: true });
    assert.deepEqual(
      report.steps.map((s) => [s.role, s.result]),
      [
        ['h', 'dry_run'],
        ['r', 'dry_run'],
      ],
    );
    assert.equal(report.gateUrl, 'http://gateway.test');
    // Printed without each band's header sample, which only counts.
    const printed = reportForOutput(report) as {
      steps: Array<{ band: Record<string, unknown> }>;
    };
    assert.equal(printed.steps[0].band.sample, undefined);
    assert.equal(printed.steps[0].band.sampled, 150);
    assert.equal(printed.steps[0].band.records, report.steps[0].band?.records);
    assert.ok(report.peakBytes >= (report.steps[0].peakBytes ?? 0));
    assert.ok((report.steps[0].peakBytes ?? 0) > 0);
    assert.deepEqual(await live(), []);
    assert.deepEqual(await fs.readdir(path.join(dir, 'export')), ['dry-run']);
    assert.deepEqual(
      await fs.readdir(path.join(dir, 'export', 'dry-run')),
      [],
      'no staging left',
    );
  });

  it('keeps a dry run’s bands at a fixed height for comparing', async () => {
    const keep = path.join(dir, 'export', 'compare');
    const report = await service().runOnce({ keepDir: keep, toHeight: 2300 });
    assert.equal(report.stableTop, 2300);
    assert.equal(report.keptIn, keep);
    assert.deepEqual(
      report.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [1000, 1999], 'published'],
        ['r', [2000, 2300], 'published'],
      ],
    );
    assert.equal((await fs.readdir(keep)).length, 2);
    assert.deepEqual(await live(), [], 'nothing in the real publish directory');
    await assert.rejects(fs.stat(path.join(dir, 'export', 'state.json')));
  });

  it('rejects a band with a wrong header, keeps what is published, and does not retry', async () => {
    await service().runOnce();
    const before = await live();
    now += DAY;
    gw1.top = 2650;
    // A source now gives a third of the delta's items another item's
    // offsets, so any sample holds some.
    for (let i = 2200; i < 2600; i++) {
      records[i] = {
        ...records[i],
        rootOffset: records[i + 1].rootOffset,
        rootDataOffset: records[i + 1].rootDataOffset,
      };
    }
    const report = await service().runOnce();
    assert.equal(runResult(report), 'rejected');
    assert.equal(report.steps[0].reason, 'wrong_header');
    const state = await exportState();
    assert.equal(state.retry, undefined);
    assert.match(state.lastRejection?.reasons.join(' ') ?? '', /wrong_header/);
    assert.deepEqual(
      (await live()).map((b) => b.id),
      before.map((b) => b.id),
    );
  });

  it('waits for an operator after a rejected fold, then folds on a forced run', async () => {
    await service().runOnce();
    now += 8 * DAY;
    gw1.top = 3200;
    for (const record of records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    // The fold reads 2089 and up: corrupt a third of those rows.
    const good = records.map((r) => ({ ...r }));
    for (let i = 2200; i < 2600; i++) {
      records[i] = {
        ...records[i],
        rootOffset: records[i + 1].rootOffset,
        rootDataOffset: records[i + 1].rootDataOffset,
      };
    }
    const rejected = await service().runOnce();
    assert.equal(rejected.steps[0].role, 'r');
    assert.equal(rejected.steps[0].result, 'rejected');
    records = good;
    now += DAY;
    const daily = await service().runOnce();
    assert.ok(
      daily.steps.every((s) => s.role !== 'r'),
      'no fold until an operator runs one',
    );
    const forced = await service().runOnce({ force: true });
    assert.equal(forced.steps[0].role, 'r');
    assert.equal(forced.steps[0].result, 'published');
    assert.equal((await exportState()).foldRejectedAt, undefined);
  });

  it('does not fold twice in a week when a crash lost the state after a fold', async () => {
    await service().runOnce();
    await fs.rm(path.join(dir, 'export', 'state.json'));
    now += DAY;
    gw1.top = 2700;
    const report = await service().runOnce();
    assert.ok(
      report.steps.every((s) => s.role === 'd'),
      'the r manifest dates the last fold',
    );
  });

  it('retries a run that could not check, backing off, and clears on success', async () => {
    rootsFail = true;
    const first = await service().runOnce();
    assert.equal(runResult(first), 'couldnt_check');
    assert.equal(first.steps[0].reason, 'gate');
    let state = await exportState();
    assert.equal(state.retry?.attempts, 1);
    assert.equal(Date.parse(state.retry?.at ?? ''), now + RETRY_FIRST_MS);
    assert.equal(await service().nextRunAt(), now + RETRY_FIRST_MS);
    assert.deepEqual(await live(), [], 'nothing published or withdrawn');

    now += RETRY_FIRST_MS;
    await service().runOnce();
    state = await exportState();
    assert.equal(state.retry?.attempts, 2);
    assert.equal(Date.parse(state.retry?.at ?? ''), now + 2 * RETRY_FIRST_MS);

    rootsFail = false;
    now += 2 * RETRY_FIRST_MS;
    await service().runOnce();
    state = await exportState();
    assert.equal(state.retry, undefined);
  });

  it('fails a run whose required source is down, and leaves an optional one out', async () => {
    gw1.fail = 'connection refused';
    const down = await service().runOnce();
    assert.equal(down.failed?.reason, 'source');
    assert.match(down.failed?.message ?? '', /connection refused/);

    const gw2 = new MemorySource('gw2', () => []);
    gw2.fail = 'peer down';
    gw1.fail = undefined;
    const report = await service({}, () => [
      { source: gw1, optional: false },
      { source: gw2, optional: true },
    ]).runOnce();
    assert.equal(runResult(report), 'published');
  });

  it('refuses to bootstrap over bands it did not build', async () => {
    const foreign = path.join(config().publishDir, 'b1-h1950000-tip-turbo');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(
      path.join(foreign, 'manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: '2026-09-29T00:00:00Z',
        totalRecords: 1,
        partitions: [
          {
            prefix: '00',
            location: { type: 'file', filename: '00.cdb' },
            recordCount: 1,
            size: 1,
          },
        ],
        metadata: { heightRange: [1950000, null] },
      }),
    );
    const report = await service().runOnce();
    assert.equal(report.failed?.reason, 'foreign_bands');
    assert.match(report.failed?.message ?? '', /adopt them first/);
    assert.equal(runResult(report), 'rejected');
    assert.deepEqual(report.steps, []);
  });

  it('resumes an interrupted bootstrap above the history it published', async () => {
    rootsFail = true;
    const svc = service({ startHeight: 0 });
    // h [0, 999] has no rows: skipped, empty. Then h [1000, 1999] can't be
    // checked: the bootstrap stops there.
    const first = await svc.runOnce();
    assert.deepEqual(
      first.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [0, 999], 'skipped'],
        ['h', [1000, 1999], 'couldnt_check'],
      ],
    );
    rootsFail = false;
    now += RETRY_FIRST_MS;
    const second = await svc.runOnce();
    assert.deepEqual(
      second.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [0, 999], 'skipped'],
        ['h', [1000, 1999], 'published'],
        ['r', [2000, 2600], 'published'],
      ],
    );
  });

  it('publishes a small history band rather than leave its heights uncovered', async () => {
    records = records.filter((_, i) => i >= 1100 || i % 10 === 0);
    const report = await service().runOnce();
    assert.equal(report.steps[0].role, 'h');
    assert.equal(report.steps[0].result, 'published');
    assert.ok((report.steps[0].band?.records ?? 0) < 1000);
  });

  it('refuses a step without room on the disk', async () => {
    freeBytes = 5 * 1024 ** 3;
    const report = await service().runOnce();
    assert.equal(report.failed?.reason, 'disk');
    assert.match(report.failed?.message ?? '', /margin/);
    assert.equal(runResult(report), 'couldnt_check');
  });

  it('does not run while another holds a fresh lock', async () => {
    await fs.mkdir(path.join(dir, 'export'), { recursive: true });
    const held = await ExportLock.acquire(path.join(dir, 'export', 'lock'));
    assert.ok(held.acquired);
    const report = await service().runOnce();
    assert.equal(runResult(report), 'locked');
    assert.deepEqual(report.steps, []);
    await held.lock.release();
  });

  it('recovers its bands from disk when state.json is lost', async () => {
    await service().runOnce();
    await fs.rm(path.join(dir, 'export', 'state.json'));
    now += DAY;
    const report = await service().runOnce();
    assert.ok(
      report.steps.every((s) => s.role !== 'h'),
      'no second bootstrap',
    );
  });

  it('reports alive from its heartbeat, whatever its runs do', async () => {
    rootsFail = true;
    const svc = service();
    svc.start();
    try {
      assert.equal(svc.alive(), true);
      now += 6 * 60_000;
      assert.equal(svc.alive(), false, 'no tick for six minutes');
    } finally {
      await svc.stop(0);
    }
  });

  it('schedules the daily run, a missed day soon, and a run that died soon', async () => {
    const svc = service();
    // Never run: soon.
    assert.equal(await svc.nextRunAt(), now + 5 * 60_000);
    await svc.runOnce();
    // Ran today at 04:00: tomorrow at 04:00.
    assert.equal(await svc.nextRunAt(), Date.parse('2026-10-03T04:00:00Z'));
    // A run that died part way (its outcome still "running"): soon.
    await updateIndexState(
      path.join(dir, 'export', 'state.json'),
      'root-tx-index',
      (state) => {
        state.lastRun = { at: new Date(now).toISOString(), outcome: 'running' };
      },
    );
    assert.equal(await svc.nextRunAt(), now + 5 * 60_000);
  });
});
