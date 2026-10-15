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
import { before, beforeEach, describe, it } from 'node:test';

import {
  ARDRIVE,
  buildRoot,
  FixtureRoot,
  gatewayOf,
  MemoryL2Source,
  PUBLISHER,
  signers,
  sourceRow,
  writeL1Band,
} from '../../test/parquet-l2-fixture.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';
import { readPublisherFacts } from '../lib/parquet-l1/layout.js';
import type { ExportConfig } from './config.js';
import { deriveL2Bands, L2LiveBand } from './kinds/parquet-l2/bands.js';
import type { L2SourceRow } from './kinds/parquet-l2/source.js';
import { ExportService, RunOptions, runResult } from './service.js';
import { indexState, loadState } from './state.js';

const log = createTestLogger({ suite: 'index-export parquet-l2' });
const tag = (name: string, value: string) => ({ name, value });

describe('ExportService, parquet-l2', () => {
  let dir: string;
  let now: number;
  let roots: FixtureRoot[];
  let source: MemoryL2Source;
  /** The rows of each root's items, by name. */
  let rows: Map<string, L2SourceRow>;

  before(async () => {
    // One root in each of the first two sub-ranges, two more above.
    roots = await Promise.all([
      buildRoot(
        's1',
        [
          { name: 'a1', tags: [tag('App-Name', 'ArDrive-App')] },
          { name: 'a2', tags: [tag('App-Name', 'ArDrive-Web')] },
        ],
        100_500,
        1,
      ),
      buildRoot(
        's2',
        [
          { name: 'b1', tags: [tag('App-Name', 'ArDrive-App')] },
          { name: 'b2', tags: [tag('App-Name', 'ArDrive-App')] },
        ],
        105_500,
        0,
      ),
      buildRoot(
        's3',
        [{ name: 'c1', tags: [tag('App-Name', 'ArDrive-App')] }],
        110_100,
        2,
      ),
      buildRoot(
        's4',
        [{ name: 'e1', tags: [tag('App-Name', 'ArDrive-App')] }],
        115_100,
        0,
      ),
    ]);
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-l2-'));
    now = Date.parse('2026-10-14T04:00:00Z');
    rows = new Map();
    for (const root of roots) {
      for (const name of root.items.keys())
        rows.set(name, sourceRow(root, name));
    }
    // a2 joins later, as an item indexed late.
    source = new MemoryL2Source(
      [...rows.entries()]
        .filter(([name]) => name !== 'a2')
        .map(([, row]) => row),
    );
    source.top = 110_200;
    await writeL1Band(
      path.join(dir, 'published', 'parquet-l1'),
      100_000,
      199_999,
      roots,
    );
  });

  const indexDir = () => path.join(dir, 'published', 'ardrive-l2');
  const config = (more: Partial<ExportConfig> = {}): ExportConfig => ({
    kinds: ['parquet-l2'],
    coreDbPath: path.join(dir, 'core.db'),
    l1PublishDir: path.join(dir, 'published', 'parquet-l1'),
    publisher: PUBLISHER,
    sources: [],
    sourceEnv: {},
    runAtMinute: 240,
    recentMaxBlocks: 1000,
    startHeight: 100_000,
    headerCheckUrl: 'http://gateway.test',
    headerCheckTimeoutMs: 1000,
    metricsPort: 0,
    publishDir: path.join(dir, 'published', 'root-tx-index'),
    workDir: path.join(dir, 'export'),
    l2Indexes: [
      { name: 'ardrive-l2', selection: ARDRIVE, publishDir: indexDir() },
    ],
    l2SettleBlocks: 100,
    resettleIntervalMs: 0,
    l2MaxReads: 1000,
    ...more,
  });
  const run = async (
    options: RunOptions = {},
    more: Partial<ExportConfig> = {},
  ) => {
    const service = new ExportService({
      config: config(more),
      log,
      now: () => now,
      openSources: async () => [],
      openRoots: () => ({
        openRoot: gatewayOf(roots).openRoot,
        close: () => undefined,
      }),
      openL2Source: async () => source,
      diskSpace: async () => ({ free: 1e13, total: 1e14 }),
      headerCheck: { retryDelayMs: 1 },
    });
    const report = await service.runOnce(options);
    const [index] = report.l2 ?? [];
    return { report, index, steps: index?.steps ?? [] };
  };
  const live = () => deriveL2Bands(indexDir(), PUBLISHER, ARDRIVE);
  const summary = (bands: L2LiveBand[]) =>
    bands.map((b) => [
      b.from,
      b.to,
      b.facts.settledAt !== undefined,
      b.band.tables.data_items.rows,
    ]);
  const steps = (
    list: Array<{
      step: string;
      heightRange: [number, number];
      result: string;
      reason: string;
    }>,
  ) =>
    list.map((s) => [
      s.step,
      s.heightRange[0],
      s.heightRange[1],
      s.result,
      s.reason,
    ]);

  it('freezes settled sub-ranges and covers the rest with a tip, then leaves an unchanged tip in place', async () => {
    const first = await run();
    assert.equal(runResult(first.report), 'published');
    assert.deepEqual(steps(first.steps), [
      ['freeze', 100_000, 104_999, 'published', 'new'],
      ['freeze', 105_000, 109_999, 'published', 'new'],
      ['tip', 110_000, 110_200, 'published', 'new'],
    ]);
    assert.deepEqual(summary(await live()), [
      [100_000, 104_999, true, 1],
      [105_000, 109_999, true, 2],
      [110_000, 110_200, false, 1],
    ]);
    // Every located row was header-checked through the gateway.
    assert.equal(first.steps[1].header?.wrong, 0);
    assert.equal(first.steps[1].header?.ok, 2);

    const second = await run();
    assert.deepEqual(steps(second.steps), [
      ['tip', 110_000, 110_200, 'unchanged', 'same_id'],
    ]);
    assert.equal(runResult(second.report), 'unchanged');
    const state = indexState(
      await loadState(path.join(dir, 'export', 'state.json')),
      'ardrive-l2',
    );
    assert.equal(state.lastRun?.outcome, 'unchanged');
    assert.equal(state.retry, undefined);
  });

  it('moves the tip up, superseding the one before, and freezes it once settled, unchanged or not', async () => {
    source.top = 115_050;
    await run();
    // [110000, 114999] is whole but not settled: a tip.
    assert.deepEqual(summary(await live()), [
      [100_000, 104_999, true, 1],
      [105_000, 109_999, true, 2],
      [110_000, 114_999, false, 1],
      [115_000, 115_050, false, 0],
    ]);
    const tip = (await live())[2];
    source.top = 115_200;
    const later = await run();
    // Settled now, with the same rows: the same band, marked frozen.
    assert.deepEqual(steps(later.steps), [
      ['freeze', 110_000, 114_999, 'unchanged', 'same_id'],
      ['tip', 115_000, 115_200, 'published', 'replaces'],
    ]);
    const bands = await live();
    assert.equal(bands[2].id, tip.id);
    assert.ok((await readPublisherFacts(tip.dir))?.settledAt !== undefined);
    assert.deepEqual(summary(bands).slice(2), [
      [110_000, 114_999, true, 1],
      [115_000, 115_200, false, 1],
    ]);
    // The new tip names the one it replaces.
    assert.equal(later.steps[1].supersedes?.length, 1);
  });

  it('re-settles frozen bands: unchanged is left alone, added rows supersede, never losing a row or a location', async () => {
    await run();
    const [d1, d2] = await live();

    // Nothing changed: both left as they are.
    const same = await run({ resettle: 'full' });
    assert.deepEqual(steps(same.steps.filter((s) => s.step === 'resettle')), [
      ['resettle', 105_000, 109_999, 'unchanged', 'same_id'],
      ['resettle', 100_000, 104_999, 'unchanged', 'same_id'],
    ]);

    // a2 arrives late: d1 is rebuilt with it and replaces the old band.
    source.items.push(rows.get('a2')!);
    const added = await run({ resettle: 'full' });
    const rebuilt = added.steps.find(
      (s) => s.step === 'resettle' && s.heightRange[0] === 100_000,
    )!;
    assert.equal(rebuilt.result, 'published');
    assert.equal(rebuilt.compare?.added, 1);
    assert.equal(rebuilt.compare?.missing, 0);
    assert.deepEqual(rebuilt.supersedes, [d1.id]);
    const after = await live();
    assert.equal(
      after.some((b) => b.id === d1.id),
      false,
    );
    assert.equal(after[0].band.tables.data_items.rows, 2);
    assert.ok(after[0].facts.settledAt !== undefined);

    // b2 dropped from the source: d2's re-settle is refused, d2 stays.
    source.items = source.items.filter(
      (row) => !row.id.equals(rows.get('b2')!.id),
    );
    const dropped = await run({ resettle: 'full' });
    const refused = dropped.steps.find((s) => s.heightRange[0] === 105_000)!;
    assert.deepEqual(
      [refused.result, refused.reason],
      ['rejected', 'dropped_items'],
    );
    assert.match(
      refused.details?.[0] ?? '',
      /1 items of the bands it replaces are missing/,
    );
    assert.ok((await live()).some((b) => b.id === d2.id));
    assert.equal(runResult(dropped.report), 'rejected');

    // b1 loses its location: refused too.
    source.items = source.items
      .filter((row) => !row.id.equals(rows.get('b1')!.id))
      .concat({ ...rows.get('b1')!, offset: undefined }, rows.get('b2')!);
    const unlocated = await run({ resettle: 'full' });
    const refusedAgain = unlocated.steps.find(
      (s) => s.heightRange[0] === 105_000,
    )!;
    assert.deepEqual(
      [refusedAgain.result, refusedAgain.reason],
      ['rejected', 'unlocated_rows'],
    );
    assert.ok((await live()).some((b) => b.id === d2.id));
    const state = indexState(
      await loadState(path.join(dir, 'export', 'state.json')),
      'ardrive-l2',
    );
    assert.equal(state.lastRejection?.reasons[0], 'unlocated_rows');
    assert.ok(state.resettledAt?.[d2.id] !== undefined);
  });

  it('header-checks every row a re-settle relocates, and refuses a wrong one', async () => {
    await run();
    const [d1] = await live();
    const a1 = rows.get('a1')!;
    const moved = {
      ...a1,
      // Its key held by the source, so the wallets row stays whatever the
      // moved offsets read.
      owner: roots[0].items.get('a1')!.item.rawOwner,
      offset: a1.offset! + 1,
      dataOffset: a1.dataOffset! + 1,
      signatureOffset: a1.signatureOffset! + 1,
      ownerOffset: a1.ownerOffset! + 1,
    };
    source.items = source.items.map((row) =>
      row.id.equals(a1.id) ? moved : row,
    );
    const relocated = await run({ resettle: 'full' });
    const step = relocated.steps.find((s) => s.heightRange[0] === 100_000)!;
    assert.deepEqual([step.result, step.reason], ['rejected', 'wrong_header']);
    assert.equal(step.compare?.relocated, 1);
    assert.equal(step.header?.byTag.relocated?.wrong, 1);
    assert.ok((await live()).some((b) => b.id === d1.id));
  });

  it('builds a pinned range in a dry run, publishing nothing', async () => {
    const pinned = await run({ dryRun: true, l2Range: [105_000, 109_999] });
    assert.deepEqual(steps(pinned.steps), [
      ['pin', 105_000, 109_999, 'dry_run', 'dry_run'],
    ]);
    assert.equal(pinned.steps[0].rows?.data_items, 2);
    assert.deepEqual(await live(), []);
    assert.deepEqual(
      (await fs.readdir(path.join(dir, 'export'))).filter((n) => n !== 'lock'),
      [],
    );

    // Kept, to compare: in the keep directory, never the publish one.
    const keep = path.join(dir, 'keep');
    const kept = await run({ keepDir: keep, l2Range: [100_000, 104_999] });
    assert.equal(kept.steps[0].result, 'dry_run');
    assert.equal(
      kept.steps[0].keptAt,
      path.join(keep, 'ardrive-l2', kept.steps[0].id!),
    );
    assert.deepEqual(await live(), []);
  });

  it('stops, before building, on bands of another selection or off the grid', async () => {
    await run();
    const other = await run(
      {},
      {
        l2Indexes: [
          {
            name: 'ardrive-l2',
            selection: {
              kind: 'ans104-data-items',
              tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
            },
            publishDir: indexDir(),
          },
        ],
      },
    );
    assert.equal(other.index.failed?.reason, 'grid_layout');
    assert.match(
      other.index.failed?.message ?? '',
      /a new index, under a new name/,
    );
    assert.equal(runResult(other.report), 'rejected');
  });

  it("reaches no higher than this publisher's L1 bands, so they place every root", async () => {
    const l1 = path.join(dir, 'published', 'parquet-l1');
    await fs.rm(l1, { recursive: true, force: true });
    await writeL1Band(l1, 100_000, 104_999, roots);
    const capped = await run();
    assert.equal(capped.index.stableTop, 104_999);
    assert.deepEqual(steps(capped.steps), [
      ['tip', 100_000, 104_999, 'published', 'new'],
    ]);
    assert.equal(capped.steps[0].stats?.roots, 'parquet-l1');
  });

  it('waits with the tip while freezes are behind', async () => {
    // A budget spent at once: the first freeze runs, the rest wait, and the
    // tip with them.
    source.top = 150_000;
    const behind = await run({}, { l2RunBudgetMs: 0 });
    assert.deepEqual(behind.index.deferred?.[0], [105_000, 109_999]);
    assert.ok(behind.steps.every((s) => s.step === 'freeze'));
    assert.ok(
      behind.index.plan.some(
        (p) => p.step === 'tip' && p.deferred !== undefined,
      ),
    );
    const state = indexState(
      await loadState(path.join(dir, 'export', 'state.json')),
      'ardrive-l2',
    );
    assert.match(state.retry?.reason ?? '', /left by the time budget/);
  });
});

