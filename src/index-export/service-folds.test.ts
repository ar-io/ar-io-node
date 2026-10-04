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

import {
  assertCovered,
  DAY,
  useExportService,
} from '../../test/index-export-service-fixture.js';
import { CsvOverlaySource } from './kinds/root-tx/sources/csv.js';
import { RETRY_FIRST_MS } from './service.js';
import { OwnBand, updateIndexState } from './state.js';

describe('ExportService folds and the recent band', () => {
  const ctx = useExportService();

  it('builds a daily delta above the r, then skips it while unchanged, despite a new id', async () => {
    await ctx.service().runOnce();
    ctx.now += DAY;
    ctx.gw1.top = 2650;
    const second = await ctx.service().runOnce();
    assert.deepEqual(
      second.steps.map((s) => [s.role, s.heightRange, s.result]),
      [['d', [2089, null], 'published']],
    );
    const delta = (await ctx.live()).find((b) => b.role === 'd');
    assertCovered(await ctx.live(), 1000, 2650);
    ctx.now += DAY;
    const third = await ctx.service().runOnce();
    assert.deepEqual(
      third.steps.map((s) => [s.role, s.result, s.reason]),
      [['d', 'unchanged', 'same_content']],
    );
    assert.equal((await ctx.live()).find((b) => b.role === 'd')?.id, delta?.id);
  });

  it('folds weekly with the delta held at its start, so no installation order leaves a gap', async () => {
    await ctx.service().runOnce();
    ctx.now += DAY;
    ctx.gw1.top = 2650;
    await ctx.service().runOnce();
    const first = await ctx.live();
    const oldR = first.find((b) => b.role === 'r');
    const oldD = first.find((b) => b.role === 'd');
    // A week on, the sources reach higher: the last 1,100 items move up.
    ctx.now += 7 * DAY;
    for (const record of ctx.records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    ctx.gw1.top = 3200;
    const report = await ctx.service().runOnce();
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
    const newR = (await ctx.live()).find((b) => b.role === 'r') as OwnBand;
    const newD = (await ctx.live()).find((b) => b.role === 'd') as OwnBand;
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
    ctx.now += DAY;
    const next = await ctx.service().runOnce();
    assert.deepEqual(
      next.steps.map((s) => [s.role, s.heightRange]),
      [['d', [2488, null]]],
    );
    assert.equal(next.steps[0].result, 'published');
    assert.ok(next.steps[0].band?.supersedes.includes(oldD?.id as string));
    assertCovered(await ctx.live(), 1000, 3200);
  });

  it('names earlier superseded deltas too, for a subscriber that missed one', async () => {
    const all = ctx.records;
    const without = (from: number, to: number) =>
      all.filter((_, i) => i < from || i >= to);
    await ctx.service().runOnce();
    ctx.gw1.top = 2650;
    // Three days, three different deltas.
    ctx.records = without(3200, 3300);
    ctx.now += DAY;
    const first = (await ctx.service().runOnce()).steps[0];
    ctx.records = all;
    ctx.now += DAY;
    const second = (await ctx.service().runOnce()).steps[0];
    ctx.records = without(3100, 3200);
    ctx.now += DAY;
    const third = (await ctx.service().runOnce()).steps[0];
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

  it('waits for an operator after a rejected fold, then folds on a forced run', async () => {
    await ctx.service().runOnce();
    ctx.now += 8 * DAY;
    ctx.gw1.top = 3200;
    for (const record of ctx.records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    // The fold reads 2089 and up: corrupt a third of those rows.
    const good = ctx.records.map((r) => ({ ...r }));
    for (let i = 2200; i < 2600; i++) {
      ctx.records[i] = {
        ...ctx.records[i],
        rootOffset: ctx.records[i + 1].rootOffset,
        rootDataOffset: ctx.records[i + 1].rootDataOffset,
      };
    }
    const rejected = await ctx.service().runOnce();
    assert.equal(rejected.steps[0].role, 'r');
    assert.equal(rejected.steps[0].result, 'rejected');
    ctx.records = good;
    ctx.now += DAY;
    const daily = await ctx.service().runOnce();
    assert.ok(
      daily.steps.every((s) => s.role !== 'r'),
      'no fold until an operator runs one',
    );
    const forced = await ctx.service().runOnce({ force: true });
    assert.equal(forced.steps[0].role, 'r');
    assert.equal(forced.steps[0].result, 'published');
    assert.equal((await ctx.exportState()).foldRejectedAt, undefined);
  });

  it('does not fold twice in a week when a crash lost the state after a fold', async () => {
    await ctx.service().runOnce();
    await fs.rm(path.join(ctx.dir, 'export', 'state.json'));
    ctx.now += DAY;
    ctx.gw1.top = 2700;
    const report = await ctx.service().runOnce();
    assert.ok(
      report.steps.every((s) => s.role === 'd'),
      'the r manifest dates the last fold',
    );
  });

  it('resumes an interrupted bootstrap above the history it published', async () => {
    ctx.rootsFail = true;
    const svc = ctx.service({ startHeight: 0 });
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
    ctx.rootsFail = false;
    ctx.now += RETRY_FIRST_MS;
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

  it('starts a new recent chain after a freeze, naming none of the old one', async () => {
    // r [2000, 2600], folded to [2000, 2999], which freezes it.
    await ctx.service().runOnce();
    ctx.now += 8 * DAY;
    for (const record of ctx.records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    ctx.gw1.top = 3200;
    const freeze = await ctx.service().runOnce();
    assert.equal(freeze.steps[0].role, 'r');
    assert.deepEqual(freeze.steps[0].heightRange, [2000, 2999]);
    const frozenId = freeze.steps[0].band?.id;
    assert.deepEqual(
      (await ctx.exportState()).supersededHistory?.r,
      [],
      'a freeze ends the r chain',
    );
    // Even with history present, a new r above a frozen one names none of it.
    await updateIndexState(
      path.join(ctx.dir, 'export', 'state.json'),
      'root-tx-index',
      (state) => {
        state.supersededHistory = { ...state.supersededHistory, r: ['r-old'] };
      },
    );
    // A week on, a new r starts above the frozen one: it supersedes
    // nothing, not the chain the frozen band ended.
    ctx.now += 8 * DAY;
    const next = await ctx.service().runOnce();
    const fresh = next.steps.find((s) => s.role === 'r');
    assert.deepEqual(fresh?.heightRange, [3000, 3200]);
    assert.deepEqual(fresh?.band?.supersedes, []);
    assert.ok((await ctx.live()).some((b) => b.id === frozenId));
  });

  it('prunes overlay files a frozen band holds, a fold after it froze', async () => {
    const overlay = path.join(ctx.dir, 'overlay');
    await fs.mkdir(overlay);
    // A peer's exported files: never pruned by this service.
    const peerFiles = path.join(ctx.dir, 'gw2-files');
    await fs.mkdir(peerFiles);
    await fs.writeFile(path.join(peerFiles, '2000-2400.csv'), '');
    await fs.writeFile(path.join(peerFiles, '2401-3300.csv'), '');
    const sources = () => [
      { source: ctx.gw1, optional: false },
      { source: new CsvOverlaySource('bundler', overlay), optional: false },
      { source: new CsvOverlaySource('gw2', peerFiles, 0), optional: false },
    ];
    await ctx.service({}, sources).runOnce();
    // Files written before the freeze: one wholly below the frozen top less
    // the overlap, one reaching into it.
    await fs.writeFile(path.join(overlay, '2000-2400.csv'), '');
    await fs.writeFile(path.join(overlay, '2600-2700.csv'), '');
    // The service's clock, not the real one: the prune compares these file
    // times against the frozen band's createdAt, which the service dates.
    const old = new Date(ctx.now - 3600_000);
    for (const name of ['2000-2400.csv', '2600-2700.csv']) {
      await fs.utimes(path.join(overlay, name), old, old);
    }
    await fs.utimes(path.join(peerFiles, '2000-2400.csv'), old, old);
    ctx.now += 8 * DAY;
    for (const record of ctx.records.slice(2200)) {
      record.height = (record.height ?? 0) + 500;
    }
    ctx.gw1.top = 3200;
    const freeze = await ctx.service({}, sources).runOnce();
    assert.deepEqual(freeze.steps[0].heightRange, [2000, 2999]);
    // Date the frozen band by the service's clock.
    const frozen = (await ctx.live()).find((b) => b.role === 'r') as OwnBand;
    const manifestPath = path.join(frozen.dir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.createdAt = new Date(ctx.now).toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    ctx.now += DAY;
    await ctx.service({}, sources).runOnce();
    assert.equal(
      (await fs.readdir(overlay)).length,
      2,
      'too soon after the freeze',
    );

    ctx.now += 7 * DAY;
    await ctx.service({}, sources).runOnce();
    assert.deepEqual(await fs.readdir(overlay), ['2600-2700.csv']);
    assert.equal((await fs.readdir(peerFiles)).length, 2, 'peer files kept');
  });
});
