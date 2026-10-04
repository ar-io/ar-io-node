/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { toB64Url } from '../lib/encoding.js';
import { bandPublisherTag } from '../lib/index-band/build.js';
import {
  assertCovered,
  DAY,
  MemorySource,
  PUBLISHER,
  useExportService,
} from '../../test/index-export-service-fixture.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import { ExportLock } from './lock.js';
import { reportForOutput, RETRY_FIRST_MS, runResult } from './service.js';
import { updateIndexState } from './state.js';

describe('ExportService', () => {
  const ctx = useExportService();

  it('bootstraps h and r at fixed edges up to the stable top, and records success', async () => {
    const report = await ctx.service().runOnce();
    assert.deepEqual(
      report.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [1000, 1999], 'published'],
        ['r', [2000, 2600], 'published'],
      ],
    );
    assert.equal(runResult(report), 'published');
    const bands = await ctx.live();
    assert.deepEqual(
      bands.map((b) => b.role),
      ['h', 'r'],
    );
    assertCovered(bands, 1000, 2600);
    const state = await ctx.exportState();
    assert.deepEqual(Object.keys(state.lastSuccess).sort(), ['h', 'r']);
    assert.equal(state.lastFoldAt, report.at, 'the new r counts as a fold');
    assert.equal(state.lastRun?.outcome, 'published');
    assert.equal(state.retry, undefined);
    assert.deepEqual(await fs.readdir(path.join(ctx.dir, 'export')), [
      'state.json',
    ]);
  });

  it('rejects a band whose sources conflict on more than 1% of it', async () => {
    await ctx.service().runOnce();
    ctx.now += DAY;
    ctx.gw1.top = 2650;
    // A second indexer giving 100 of the delta's items other offsets.
    const gw2 = new MemorySource('gw2', () =>
      ctx.records.slice(2200, 2300).map((r, i) => ({
        ...r,
        rootOffset: ctx.records[2300 + i].rootOffset,
        rootDataOffset: ctx.records[2300 + i].rootDataOffset,
      })),
    );
    gw2.top = 2650;
    const report = await ctx
      .service({}, () => [
        { source: ctx.gw1, optional: false },
        { source: gw2, optional: false },
      ])
      .runOnce();
    assert.equal(report.steps[0].result, 'rejected');
    assert.equal(report.steps[0].reason, 'conflicts');
    assert.match(report.steps[0].details?.[0] ?? '', /100 conflicting IDs/);
  });

  it('rejects a band with no offsets to check, rather than retry it forever', async () => {
    ctx.records = ctx.records.map(
      ({ rootOffset, rootDataOffset, size, ...rest }) => rest,
    );
    const report = await ctx.service().runOnce();
    assert.equal(report.steps[0].result, 'rejected');
    assert.equal(report.steps[0].reason, 'no_offsets');
    assert.equal((await ctx.exportState()).retry, undefined);
  });

  it('runs a dry run beside a run that holds the lock', async () => {
    await fs.mkdir(path.join(ctx.dir, 'export'), { recursive: true });
    const held = await ExportLock.acquire(path.join(ctx.dir, 'export', 'lock'));
    assert.ok(held.acquired);
    try {
      const report = await ctx.service().runOnce({ dryRun: true });
      assert.equal(report.locked, undefined);
      assert.ok(report.steps.length > 0);
    } finally {
      await held.lock.release();
    }
  });

  it('builds and checks on a dry run, but publishes, locks and saves nothing', async () => {
    const report = await ctx.service().runOnce({ dryRun: true });
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
    assert.deepEqual(await ctx.live(), []);
    assert.deepEqual(await fs.readdir(path.join(ctx.dir, 'export')), [
      'dry-run',
    ]);
    assert.deepEqual(
      await fs.readdir(path.join(ctx.dir, 'export', 'dry-run')),
      [],
      'no staging left',
    );
  });

  it('keeps a dry run’s bands at a fixed height for comparing', async () => {
    const keep = path.join(ctx.dir, 'export', 'compare');
    const report = await ctx
      .service()
      .runOnce({ keepDir: keep, toHeight: 2300 });
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
    assert.deepEqual(
      await ctx.live(),
      [],
      'nothing in the real publish directory',
    );
    await assert.rejects(fs.stat(path.join(ctx.dir, 'export', 'state.json')));
  });

  it('rejects a band with a wrong header, keeps what is published, and does not retry', async () => {
    await ctx.service().runOnce();
    const before = await ctx.live();
    ctx.now += DAY;
    ctx.gw1.top = 2650;
    // A source now gives a third of the delta's items another item's
    // offsets, so any sample holds some.
    for (let i = 2200; i < 2600; i++) {
      ctx.records[i] = {
        ...ctx.records[i],
        rootOffset: ctx.records[i + 1].rootOffset,
        rootDataOffset: ctx.records[i + 1].rootDataOffset,
      };
    }
    const report = await ctx.service().runOnce();
    assert.equal(runResult(report), 'rejected');
    assert.equal(report.steps[0].reason, 'wrong_header');
    const state = await ctx.exportState();
    assert.equal(state.retry, undefined);
    assert.match(state.lastRejection?.reasons.join(' ') ?? '', /wrong_header/);
    assert.deepEqual(
      (await ctx.live()).map((b) => b.id),
      before.map((b) => b.id),
    );
  });

  it('retries a run that could not check, backing off, and clears on success', async () => {
    ctx.rootsFail = true;
    const first = await ctx.service().runOnce();
    assert.equal(runResult(first), 'couldnt_check');
    assert.equal(first.steps[0].reason, 'gate');
    let state = await ctx.exportState();
    assert.equal(state.retry?.attempts, 1);
    assert.equal(Date.parse(state.retry?.at ?? ''), ctx.now + RETRY_FIRST_MS);
    assert.equal(await ctx.service().nextRunAt(), ctx.now + RETRY_FIRST_MS);
    assert.deepEqual(await ctx.live(), [], 'nothing published or withdrawn');

    ctx.now += RETRY_FIRST_MS;
    await ctx.service().runOnce();
    state = await ctx.exportState();
    assert.equal(state.retry?.attempts, 2);
    assert.equal(
      Date.parse(state.retry?.at ?? ''),
      ctx.now + 2 * RETRY_FIRST_MS,
    );

    ctx.rootsFail = false;
    ctx.now += 2 * RETRY_FIRST_MS;
    await ctx.service().runOnce();
    state = await ctx.exportState();
    assert.equal(state.retry, undefined);
  });

  it('fails a run whose required source is down, and leaves an optional one out', async () => {
    ctx.gw1.fail = 'connection refused';
    const down = await ctx.service().runOnce();
    assert.equal(down.failed?.reason, 'source');
    assert.match(down.failed?.message ?? '', /connection refused/);

    const gw2 = new MemorySource('gw2', () => []);
    gw2.fail = 'peer down';
    ctx.gw1.fail = undefined;
    const report = await ctx
      .service({}, () => [
        { source: ctx.gw1, optional: false },
        { source: gw2, optional: true },
      ])
      .runOnce();
    assert.equal(runResult(report), 'published');
  });

  /** A stranger's band in the publish directory. */
  async function foreignBand(name: string, from: number) {
    const dir = path.join(ctx.config().publishDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
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
        metadata: { heightRange: [from, null] },
      }),
    );
  }

  it("refuses a resumed bootstrap over a stranger's band, keeping its own", async () => {
    // A bootstrap that got as far as history, with no recent band yet.
    ctx.gw1.top = 1999;
    await ctx.service().runOnce();
    const mine = await ctx.live();
    assert.deepEqual(
      mine.map((b) => [b.role, b.from, b.to]),
      [['h', 1000, 1999]],
      'history published, no recent band: a bootstrap is still due',
    );

    // A stranger's band appears before the bootstrap resumes.
    await foreignBand('b1-h1950000-tip-turbo', 1_950_000);
    // Far enough for another whole recent span: a bootstrap is planned again.
    ctx.gw1.top = 3200;
    const report = await ctx.service().runOnce();

    assert.equal(report.failed?.reason, 'foreign_bands');
    assert.match(report.failed?.message ?? '', /b1-h1950000-tip-turbo/);
    // Its own band is not mistaken for the stranger's.
    assert.doesNotMatch(report.failed?.message ?? '', /f5b1208c/);
  });

  it("does not read its own superseded band as a stranger's", async () => {
    // A bootstrap that got as far as history, with no recent band yet.
    ctx.gw1.top = 1999;
    await ctx.service().runOnce();

    // A band of its own that is no longer live: superseded, or its manifest
    // from an older format. Either way it is not in the live set, and it
    // sits on disk until the sidecar sweeps it.
    const tag = bandPublisherTag(PUBLISHER);
    const mine = path.join(
      ctx.config().publishDir,
      `d-h2089-tip-${tag}-aaaaaaaaaaaa`,
    );
    await fs.mkdir(mine, { recursive: true });
    await fs.writeFile(
      path.join(mine, 'manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: '2026-10-01T00:00:00Z',
        totalRecords: 1,
        partitions: [],
        metadata: {},
      }),
    );
    assert.equal(
      (await ctx.live()).some((b) => b.id.endsWith('aaaaaaaaaaaa')),
      false,
      'not in the live set',
    );

    ctx.gw1.top = 3200;
    const report = await ctx.service().runOnce();
    assert.equal(report.failed, undefined, 'its own band did not refuse it');
  });

  it('scans for strangers only when a bootstrap is planned', async () => {
    // Steady state: bands of its own, nothing to bootstrap.
    await ctx.service().runOnce();
    assert.ok((await ctx.live()).length > 0);
    // A band superseded moments ago is still on disk and is not "own"; a
    // steady-state run must not read it as a stranger's.
    await foreignBand('d-h2089-tip-f5b1208c-superseded', 2089);
    ctx.now += DAY;
    ctx.gw1.top = 2650;
    const report = await ctx.service().runOnce();
    assert.equal(report.failed, undefined, 'the run was not refused');
  });

  it('refuses to bootstrap over bands it did not build', async () => {
    const foreign = path.join(ctx.config().publishDir, 'b1-h1950000-tip-turbo');
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
    const report = await ctx.service().runOnce();
    assert.equal(report.failed?.reason, 'foreign_bands');
    assert.match(report.failed?.message ?? '', /adopt them first/);
    assert.equal(runResult(report), 'rejected');
    assert.deepEqual(report.steps, []);
    const state = await ctx.exportState();
    assert.equal(state.retry, undefined);
    assert.deepEqual(state.lastRejection?.reasons[0], 'foreign_bands');
  });

  it('rejects a band whose every record was invalid, but skips a range with no data', async () => {
    // Offsets that frame no header: the band library drops them all.
    ctx.records = ctx.records.map((r) => ({
      ...r,
      rootDataOffset: r.rootOffset,
    }));
    const report = await ctx.service().runOnce();
    assert.equal(report.steps[0].role, 'h');
    assert.equal(report.steps[0].result, 'rejected');
    assert.equal(report.steps[0].reason, 'build');
    // A range nobody indexed is nothing to cover.
    ctx.records = [];
    const empty = await ctx
      .service({ startHeight: 0 })
      .runOnce({ dryRun: true });
    assert.equal(empty.steps[0].result, 'skipped');
    assert.equal(empty.steps[0].reason, 'empty');
  });

  it('takes a peer’s exported files as a peer: capping the stable top and merging', async () => {
    const files = path.join(ctx.dir, 'gw2-files');
    await fs.mkdir(files);
    // gw2 exported up to 2500 only, and agrees with gw1 on what it has.
    await fs.writeFile(
      path.join(files, '1000-2500.csv'),
      ctx.records
        .filter((r) => (r.height ?? 0) <= 2500)
        .map(
          (r) =>
            `${toB64Url(r.id)},${toB64Url(r.rootTxId)},,${r.rootOffset},${r.rootDataOffset},${r.size},${r.height}`,
        )
        .join('\n') + '\n',
    );
    const report = await ctx
      .service({}, () => [
        { source: ctx.gw1, optional: false },
        {
          source: new CsvOverlaySource('gw2-files', files, 0),
          optional: false,
        },
      ])
      .runOnce();
    assert.equal(report.stableTop, 2500, 'the lower peer caps the run');
    assert.deepEqual(
      report.steps.map((s) => [s.role, s.heightRange, s.result]),
      [
        ['h', [1000, 1999], 'published'],
        ['r', [2000, 2500], 'published'],
      ],
    );
    assert.equal(report.steps[0].band?.conflicts, 0);
    assert.ok((report.steps[0].inputs['gw2-files'] ?? 0) > 0);
  });

  it('publishes a small history band rather than leave its heights uncovered', async () => {
    ctx.records = ctx.records.filter((_, i) => i >= 1100 || i % 10 === 0);
    const report = await ctx.service().runOnce();
    assert.equal(report.steps[0].role, 'h');
    assert.equal(report.steps[0].result, 'published');
    assert.ok((report.steps[0].band?.records ?? 0) < 1000);
  });

  it('refuses a step without room on the disk', async () => {
    ctx.freeBytes = 5 * 1024 ** 3;
    const report = await ctx.service().runOnce();
    assert.equal(report.failed?.reason, 'disk');
    assert.match(report.failed?.message ?? '', /margin/);
    assert.equal(runResult(report), 'couldnt_check');
  });

  it('does not run while another holds a fresh lock', async () => {
    await fs.mkdir(path.join(ctx.dir, 'export'), { recursive: true });
    const held = await ExportLock.acquire(path.join(ctx.dir, 'export', 'lock'));
    assert.ok(held.acquired);
    const report = await ctx.service().runOnce();
    assert.equal(runResult(report), 'locked');
    assert.deepEqual(report.steps, []);
    await held.lock.release();
  });

  it('recovers its bands from disk when state.json is lost', async () => {
    await ctx.service().runOnce();
    await fs.rm(path.join(ctx.dir, 'export', 'state.json'));
    ctx.now += DAY;
    const report = await ctx.service().runOnce();
    assert.ok(
      report.steps.every((s) => s.role !== 'h'),
      'no second bootstrap',
    );
  });

  it('reports alive from its heartbeat, whatever its runs do', async () => {
    ctx.rootsFail = true;
    const svc = ctx.service();
    svc.start();
    try {
      assert.equal(svc.alive(), true);
      ctx.now += 6 * 60_000;
      assert.equal(svc.alive(), false, 'no tick for six minutes');
    } finally {
      await svc.stop(0);
    }
  });

  it('schedules the daily run, a missed day soon, and a run that died soon', async () => {
    const svc = ctx.service();
    // Never run: soon.
    assert.equal(await svc.nextRunAt(), ctx.now + 5 * 60_000);
    await svc.runOnce();
    // Ran today at 04:00: tomorrow at 04:00.
    assert.equal(await svc.nextRunAt(), Date.parse('2026-10-03T04:00:00Z'));
    // A run that died part way (its outcome still "running"): soon.
    await updateIndexState(
      path.join(ctx.dir, 'export', 'state.json'),
      'root-tx-index',
      (state) => {
        state.lastRun = {
          at: new Date(ctx.now).toISOString(),
          outcome: 'running',
        };
      },
    );
    assert.equal(await svc.nextRunAt(), ctx.now + 5 * 60_000);
  });
});
