/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ids,
  rootAt,
  useGridService,
} from '../../test/index-export-grid-fixture.js';
import { ByteRangeSource } from '../lib/byte-range-source.js';
import { toB64Url } from '../lib/encoding.js';
import type {} from './kinds/root-tx/kind.js';
import type {} from './kinds/root-tx/sources/rows.js';
import { runResult } from './service.js';

// The re-settle tests that relocate entries through an overlay, and those
// that bound which bands a run re-settles. Split from
// service-grid-resettle.test.ts so that neither file comes near the test
// runner's 120 s per-file timeout on a slow runner: each test builds the
// whole grid before it re-settles.
describe('ExportService, grid layout: re-settle, relocations and scope', () => {
  const { ctx, grid, live, find, record, gridRecords, overlay, withOverlay } =
    useGridService();

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
});
