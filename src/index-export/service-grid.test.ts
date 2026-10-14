/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  DAY,
  PUBLISHER,
  useExportService,
} from '../../test/index-export-service-fixture.js';
import { createTestLogger } from '../../test/test-logger.js';
import { ByteRangeSource } from '../lib/byte-range-source.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { BandRecord, buildBand } from '../lib/index-band/build.js';
import { bandEntries, readBandManifest } from '../lib/index-band/read.js';
import type { ExportConfig } from './config.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import type { RecordSource } from './kinds/root-tx/sources/rows.js';
import { runResult } from './service.js';
import { deriveOwnBands, GRID_ROLES, OwnBand } from './state.js';

const log = createTestLogger({ suite: 'index-export grid' });

/** One root per height, as on chain: a root is in one block. */
const rootAt = (height: number) =>
  crypto.createHash('sha256').update(`root-${height}`).digest();

const ids = (bands: OwnBand[]) => bands.map((band) => band.id);

async function entryIds(band: { dir: string }): Promise<Set<string>> {
  const found = new Set<string>();
  const manifest = await readBandManifest(band.dir);
  for await (const { key } of bandEntries(band.dir, manifest)) {
    found.add(toB64Url(key));
  }
  return found;
}

describe('ExportService, grid layout', () => {
  const ctx = useExportService();

  const grid = (more: Partial<ExportConfig> = {}): Partial<ExportConfig> => ({
    rootTxLayout: 'grid',
    settleBlocks: 100,
    resettleIntervalMs: 0,
    ...more,
  });
  const live = () =>
    deriveOwnBands(ctx.config().publishDir, PUBLISHER, {}, GRID_ROLES);
  const find = async (prefix: string) =>
    (await live()).find((band) => band.id.startsWith(prefix)) as OwnBand;
  const record = (i: number, height: number): BandRecord => {
    const item = ctx.items[i];
    return {
      id: fromB64Url(item.id),
      rootTxId: rootAt(height),
      height,
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
      size: item.dataItemSize,
    };
  };
  /** Every item id in some live band: what a subscriber relies on. */
  const assertAllHeld = async (expected: string[]) => {
    const held = new Set<string>();
    for (const band of await live()) {
      for (const id of await entryIds(band)) held.add(id);
    }
    const missing = expected.filter((id) => !held.has(id));
    assert.deepEqual(missing, [], 'every entry is in a live band');
  };

  /**
   * A: 500 items in h [0, 99999]; B and C: 300 in each of the d bands at
   * 100,000 and 105,000; D: 1,200 over the 100 heights above 110,000, the
   * tip at first; E: 1,000 above 115,000, beyond the sources at first.
   */
  const gridRecords = () => {
    ctx.records = ctx.items.map((_, i) =>
      record(
        i,
        i < 500
          ? 50_000 + i
          : i < 800
            ? 100_000 + (i % 300)
            : i < 1100
              ? 105_000 + (i % 300)
              : i < 2300
                ? 110_000 + (i % 100)
                : 115_000 + (i % 200),
      ),
    );
    ctx.gw1.top = 110_100;
  };
  const allIds = () => ctx.items.map((item) => item.id);
  const inBand = (from: number, to: number) =>
    ctx.records
      .filter((r) => (r.height ?? -1) >= from && (r.height ?? -1) <= to)
      .map((r) => toB64Url(r.id));

  /** An overlay directory relocating some of band C's entries. */
  const overlay = async (
    items: number[],
    place: (i: number) => { root: Buffer; from: number },
  ): Promise<RecordSource> => {
    const dir = path.join(ctx.dir, 'overlay');
    await fs.mkdir(dir, { recursive: true });
    const lines = items.map((i) => {
      const r = ctx.records[i];
      const { root, from } = place(i);
      const at = ctx.items[from];
      return `${toB64Url(r.id)},${toB64Url(root)},,${at.rootDataItemOffset},${at.rootDataOffset},${at.dataItemSize},${r.height}`;
    });
    await fs.writeFile(
      path.join(dir, '105000-109999.csv'),
      `${lines.join('\n')}\n`,
    );
    return new CsvOverlaySource('bundler', dir);
  };
  const withOverlay = (source: RecordSource) => () => [
    { source: ctx.gw1, optional: false },
    { source, optional: false },
  ];

  it('bootstraps on the grid: whole h ranges, settled d bands, then the tip', async () => {
    gridRecords();
    const report = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.role, s.heightRange, s.result]),
      [
        ['freeze', 'h', [0, 99_999], 'published'],
        ['freeze', 'd', [100_000, 104_999], 'published'],
        ['freeze', 'd', [105_000, 109_999], 'published'],
        ['tip', 'tip', [110_000, null], 'published'],
      ],
    );
    assert.deepEqual(
      report.plan?.map((p) => [p.step, p.heightRange]),
      report.steps.map((s) => [s.grid, s.heightRange]),
    );
    assert.equal(runResult(report), 'published');
    assert.deepEqual(
      (await live()).map((b) => b.id.split('-').slice(0, 3).join('-')),
      ['h-h0-99999', 'd-h100000-104999', 'd-h105000-109999', 'tip-h110000-tip'],
    );
    assert.deepEqual(report.steps[3].band?.records, 1200);
    const state = await ctx.exportState();
    assert.deepEqual(Object.keys(state.lastSuccess).sort(), ['d', 'h', 'tip']);
    assert.equal(state.lastFoldAt, undefined, 'no folds in the grid');
    await assertAllHeld(inBand(0, 110_100));
  });

  it('freezes the tip’s range with its entries, keeps the tip’s start that day, then moves it up', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const firstTip = await find('tip-');
    // The sources lose 50 of the tip's rows (their roots stay known from
    // the rest), and every row of one root.
    const lost = ctx.records.slice(1100, 1150).map((r) => toB64Url(r.id));
    const orphan = ctx.records
      .slice(1100, 2300)
      .filter((r) => r.height === 110_099)
      .map((r) => toB64Url(r.id));
    assert.equal(orphan.length, 12);
    const kept = ctx.records;
    ctx.records = kept.filter(
      (r) => !lost.includes(toB64Url(r.id)) && !orphan.includes(toB64Url(r.id)),
    );

    ctx.now += DAY;
    ctx.gw1.top = 115_200;
    const freezeDay = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      freezeDay.steps.map((s) => [s.grid, s.heightRange, s.result]),
      [
        ['freeze', [110_000, 114_999], 'published'],
        ['tip', [110_000, null], 'published'],
      ],
    );
    const [freeze, tip] = freezeDay.steps;
    assert.deepEqual(freeze.seeds, {
      placed: 1188,
      settled: 0,
      carried: 0,
      unresolved: 0,
    });
    const d = await find('d-h110000-114999-');
    const inD = await entryIds(d);
    assert.ok(
      lost.every((id) => inD.has(id)),
      'the rows the sources lost come from the tip',
    );
    assert.ok(
      orphan.every((id) => !inD.has(id)),
      'an entry with no height to place it stays out of a frozen band',
    );
    assert.equal(tip.seeds?.unresolved, 12);
    assert.ok(
      tip.band?.supersedes.includes(firstTip.id),
      'the new tip supersedes the old',
    );
    assert.ok(!ids(await live()).includes(firstTip.id));

    ctx.now += DAY;
    ctx.gw1.top = 115_300;
    const nextDay = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      nextDay.steps.map((s) => [s.grid, s.heightRange, s.result]),
      [['tip', [115_000, null], 'published']],
    );
    assert.deepEqual(nextDay.steps[0].seeds, {
      placed: 0,
      settled: 1188,
      carried: 0,
      unresolved: 12,
    });
    assert.equal(nextDay.steps[0].band?.records, 1012);
    assert.deepEqual(
      (await live()).map((b) => b.id.split('-').slice(0, 3).join('-')),
      [
        'h-h0-99999',
        'd-h100000-104999',
        'd-h105000-109999',
        'd-h110000-114999',
        'tip-h115000-tip',
      ],
    );
    await assertAllHeld(allIds());

    // Nothing new: the same tip, not published again.
    ctx.now += DAY;
    const quiet = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      quiet.steps.map((s) => [s.grid, s.result, s.reason]),
      [['tip', 'unchanged', 'same_content']],
    );
  });

  it('rolls twenty d bands into their h, from their entries alone', async () => {
    ctx.records = ctx.items.map((_, i) =>
      record(
        i,
        i < 300
          ? 50_000 + i
          : i < 2300
            ? 100_000 + ((i - 300) % 20) * 5000 + ((i - 300) % 7)
            : 200_000 + (i % 50),
      ),
    );
    ctx.gw1.top = 105_100;
    const first = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      first.steps.map((s) => [s.grid, s.heightRange, s.result, s.reason]),
      [
        ['freeze', [0, 99_999], 'published', 'new'],
        ['freeze', [100_000, 104_999], 'published', 'new'],
        ['tip', [105_000, null], 'skipped', 'below_min'],
      ],
    );

    ctx.now += DAY;
    ctx.gw1.top = 200_100;
    // A dry run first: the roll waits on d bands it did not publish.
    const dry = await ctx.service(grid()).runOnce({ dryRun: true });
    const dryRoll = dry.steps.find((s) => s.grid === 'roll');
    assert.equal(dryRoll?.result, 'dry_run');
    assert.equal(dryRoll?.reason, 'after_planned');
    assert.equal(dry.plan?.find((p) => p.step === 'roll')?.awaits?.length, 19);

    const report = await ctx.service(grid()).runOnce();
    const freezes = report.steps.filter((s) => s.grid === 'freeze');
    assert.equal(freezes.length, 19);
    assert.ok(freezes.every((s) => s.result === 'published'));
    const roll = report.steps.find((s) => s.grid === 'roll');
    assert.equal(roll?.result, 'published');
    assert.deepEqual(roll?.heightRange, [100_000, 199_999]);
    assert.equal(roll?.inputs.folded, 2000);
    assert.equal(roll?.band?.records, 2000);
    assert.equal(roll?.band?.supersedes.length, 20);
    const tip = report.steps.find((s) => s.grid === 'tip');
    assert.deepEqual(tip?.heightRange, [105_000, null], 'its start kept');
    assert.deepEqual(
      (await live()).map((b) => b.id.split('-').slice(0, 3).join('-')),
      ['h-h0-99999', 'h-h100000-199999', 'tip-h105000-tip'],
    );
    await assertAllHeld(allIds());
  });

  it('plans and builds on a dry run, but publishes and keeps nothing', async () => {
    gridRecords();
    const report = await ctx.service(grid()).runOnce({ dryRun: true });
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.heightRange, s.result]),
      [
        ['freeze', [0, 99_999], 'dry_run'],
        ['freeze', [100_000, 104_999], 'dry_run'],
        ['freeze', [105_000, 109_999], 'dry_run'],
        ['tip', [110_000, null], 'dry_run'],
      ],
    );
    assert.equal(report.plan?.length, 4);
    assert.deepEqual(await live(), []);
    assert.deepEqual(
      await fs.readdir(path.join(ctx.dir, 'export')),
      [],
      'no state, no staging, no dry-run directory',
    );
  });

  it(
    'dry-runs freezes, the tip and re-settles against a read-only publish directory',
    // Root reads past file permissions, so the check would prove nothing.
    { skip: process.getuid?.() === 0 },
    async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const publishDir = ctx.config().publishDir;
      const before = ids(await live());
      // A week on: a d is due to freeze, and late rows for another.
      for (let i = 2300; i < 2340; i++) {
        ctx.records[i] = record(i, 105_500 + (i % 40));
      }
      ctx.gw1.top = 115_200;
      ctx.now += 7 * DAY;
      // As a read-only mount: no file or directory in it can change.
      const modes = new Map<string, number>();
      const freeze = async (target: string) => {
        const stat = await fs.stat(target);
        modes.set(target, stat.mode);
        if (stat.isDirectory()) {
          for (const name of await fs.readdir(target)) {
            await freeze(path.join(target, name));
          }
        }
        await fs.chmod(target, stat.isDirectory() ? 0o555 : 0o444);
      };
      await freeze(publishDir);
      try {
        const report = await ctx.service(grid()).runOnce({
          dryRun: true,
          resettle: true,
        });
        assert.equal(report.failed, undefined);
        assert.deepEqual(
          report.steps.map((s) => [s.grid, s.heightRange[0], s.result]),
          [
            ['freeze', 110_000, 'dry_run'],
            ['tip', 110_000, 'dry_run'],
            ['resettle', 0, 'unchanged'],
            ['resettle', 100_000, 'unchanged'],
            ['resettle', 105_000, 'dry_run'],
          ],
        );
        assert.equal(report.steps[4].resettle?.added, 40);
      } finally {
        for (const [target, mode] of [...modes].reverse()) {
          await fs.chmod(target, mode);
        }
      }
      assert.deepEqual(ids(await live()), before);
      assert.deepEqual(await fs.readdir(path.join(ctx.dir, 'export')), [
        'state.json',
      ]);
    },
  );

  it('refuses own bands off the grid, and builds nothing', async () => {
    gridRecords();
    await buildBand({
      log,
      records: ctx.records.slice(0, 1000),
      publishDir: ctx.config().publishDir,
      workDir: path.join(ctx.dir, 'scratch'),
      publisher: PUBLISHER,
      kind: 'h',
      heightRange: [1000, 1999],
    });
    const report = await ctx.service(grid()).runOnce();
    assert.equal(report.failed?.reason, 'grid_layout');
    assert.match(
      report.failed?.message ?? '',
      /h-h1000-1999-\S+ .* off the grid/,
    );
    assert.deepEqual(report.steps, []);
    assert.equal(runResult(report), 'rejected');
    const state = await ctx.exportState();
    assert.equal(state.retry, undefined, 'not retried: it needs an operator');
    assert.match(state.lastRejection?.reasons.join(' ') ?? '', /grid_layout/);
    assert.equal((await live()).length, 1);
  });

  it('adopts grid bands built by index-band-build as they are', async () => {
    gridRecords();
    const publishDir = ctx.config().publishDir;
    const workDir = path.join(ctx.dir, 'scratch');
    for (const [kind, from, to] of [
      ['h', 0, 99_999],
      ['d', 100_000, 104_999],
      ['d', 105_000, 109_999],
      ['tip', 110_000, null],
    ] as const) {
      await buildBand({
        log,
        records: ctx.records.filter(
          (r) =>
            (r.height ?? 0) >= from && (r.height ?? 0) <= (to ?? ctx.gw1.top),
        ),
        publishDir,
        workDir,
        publisher: PUBLISHER,
        kind,
        heightRange: [from, to],
      });
    }
    const before = ids(await live());
    assert.equal(before.length, 4);
    const report = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.result, s.reason]),
      [['tip', 'unchanged', 'same_content']],
    );
    assert.deepEqual(ids(await live()), before);
  });

  it('migrates a legacy layout: the r and d entries move into d bands, and the tip supersedes them', async () => {
    gridRecords();
    const legacy = { recentMaxBlocks: 100_000, startHeight: 0 };
    await ctx.service(legacy).runOnce();
    ctx.now += DAY;
    ctx.gw1.top = 115_200;
    await ctx.service(legacy).runOnce();
    const old = await deriveOwnBands(ctx.config().publishDir, PUBLISHER, {});
    assert.deepEqual(
      old.map((b) => [b.role, b.from, b.to]),
      [
        ['h', 0, 99_999],
        ['r', 100_000, 110_100],
        ['d', 109_589, null],
      ],
    );

    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.heightRange, s.result]),
      [
        ['freeze', [100_000, 104_999], 'published'],
        ['freeze', [105_000, 109_999], 'published'],
        ['freeze', [110_000, 114_999], 'published'],
        ['tip', [100_000, null], 'published'],
      ],
    );
    assert.deepEqual(
      report.steps.slice(0, 3).map((s) => s.seeds?.placed),
      // The d holds the r's entries above its start again.
      [300, 300, 2400],
      'the entries of the r and the d, each where its root is',
    );
    assert.deepEqual(
      report.steps[3].band?.supersedes.sort(),
      [old[1].id, old[2].id].sort(),
    );
    assert.deepEqual(
      (await live()).map((b) => [b.role, b.from, b.to]),
      [
        ['h', 0, 99_999],
        ['tip', 100_000, null],
        ['d', 100_000, 104_999],
        ['d', 105_000, 109_999],
        ['d', 110_000, 114_999],
      ],
    );
    await assertAllHeld(allIds());

    // The next run, the tip moves up over the new d bands.
    ctx.now += DAY;
    const next = await ctx.service(grid()).runOnce();
    assert.deepEqual(
      next.steps.map((s) => [s.grid, s.heightRange, s.result]),
      [['tip', [115_000, null], 'published']],
    );
    assert.equal(next.steps[0].seeds?.settled, 1800);
    await assertAllHeld(allIds());
  });

  describe('re-settle', () => {
    it('leaves a band whose entries are unchanged in place: same id, nothing published', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const before = ids(await live());
      const report = await ctx.service(grid()).runOnce({ resettle: true });
      assert.deepEqual(
        report.steps.map((s) => [s.grid, s.heightRange, s.result, s.reason]),
        [
          ['tip', [110_000, null], 'unchanged', 'same_content'],
          ['resettle', [0, 99_999], 'unchanged', 'same_content'],
          ['resettle', [100_000, 104_999], 'unchanged', 'same_content'],
          ['resettle', [105_000, 109_999], 'unchanged', 'same_content'],
        ],
      );
      assert.deepEqual(ids(await live()), before);
      const state = await ctx.exportState();
      assert.deepEqual(
        Object.keys(state.resettledAt ?? {}).sort(),
        before.filter((id) => !id.startsWith('tip-')).sort(),
      );
    });

    it('rebuilds a band that rows arrived for late, superseding it', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const old = await find('d-h105000-');
      // 40 items indexed late, at heights the d band froze without them.
      for (let i = 2300; i < 2340; i++)
        ctx.records[i] = record(i, 105_500 + (i % 40));
      ctx.now += DAY;
      const report = await ctx.service(grid()).runOnce({ resettle: true });
      const step = report.steps.find(
        (s) => s.grid === 'resettle' && s.heightRange[0] === 105_000,
      );
      assert.equal(step?.result, 'published');
      assert.deepEqual(
        { ...step?.resettle, header: undefined },
        {
          band: old.id,
          oldEntries: 300,
          newEntries: 340,
          added: 40,
          changed: 0,
          unchanged: 300,
          header: undefined,
        },
      );
      assert.deepEqual(step?.resettle?.header?.byTag['resettle-added'], {
        checked: 40,
        ok: 40,
        wrong: 0,
      });
      assert.deepEqual(step?.band?.supersedes, [old.id]);
      const now = await find('d-h105000-');
      assert.notEqual(now.id, old.id);
      const entries = await entryIds(now);
      for (const id of await entryIds(old)) assert.ok(entries.has(id));
      // The others unchanged, as before.
      assert.deepEqual(
        report.steps
          .filter((s) => s.grid === 'resettle' && s.heightRange[0] !== 105_000)
          .map((s) => s.result),
        ['unchanged', 'unchanged'],
      );
    });

    it('relocates entries an overlay gives another root, checking every one', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const old = await find('d-h105000-');
      const bundler = await overlay([800, 801, 802, 803, 804], (i) => ({
        root: rootAt(999_999),
        from: i,
      }));
      const report = await ctx
        .service(grid(), withOverlay(bundler))
        .runOnce({ resettle: true });
      const step = report.steps.find((s) => s.heightRange[0] === 105_000);
      assert.equal(step?.result, 'published');
      assert.equal(step?.resettle?.changed, 5);
      assert.equal(step?.resettle?.added, 0);
      assert.deepEqual(step?.resettle?.header?.byTag['resettle-changed'], {
        checked: 5,
        ok: 5,
        wrong: 0,
      });
      assert.ok(!ids(await live()).includes(old.id));
    });

    it('fails a band when a relocated entry has a wrong header, and keeps the old band', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const old = await find('d-h105000-');
      // The overlay gives five entries the offsets of other items.
      const bundler = await overlay([800, 801, 802, 803, 804], (i) => ({
        root: rootAt(ctx.records[i].height as number),
        from: i + 100,
      }));
      const report = await ctx
        .service(grid(), withOverlay(bundler))
        .runOnce({ resettle: true });
      const step = report.steps.find((s) => s.heightRange[0] === 105_000);
      assert.equal(step?.result, 'rejected');
      assert.equal(step?.reason, 'wrong_header');
      assert.equal(step?.resettle?.changed, 5);
      assert.equal(step?.resettle?.header?.byTag['resettle-changed'].wrong, 5);
      assert.equal((await find('d-h105000-')).id, old.id);
      assert.equal(runResult(report), 'rejected');
      const state = await ctx.exportState();
      assert.match(
        state.lastRejection?.reasons.join(' ') ?? '',
        /wrong_header/,
      );
      assert.ok(state.resettledAt?.[old.id] !== undefined, 'waits an interval');
    });

    it('fails a band that relocates more entries than the cap', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const old = await find('d-h105000-');
      const bundler = await overlay([800, 801, 802, 803, 804], (i) => ({
        root: rootAt(999_999),
        from: i,
      }));
      const report = await ctx
        .service(grid({ resettleMaxChanged: 4 }), withOverlay(bundler))
        .runOnce({ resettle: true });
      const step = report.steps.find((s) => s.heightRange[0] === 105_000);
      assert.equal(step?.result, 'rejected');
      assert.equal(step?.reason, 'too_many_changed');
      assert.match(
        step?.details?.[0] ?? '',
        /5 entries relocated, over .*\(4\)/,
      );
      assert.equal(step?.resettle?.header, undefined, 'nothing read');
      assert.equal((await find('d-h105000-')).id, old.id);
    });

    it('cannot check a band when a relocated entry cannot be read, however many others pass', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      const old = await find('d-h105000-');
      const moved = toB64Url(rootAt(999_999));
      const roots = ctx.roots;
      ctx.roots = () => {
        const { openRoot, close } = roots();
        return {
          openRoot: (rootTxId: string): ByteRangeSource =>
            rootTxId === moved
              ? ({
                  read: async () => {
                    throw new Error('Request failed with status code 504');
                  },
                  close: async () => undefined,
                } as unknown as ByteRangeSource)
              : openRoot(rootTxId),
          close,
        };
      };
      const bundler = await overlay([800], (i) => ({
        root: rootAt(999_999),
        from: i,
      }));
      const report = await ctx
        .service(grid(), withOverlay(bundler))
        .runOnce({ resettle: true });
      const step = report.steps.find((s) => s.heightRange[0] === 105_000);
      assert.equal(step?.result, 'couldnt_check');
      assert.equal(step?.reason, 'changed_unchecked');
      assert.equal((await find('d-h105000-')).id, old.id);
      const state = await ctx.exportState();
      assert.equal(
        state.resettledAt?.[old.id],
        undefined,
        'tried again next run',
      );
      assert.equal(state.retry?.attempts, 1);
    });

    it('waits while a build this run could not check', async () => {
      gridRecords();
      await ctx.service(grid()).runOnce();
      ctx.rootsFail = true;
      // New rows, so the tip changes and needs its check.
      for (let i = 2300; i < 2310; i++) ctx.records[i] = record(i, 110_150);
      ctx.gw1.top = 110_200;
      const report = await ctx.service(grid()).runOnce({ resettle: true });
      assert.deepEqual(
        report.steps.map((s) => [s.grid, s.result]),
        [['tip', 'couldnt_check']],
      );
      assert.deepEqual(
        report.plan
          ?.filter((p) => p.step === 'resettle')
          .map((p) => p.deferred),
        Array(3).fill('a build this run could not check'),
      );
    });

    it('runs when due by the interval, and not again until the next', async () => {
      gridRecords();
      const weekly = grid({ resettleIntervalMs: 7 * DAY });
      const first = await ctx.service(weekly).runOnce();
      assert.ok(
        first.steps.every((s) => s.grid !== 'resettle'),
        'just built',
      );
      ctx.now += 7 * DAY;
      const due = await ctx.service(weekly).runOnce();
      assert.deepEqual(
        due.steps.filter((s) => s.grid === 'resettle').map((s) => s.result),
        ['unchanged', 'unchanged', 'unchanged'],
      );
      ctx.now += DAY;
      const after = await ctx.service(weekly).runOnce();
      assert.ok(after.steps.every((s) => s.grid !== 'resettle'));
    });
  });
});
