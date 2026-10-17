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
  ids,
  log,
  useGridService,
} from '../../test/index-export-grid-fixture.js';
import {
  MemorySource,
  PUBLISHER,
} from '../../test/index-export-service-fixture.js';
import { toB64Url } from '../lib/encoding.js';
import { buildBand } from '../lib/index-band/build.js';
import type { StepOutcome } from './kinds/root-tx/kind.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import type { RecordSource } from './kinds/root-tx/sources/rows.js';

describe('ExportService, grid layout: re-settle fingerprint gate', () => {
  const { ctx, grid, live, find, record, gridRecords } = useGridService();

  /** A source that counts its reads and fingerprints without reading. */
  class CountingSource extends MemorySource {
    readonly reads: Array<[number, number]> = [];
    identity = 'memory';

    async *records(from: number, to: number) {
      this.reads.push([from, to]);
      yield* super.records(from, to);
    }

    /** Like ClickHouse's: a digest of the rows, without giving them. */
    async fingerprint(from: number, to: number) {
      const hash = crypto.createHash('sha256');
      for (const r of ctx.records) {
        const height = r.height ?? 0;
        if (height < from || height > to || height > this.top) continue;
        hash.update(
          `${toB64Url(r.id)} ${toB64Url(r.rootTxId)} ${height} ${r.rootOffset} ${r.rootDataOffset} ${r.size}\n`,
        );
      }
      return hash.digest('hex');
    }
  }
  const counting = (name = 'gw1') => {
    const source = new CountingSource(name, () => ctx.records);
    source.top = ctx.gw1.top;
    return source;
  };
  const only =
    (source: RecordSource, optional = false) =>
    () => [{ source, optional }];
  const resettles = (report: { steps: StepOutcome[] }) =>
    report.steps
      .filter((s) => s.grid === 'resettle')
      .map((s) => [s.heightRange[0], s.result, s.reason, s.gate?.verdict]);
  const readsIn = (source: CountingSource, from: number, to: number) =>
    source.reads.filter(([a, b]) => a <= to && b >= from);

  it('does not rebuild a band whose sources are unchanged', async () => {
    gridRecords();
    await ctx.service(grid(), only(counting())).runOnce();
    const before = ids(await live());
    const gw1 = counting();
    const report = await ctx
      .service(grid(), only(gw1))
      .runOnce({ resettle: 'gate' });
    assert.deepEqual(resettles(report), [
      [0, 'unchanged', 'same_sources', 'same_sources'],
      [100_000, 'unchanged', 'same_sources', 'same_sources'],
      [105_000, 'unchanged', 'same_sources', 'same_sources'],
    ]);
    // Nothing built: no band, and the sources never read for it.
    for (const step of report.steps.filter((s) => s.grid === 'resettle')) {
      assert.equal(step.band, undefined);
      assert.deepEqual(step.inputs, {});
    }
    assert.deepEqual(readsIn(gw1, 0, 109_999), []);
    assert.deepEqual(ids(await live()), before);
    const state = await ctx.exportState();
    assert.equal(Object.keys(state.resettledAt ?? {}).length, 3);
    assert.equal(Object.keys(state.fingerprints ?? {}).length, 3);
  });

  it('rebuilds a band when one row is added to its source', async () => {
    gridRecords();
    await ctx.service(grid(), only(counting())).runOnce();
    const old = await find('d-h100000-');
    ctx.records[2300] = record(2300, 100_777);
    const gw1 = counting();
    const report = await ctx
      .service(grid(), only(gw1))
      .runOnce({ resettle: 'gate' });
    assert.deepEqual(resettles(report), [
      [0, 'unchanged', 'same_sources', 'same_sources'],
      [100_000, 'published', 'new', 'changed'],
      [105_000, 'unchanged', 'same_sources', 'same_sources'],
    ]);
    assert.deepEqual(readsIn(gw1, 100_000, 104_999), [[100_000, 104_999]]);
    const now = await find('d-h100000-');
    assert.notEqual(now.id, old.id);
    // Recorded for the new band, which next time is left alone.
    const again = await ctx
      .service(grid(), only(counting()))
      .runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(again).map(([, result, reason]) => [result, reason]),
      Array(3).fill(['unchanged', 'same_sources']),
    );
  });

  it('rebuilds a band when an overlay file covering it changes', async () => {
    gridRecords();
    const dir = path.join(ctx.dir, 'overlay');
    await fs.mkdir(dir);
    const file = path.join(dir, '105000-109999.csv');
    const line = (i: number) => {
      const r = ctx.records[i];
      const item = ctx.items[i];
      return `${toB64Url(r.id)},${toB64Url(r.rootTxId)},,${item.rootDataItemOffset},${item.rootDataOffset},${item.dataItemSize},${r.height}\n`;
    };
    await fs.writeFile(file, line(800));
    const sources = () => [
      { source: ctx.gw1, optional: false },
      { source: new CsvOverlaySource('bundler', dir), optional: false },
    ];
    await ctx.service(grid(), sources).runOnce();
    const same = await ctx.service(grid(), sources).runOnce({
      resettle: 'gate',
    });
    assert.deepEqual(
      resettles(same).map(([, , reason]) => reason),
      Array(3).fill('same_sources'),
    );
    // The same rows written again, plus one: another file.
    await fs.writeFile(file, line(800) + line(801));
    const report = await ctx.service(grid(), sources).runOnce({
      resettle: 'gate',
    });
    assert.deepEqual(resettles(report), [
      [0, 'unchanged', 'same_sources', 'same_sources'],
      [100_000, 'unchanged', 'same_sources', 'same_sources'],
      [105_000, 'unchanged', 'same_content', 'changed'],
    ]);
    assert.match(
      report.steps.find((s) => s.heightRange[0] === 105_000)?.gate?.detail ??
        '',
      /bundler changed/,
    );
  });

  it('rebuilds once a band with no fingerprint, then records one', async () => {
    gridRecords();
    // Built by hand, as index-band-build does: nothing recorded.
    for (const [kind, from, to] of [
      ['h', 0, 99_999],
      ['d', 100_000, 104_999],
    ] as const) {
      await buildBand({
        log,
        records: ctx.records.filter(
          (r) => (r.height ?? 0) >= from && (r.height ?? 0) <= to,
        ),
        publishDir: ctx.config().publishDir,
        workDir: path.join(ctx.dir, 'scratch'),
        publisher: PUBLISHER,
        kind,
        heightRange: [from, to],
      });
    }
    const first = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(first).filter(([from]) => (from as number) < 105_000),
      [
        [0, 'unchanged', 'same_content', 'unrecorded'],
        [100_000, 'unchanged', 'same_content', 'unrecorded'],
      ],
    );
    const second = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(second).map(([, , reason]) => reason),
      ['same_sources', 'same_sources', 'same_sources'],
    );
  });

  it('rebuilds a band when a source is renamed or pointed elsewhere', async () => {
    gridRecords();
    await ctx.service(grid(), only(counting())).runOnce();
    const renamed = await ctx
      .service(grid(), only(counting('gw1-new')))
      .runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(renamed).map(([, , , verdict]) => verdict),
      ['changed', 'changed', 'changed'],
    );
    assert.match(
      renamed.steps.find((s) => s.grid === 'resettle')?.gate?.detail ?? '',
      /gw1-new is new; gw1 is no longer a source/,
    );
    const moved = counting('gw1-new');
    moved.identity = 'memory elsewhere';
    const elsewhere = await ctx
      .service(grid(), only(moved))
      .runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(elsewhere).map(([, , , verdict]) => verdict),
      ['changed', 'changed', 'changed'],
    );
  });

  it('waits, rebuilding nothing, while only a source that is down differs', async () => {
    gridRecords();
    const gw2 = counting('gw2');
    const both = () => [
      { source: ctx.gw1, optional: false },
      { source: gw2, optional: true },
    ];
    await ctx.service(grid(), both).runOnce();
    gw2.fail = 'connection refused';
    const report = await ctx.service(grid(), both).runOnce({
      resettle: 'gate',
    });
    assert.deepEqual(
      resettles(report).map(([, result, reason]) => [result, reason]),
      Array(3).fill(['skipped', 'source_down']),
    );
    // Not settled: due again with the next run.
    assert.equal((await ctx.exportState()).resettledAt, undefined);
  });

  it('keeps the fingerprint of a band published before a run stopped part way', async () => {
    gridRecords();
    // Room for the first band only: the run stops at the second.
    let asked = 0;
    Object.defineProperty(ctx, 'freeBytes', {
      configurable: true,
      get: () => (asked++ < 1 ? 1e13 : 0),
    });
    try {
      const report = await ctx.service(grid()).runOnce();
      assert.equal(report.failed?.reason, 'disk');
      assert.deepEqual(
        report.steps.map((s) => [s.heightRange[0], s.result]),
        [[0, 'published']],
      );
    } finally {
      Object.defineProperty(ctx, 'freeBytes', {
        configurable: true,
        writable: true,
        value: 1e13,
      });
    }
    const h = await find('h-h0-');
    const state = await ctx.exportState();
    assert.deepEqual(Object.keys(state.fingerprints ?? {}), [h.id]);
  });

  it('takes a rolled h band’s fingerprint from its d bands', async () => {
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
    await ctx.service(grid()).runOnce();
    ctx.gw1.top = 200_100;
    const rolled = await ctx.service(grid()).runOnce();
    const h = rolled.steps.find((s) => s.grid === 'roll');
    assert.equal(h?.result, 'published');
    const state = await ctx.exportState();
    assert.equal(
      Object.keys(
        state.fingerprints?.[h?.band?.id ?? '']?.sources.gw1?.ranges ?? {},
      ).length,
      20,
    );
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    assert.deepEqual(
      resettles(report).find(([from]) => from === 100_000),
      [100_000, 'unchanged', 'same_sources', 'same_sources'],
    );
  });
});
