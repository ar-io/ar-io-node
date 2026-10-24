/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  entryIds,
  ids,
  rootAt,
  useGridService,
} from '../../test/index-export-grid-fixture.js';
import { DAY } from '../../test/index-export-service-fixture.js';
import { ByteRangeSource } from '../lib/byte-range-source.js';
import { toB64Url } from '../lib/encoding.js';
import { BandRecord } from '../lib/index-band/build.js';
import type { StepOutcome } from './kinds/root-tx/kind.js';
import type {} from './kinds/root-tx/sources/rows.js';

// Relocations and the range a run re-settles are tested in
// service-grid-resettle-relocate.test.ts, split from here to keep each file
// well inside the test runner's per-file timeout on a slow runner.
describe('ExportService, grid layout: re-settle', () => {
  const { ctx, grid, live, find, record, gridRecords } = useGridService();

  /** 40 items indexed late, at heights d [105000, 109999] froze without. */
  const LATE = Array.from({ length: 40 }, (_, k) => 2300 + k);
  const lateHeight = (i: number) => 105_500 + (i % 40);
  const addLate = (
    change: (i: number, r: BandRecord) => BandRecord = (_, r) => r,
  ) => {
    for (const i of LATE) ctx.records[i] = change(i, record(i, lateHeight(i)));
  };
  /** Roots read like a 503 for these heights; the rest read as before. */
  const unreadable = (heights: (height: number) => boolean) => {
    const roots = new Set(
      Array.from({ length: 120_000 }, (_, h) => h)
        .filter(heights)
        .map((h) => toB64Url(rootAt(h))),
    );
    const before = ctx.roots;
    ctx.roots = () => {
      const { openRoot, close } = before();
      return {
        openRoot: (rootTxId: string): ByteRangeSource =>
          roots.has(rootTxId)
            ? ({
                read: async () => {
                  throw new Error('Request failed with status code 503');
                },
                close: async () => undefined,
              } as unknown as ByteRangeSource)
            : openRoot(rootTxId),
        close,
      };
    };
  };
  const step105 = (report: { steps: StepOutcome[] }) =>
    report.steps.find(
      (s) => s.grid === 'resettle' && s.heightRange[0] === 105_000,
    );

  it('leaves a band whose entries are unchanged in place: same id, nothing published', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const before = ids(await live());
    // Rebuilt in full, past the fingerprint gate.
    const report = await ctx.service(grid()).runOnce({ resettle: 'full' });
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.heightRange, s.result, s.reason]),
      [
        ['tip', [110_000, null], 'unchanged', 'same_content'],
        ['resettle', [0, 99_999], 'unchanged', 'same_content'],
        ['resettle', [100_000, 104_999], 'unchanged', 'same_content'],
        ['resettle', [105_000, 109_999], 'unchanged', 'same_content'],
      ],
    );
    assert.deepEqual(report.steps[1].gate, {
      verdict: 'same_sources',
      detail: 'rebuilt anyway: --resettle=full',
    });
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
    addLate();
    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
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
    // Only the delta: the band's 300 old entries are not read again.
    assert.deepEqual(step?.resettle?.header?.byTag, {
      'resettle-added': { checked: 40, ok: 40, wrong: 0 },
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

  it('checks only the delta, so roots of the entries it keeps that no longer read do not block it', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const old = await find('d-h105000-');
    addLate();
    // Every root of the band's 300 old entries is now unseeded.
    unreadable((h) => h >= 105_000 && h < 105_300);
    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    const step = step105(report);
    assert.equal(step?.result, 'published');
    assert.deepEqual(step?.resettle?.header, {
      checked: 40,
      ok: 40,
      wrong: 0,
      errors: 0,
      poolSize: 40,
      byTag: { 'resettle-added': { checked: 40, ok: 40, wrong: 0 } },
    });
    assert.notEqual((await find('d-h105000-')).id, old.id);
  });

  it('cannot check a band when too few of the added entries read', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const old = await find('d-h105000-');
    addLate();
    // 30 of the 40 added entries' roots fail to read: 25%, under 80%.
    unreadable((h) => h >= 105_500 && h < 105_530);
    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    const step = step105(report);
    assert.equal(step?.result, 'couldnt_check');
    assert.equal(step?.reason, 'gate');
    assert.match(step?.details?.[0] ?? '', /10 of 40 checked entries passed/);
    assert.equal((await find('d-h105000-')).id, old.id);
  });

  it('fails a band when an added entry has a wrong header', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const old = await find('d-h105000-');
    // Three of the 40 late rows carry another item's offsets.
    addLate((i, r) =>
      i < 2303
        ? {
            ...r,
            rootOffset: ctx.items[i + 100].rootDataItemOffset,
            rootDataOffset: ctx.items[i + 100].rootDataOffset,
          }
        : r,
    );
    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    const step = step105(report);
    assert.equal(step?.result, 'rejected');
    assert.equal(step?.reason, 'wrong_header');
    assert.deepEqual(step?.resettle?.header?.byTag['resettle-added'], {
      checked: 40,
      ok: 37,
      wrong: 3,
    });
    assert.equal((await find('d-h105000-')).id, old.id);
  });

  it('publishes entries added without offsets, which no check can read', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    const old = await find('d-h105000-');
    addLate((_, { rootOffset, rootDataOffset, size, ...rootOnly }) => rootOnly);
    ctx.now += DAY;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    const step = step105(report);
    assert.equal(step?.result, 'published');
    assert.equal(step?.resettle?.added, 40);
    assert.equal(step?.resettle?.header, undefined, 'nothing to read');
    assert.notEqual((await find('d-h105000-')).id, old.id);
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
