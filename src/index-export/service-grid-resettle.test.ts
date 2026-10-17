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
import { runResult } from './service.js';

describe('ExportService, grid layout: re-settle', () => {
  const { ctx, grid, live, find, record, gridRecords, overlay, withOverlay } =
    useGridService();

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
      .runOnce({ resettle: 'gate' });
    const step = report.steps.find((s) => s.heightRange[0] === 105_000);
    assert.equal(step?.result, 'published');
    assert.equal(step?.resettle?.changed, 5);
    assert.equal(step?.resettle?.added, 0);
    // Every relocated entry, in its own stratum, and nothing else.
    assert.deepEqual(step?.resettle?.header?.byTag, {
      'resettle-changed': { checked: 5, ok: 5, wrong: 0 },
    });
    assert.ok(!ids(await live()).includes(old.id));
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
      .runOnce({ resettle: 'gate' });
    const step = report.steps.find((s) => s.heightRange[0] === 105_000);
    assert.equal(step?.result, 'rejected');
    assert.equal(step?.reason, 'wrong_header');
    assert.equal(step?.resettle?.changed, 5);
    assert.equal(step?.resettle?.header?.byTag['resettle-changed'].wrong, 5);
    assert.equal((await find('d-h105000-')).id, old.id);
    assert.equal(runResult(report), 'rejected');
    const state = await ctx.exportState();
    assert.match(state.lastRejection?.reasons.join(' ') ?? '', /wrong_header/);
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
      .runOnce({ resettle: 'gate' });
    const step = report.steps.find((s) => s.heightRange[0] === 105_000);
    assert.equal(step?.result, 'rejected');
    assert.equal(step?.reason, 'too_many_changed');
    assert.match(step?.details?.[0] ?? '', /5 entries relocated, over .*\(4\)/);
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
      .runOnce({ resettle: 'gate' });
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

  it('rejects, without a retry loop, a band whose relocated entry’s root is gone (404)', async () => {
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
                  throw Object.assign(
                    new Error('Request failed with status code 404'),
                    { response: { status: 404 } },
                  );
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
      .runOnce({ resettle: 'gate' });
    const step = report.steps.find((s) => s.heightRange[0] === 105_000);
    assert.equal(step?.result, 'rejected');
    assert.equal(step?.reason, 'relocation_root_gone');
    assert.match(step?.details?.join(' ') ?? '', /doesn't have \(404\)/);
    // Never published, and settled until the next interval: no retry.
    assert.equal((await find('d-h105000-')).id, old.id);
    const state = await ctx.exportState();
    assert.equal(state.retry, undefined);
    assert.ok(state.resettledAt?.[old.id] !== undefined);
    assert.match(
      state.lastRejection?.reasons.join(' ') ?? '',
      /relocation_root_gone/,
    );
  });

  it('re-settles only the bands inside a range, building nothing else', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    ctx.gw1.top = 115_200; // a d would freeze, and the tip move
    const report = await ctx.service(grid()).runOnce({
      resettle: 'full',
      range: [100_000, 109_999],
    });
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.heightRange[0], s.result]),
      [
        ['resettle', 100_000, 'unchanged'],
        ['resettle', 105_000, 'unchanged'],
      ],
    );
  });

  it('waits while a build this run could not check', async () => {
    gridRecords();
    await ctx.service(grid()).runOnce();
    ctx.rootsFail = true;
    // New rows, so the tip changes and needs its check.
    for (let i = 2300; i < 2310; i++) ctx.records[i] = record(i, 110_150);
    ctx.gw1.top = 110_200;
    const report = await ctx.service(grid()).runOnce({ resettle: 'gate' });
    assert.deepEqual(
      report.steps.map((s) => [s.grid, s.result]),
      [['tip', 'couldnt_check']],
    );
    assert.deepEqual(
      report.plan?.filter((p) => p.step === 'resettle').map((p) => p.deferred),
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