describe('ExportService, parquet-l2 roots the network no longer serves', () => {
  let dir: string;
  let now: number;
  /** Nested items whose offsets need a header read to settle. */
  let nested: FixtureRoot;
  /** Ten plain items, always readable. */
  let plain: FixtureRoot;
  /** One item of an owner nobody else's rows key. */
  let lone: FixtureRoot;
  let source: MemoryL2Source;
  /** Roots the gateway answers 404 for. */
  let gone: Set<string>;

  before(async () => {
    nested = await buildRoot(
      'gone-nested',
      [
        {
          name: 'n1',
          tags: [],
          nested: [
            {
              name: 'b1',
              tags: [tag('App-Name', 'ArDrive-App')],
              data: 'x'.repeat(1000),
            },
            { name: 'b2', tags: [tag('App-Name', 'ArDrive-App')] },
            {
              name: 'b3',
              tags: [tag('App-Name', 'ArDrive-App')],
              data: 'y'.repeat(3000),
            },
          ],
        },
      ],
      100_500,
      1,
    );
    plain = await buildRoot(
      'gone-plain',
      Array.from({ length: 10 }, (_, i) => ({
        name: `p${i}`,
        tags: [tag('App-Name', 'ArDrive-App')],
      })),
      100_600,
      0,
    );
    lone = await buildRoot(
      'gone-lone',
      [
        {
          name: 'l1',
          signer: signers.two,
          tags: [tag('App-Name', 'ArDrive-Web')],
        },
      ],
      100_700,
      0,
    );
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-l2-gone-'));
    now = Date.parse('2026-10-14T04:00:00Z');
    gone = new Set();
    const rows = [
      // Relative offsets under a root_parent_offset of 0: b1 is repaired
      // without a read, b2 and b3 need one.
      ...['b1', 'b2', 'b3'].map((name) =>
        sourceRow(nested, name, { rootParentOffset: 0 }),
      ),
      ...[...plain.items.keys()].map((name) => sourceRow(plain, name)),
      sourceRow(lone, 'l1'),
    ];
    source = new MemoryL2Source(rows, [sourceRow(nested, 'n1')]);
    source.top = 110_200;
    await writeL1Band(
      path.join(dir, 'published', 'parquet-l1'),
      100_000,
      199_999,
      [nested, plain, lone],
    );
  });

  const indexDir = () => path.join(dir, 'published', 'ardrive-l2');
  const run = async (options: RunOptions = {}) => {
    const fixture = gatewayOf([nested, plain, lone]);
    const service = new ExportService({
      config: {
        kinds: ['parquet-l2'],
        coreDbPath: path.join(dir, 'core.db'),
        l1PublishDir: path.join(dir, 'published', 'parquet-l1'),
        publisher: PUBLISHER,
        sources: [],
        sourceEnv: {},
        runAtMinute: 240,
        recentMaxBlocks: 1000,
        startHeight: 100_000,
        headerCheckUrl: 'http://gateway.test',
        headerCheckTimeoutMs: 1000,
        metricsPort: 0,
        publishDir: path.join(dir, 'published', 'root-tx-index'),
        workDir: path.join(dir, 'export'),
        l2Indexes: [
          { name: 'ardrive-l2', selection: ARDRIVE, publishDir: indexDir() },
        ],
        l2SettleBlocks: 100,
        resettleIntervalMs: 0,
        l2MaxReads: 1000,
      },
      log,
      now: () => now,
      openSources: async () => [],
      openRoots: () => ({
        openRoot: (root: string) =>
          gone.has(root)
            ? gatewayOf([]).openRoot(root)
            : fixture.openRoot(root),
        close: () => undefined,
      }),
      openL2Source: async () => source,
      diskSpace: async () => ({ free: 1e13, total: 1e14 }),
      headerCheck: { retryDelayMs: 1 },
    });
    const report = await service.runOnce(options);
    return report.l2?.[0]?.steps ?? [];
  };
  const d1 = (steps: Awaited<ReturnType<typeof run>>) =>
    steps.find((s) => s.heightRange[0] === 100_000) as NonNullable<
      Awaited<ReturnType<typeof run>>[number]
    >;
  const live = () => deriveL2Bands(indexDir(), PUBLISHER, ARDRIVE);

  it('builds a band over a root that is gone, its ambiguous items unproven, and locates them once it is back', async () => {
    gone.add(toB64Url(nested.id));
    const first = d1(await run());
    assert.deepEqual([first.result, first.reason], ['published', 'new']);
    assert.deepEqual(first.checks?.unlocated, { unproven: 2 });
    assert.equal(first.stats?.proofs.unproven, 2);
    // The repaired b1's header can't be read either: an error against the
    // sample's pass ratio, never a wrong header.
    assert.equal(first.header?.wrong, 0);
    assert.ok((first.header?.errors ?? 0) >= 1);
    const [band] = await live();

    gone.clear();
    const back = d1(await run({ resettle: 'full' }));
    assert.deepEqual([back.result, back.reason], ['published', 'replaces']);
    assert.equal(back.compare?.newlyLocated, 2);
    assert.equal(back.header?.byTag['newly-located']?.ok, 2);
    assert.deepEqual(back.checks?.unlocated, {});
    assert.deepEqual(back.supersedes, [band.id]);

    // Gone again: a re-settle would unlocate them, and is refused.
    gone.add(toB64Url(nested.id));
    const again = d1(await run({ resettle: 'full' }));
    assert.deepEqual(
      [again.result, again.reason],
      ['rejected', 'unlocated_rows'],
    );
    assert.equal(again.compare?.unlocated, 2);
    assert.equal((await live())[0].id, back.id);
  });

  it("keeps an owner's key: a re-settle that can no longer read it is refused", async () => {
    const first = d1(await run());
    assert.equal(first.result, 'published');
    assert.equal(first.rows?.wallets, 2);
    gone.add(toB64Url(lone.id));
    const without = d1(await run({ resettle: 'full' }));
    assert.deepEqual(
      [without.result, without.reason],
      ['rejected', 'dropped_wallets'],
    );
    assert.equal(without.compare?.walletsMissing, 1);
    assert.equal(without.stats?.owners.withoutKeyBy.unreadable, 1);
  });

  it('stops a band, published or not, when the gateway fails in transport', async () => {
    const fixture = gatewayOf([], { failing: 503 });
    gone = new Set([toB64Url(nested.id)]);
    // Every root 503: the proofs can't be read, and nothing publishes.
    const failing = await new ExportService({
      config: {
        kinds: ['parquet-l2'],
        coreDbPath: path.join(dir, 'core.db'),
        l1PublishDir: path.join(dir, 'published', 'parquet-l1'),
        publisher: PUBLISHER,
        sources: [],
        sourceEnv: {},
        runAtMinute: 240,
        recentMaxBlocks: 1000,
        startHeight: 100_000,
        headerCheckUrl: 'http://gateway.test',
        headerCheckTimeoutMs: 1000,
        metricsPort: 0,
        publishDir: path.join(dir, 'published', 'root-tx-index'),
        workDir: path.join(dir, 'export'),
        l2Indexes: [
          { name: 'ardrive-l2', selection: ARDRIVE, publishDir: indexDir() },
        ],
        l2SettleBlocks: 100,
        resettleIntervalMs: 0,
        l2MaxReads: 1000,
      },
      log,
      now: () => now,
      openSources: async () => [],
      openRoots: () => ({ openRoot: fixture.openRoot, close: () => undefined }),
      openL2Source: async () => source,
      diskSpace: async () => ({ free: 1e13, total: 1e14 }),
      headerCheck: { retryDelayMs: 1 },
    }).runOnce();
    const step = d1(failing.l2?.[0]?.steps ?? []);
    assert.deepEqual([step.result, step.reason], ['couldnt_check', 'gateway']);
    assert.equal(
      (await live()).some((band) => band.from === 100_000),
      false,
    );
  });
});
