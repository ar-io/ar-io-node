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
import Sqlite from 'better-sqlite3';
import crypto from 'node:crypto';

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
import { BAND_FILE, readPublisherFacts } from '../lib/parquet-l1/layout.js';
import {
  bandFiles,
  parseBandFile,
  serializeBandFile,
} from '../lib/parquet-l2/layout.js';
import { verifyBandLookups } from '../lib/parquet-l2/lookups.js';
import { withBandWriter } from './kinds/parquet-l1/export.js';
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
      {
        name: 'ardrive-l2',
        selection: ARDRIVE,
        keyTags: [],
        statTags: [],
        publishDir: indexDir(),
      },
    ],
    l2SettleBlocks: 100,
    resettleIntervalMs: 0,
    l2MaxReads: 1000,
    ...more,
  });
  const run = async (
    options: RunOptions = {},
    more: Partial<ExportConfig> = {},
    deps: Partial<ConstructorParameters<typeof ExportService>[0]> = {},
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
      ...deps,
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

  describe('key lookup and stats, derived in place', () => {
    const derived = (index: { derived?: any[] } | undefined) =>
      (index?.derived ?? []).map((d) => [d.id, d.result, d.reason]);
    /** Takes a published band back to l2-1: no key or stat tags, no files for them. */
    const downgrade = async (band: L2LiveBand) => {
      const { keyTags: _k, statTags: _s, ...rest } = band.band;
      const { key: _key, stats: _stats, ...lookups } = band.band.lookups;
      await fs.rm(path.join(band.dir, 'lookup_key.parquet'));
      await fs.rm(path.join(band.dir, 'stats.parquet'));
      await fs.writeFile(
        path.join(band.dir, BAND_FILE),
        serializeBandFile({ ...rest, schema: 'l2-1', lookups }),
      );
    };
    const tableStats = async (dir: string) =>
      Object.fromEntries(
        await Promise.all(
          ['data_items', 'tags', 'wallets', 'parents'].map(async (t) => {
            const stat = await fs.stat(path.join(dir, `${t}.parquet`));
            return [t, [stat.size, stat.mtimeMs]];
          }),
        ),
      );
    const tagged = () => ({
      l2Indexes: [
        {
          name: 'ardrive-l2',
          selection: ARDRIVE,
          keyTags: ['App-Name'],
          statTags: ['App-Name'],
          publishDir: indexDir(),
        },
      ],
    });

    it('writes every band as l2-2, for the index’s tag names', async () => {
      const { index } = await run({}, tagged());
      assert.deepEqual(derived(index), [], 'nothing to derive from a build');
      for (const band of await live()) {
        assert.equal(band.band.schema, 'l2-2');
        assert.deepEqual(band.band.keyTags, ['App-Name']);
        assert.deepEqual(band.band.statTags, ['App-Name']);
        assert.ok(band.band.lookups.key.rows > 0, band.id);
        assert.deepEqual(
          (await fs.readdir(band.dir)).filter((n) => !n.startsWith('.')).sort(),
          bandFiles('l2-2'),
        );
      }
    });

    it('derives an l2-1 band’s key lookup and stats in place: same id, tables untouched, before any build', async () => {
      await run({}, tagged());
      const [first, ...rest] = await live();
      await downgrade(first);
      assert.equal((await live())[0].band.schema, 'l2-1');
      const before = await tableStats(first.dir);
      const facts = await readPublisherFacts(first.dir);

      const { report, index } = await run({}, tagged());
      assert.deepEqual(derived(index), [[first.id, 'published', 'layout']]);
      const [outcome] = index.derived ?? [];
      assert.ok((outcome?.rows?.key ?? 0) > 0);
      assert.ok((outcome?.rows?.stats ?? 0) > 0);
      assert.equal(runResult(report), 'published');
      // Derived before the builds: the log line order, and no band rebuilt.
      assert.deepEqual(
        index.steps.filter((s) => s.result === 'published'),
        [],
      );
      const bands = await live();
      assert.equal(bands.length, rest.length + 1);
      const upgraded = bands.find((b) => b.id === first.id)!;
      assert.equal(upgraded.band.schema, 'l2-2');
      assert.deepEqual(upgraded.band.keyTags, ['App-Name']);
      assert.deepEqual(await tableStats(first.dir), before, 'tables untouched');
      assert.deepEqual(await readPublisherFacts(first.dir), facts);
      assert.deepEqual(
        (await fs.readdir(first.dir)).filter((n) => !n.startsWith('.')).sort(),
        bandFiles('l2-2'),
      );
      await withBandWriter(path.join(dir, 'read'), async (duck) => {
        assert.deepEqual(
          await verifyBandLookups(duck, first.dir, upgraded.band),
          [],
        );
      });
      // Current now: nothing more to derive.
      assert.deepEqual(derived((await run({}, tagged())).index), []);
    });

    it('derives again when the index’s tag names change, and on a dry run changes nothing', async () => {
      await run({}, tagged());
      const bands = await live();
      const changed = {
        l2Indexes: [
          { ...tagged().l2Indexes[0], keyTags: ['App-Name', 'Content-Type'] },
        ],
      };
      const dry = await run({ dryRun: true }, changed);
      assert.deepEqual(
        derived(dry.index),
        bands.map((b) => [b.id, 'dry_run', 'dry_run']),
      );
      for (const band of await live()) {
        assert.deepEqual(band.band.keyTags, ['App-Name'], 'unchanged');
      }
      const { index } = await run({}, changed);
      assert.deepEqual(
        derived(index),
        bands.map((b) => [b.id, 'published', 'tags_changed']),
      );
      for (const band of await live()) {
        assert.deepEqual(band.band.keyTags, ['App-Name', 'Content-Type']);
        assert.deepEqual(
          parseBandFile(
            await fs.readFile(path.join(band.dir, BAND_FILE), 'utf8'),
          ).keyTags,
          ['App-Name', 'Content-Type'],
        );
      }
      assert.deepEqual(derived((await run({}, changed)).index), []);
    });

    it('derives before the source is opened, so a source outage holds no upgrade back', async () => {
      await run({}, tagged());
      const [first] = await live();
      await downgrade(first);
      const { index } = await run({}, tagged(), {
        openL2Source: async () => {
          throw new Error('ClickHouse is down');
        },
      });
      assert.equal(index.failed?.reason, 'source');
      assert.deepEqual(derived(index), [[first.id, 'published', 'layout']]);
      assert.equal(
        (await live()).find((b) => b.id === first.id)?.band.schema,
        'l2-2',
      );
    });

    it('holds the derive to --range', async () => {
      await run({}, tagged());
      const bands = await live();
      for (const band of bands) await downgrade(band);
      const target = bands[0];
      const { index } = await run(
        { range: [target.from, target.to], resettle: 'full' },
        tagged(),
      );
      assert.deepEqual(derived(index), [[target.id, 'published', 'layout']]);
      assert.deepEqual(
        (await live()).map((b) => b.band.schema),
        bands.map((b) => (b.id === target.id ? 'l2-2' : 'l2-1')),
      );
    });
  });

  describe('band size cap', () => {
    // The roots' range, 100,000-199,999, whole and settled: the L1 bands
    // reach past it and the source's top is above the settle lag.
    const settleWholeRange = async () => {
      await writeL1Band(
        path.join(dir, 'published', 'parquet-l1'),
        200_000,
        299_999,
        [],
      );
      source.top = 200_100;
    };
    const inRange = (bands: L2LiveBand[]) =>
      bands.filter((b) => b.from >= 100_000 && b.to <= 199_999);
    const items = (bands: L2LiveBand[]) =>
      bands.reduce((sum, b) => sum + b.band.tables.data_items.rows, 0);

    it('freezes a whole range over the cap d by d, and never rolls it into an h', async () => {
      await settleWholeRange();
      await run({}, { l2MaxBandItems: 2 });
      let bands = inRange(await live());
      assert.equal(bands.length, 20, bands.map((b) => b.id).join(' '));
      assert.ok(
        bands.every(
          (b) => b.to - b.from === 4_999 && b.facts.settledAt !== undefined,
        ),
      );
      assert.equal(items(bands), 5); // a1, b1, b2, c1, e1 (a2 joins later)
      // A second run: the twenty frozen d bands hold more than the cap, so
      // no roll.
      const second = await run({}, { l2MaxBandItems: 2 });
      assert.ok(!second.steps.some((s) => s.step === 'roll'));
      bands = inRange(await live());
      assert.equal(bands.length, 20);
    });

    it('freezes a whole range at or under the cap as one h, as before', async () => {
      await settleWholeRange();
      await run({}, { l2MaxBandItems: 5 });
      const bands = inRange(await live());
      assert.deepEqual(
        bands.map((b) => [b.from, b.to]),
        [[100_000, 199_999]],
      );
    });

    it('splits an h over the cap into its twenty d bands, published together, each superseding it', async () => {
      await settleWholeRange();
      await run({});
      const [h] = inRange(await live());
      assert.deepEqual([h.from, h.to], [100_000, 199_999]);
      assert.equal(h.band.tables.data_items.rows, 5);

      // A dry run builds the parts and publishes nothing.
      const dry = await run({ dryRun: true }, { l2MaxBandItems: 2 });
      const dryParts = dry.steps.filter((s) => s.step === 'split');
      assert.equal(dryParts.length, 20);
      assert.ok(dryParts.every((s) => s.result === 'dry_run'));
      assert.deepEqual(
        inRange(await live()).map((b) => b.id),
        [h.id],
      );

      const split = await run({}, { l2MaxBandItems: 2 });
      const parts = split.steps.filter((s) => s.step === 'split');
      assert.equal(parts.length, 20);
      assert.ok(
        parts.every(
          (s) => s.result === 'published' && s.stagedAt === undefined,
        ),
        JSON.stringify(parts.map((s) => [s.heightRange, s.result, s.reason])),
      );
      const bands = inRange(await live());
      assert.equal(bands.length, 20);
      assert.ok(!bands.some((b) => b.id === h.id), 'the h is superseded');
      assert.equal(items(bands), 5, 'every item kept');
      for (const band of bands) {
        assert.ok(band.facts.supersedes?.includes(h.id), band.id);
        assert.ok(band.facts.settledAt !== undefined);
      }
      // Nothing left staged.
      const work = await fs.readdir(path.join(dir, 'export'));
      assert.deepEqual(
        work.filter((n) => n.startsWith('.split-')),
        [],
      );
      // Settled: a later run neither splits again nor rolls them back.
      const after = await run({}, { l2MaxBandItems: 2 });
      assert.ok(
        !after.steps.some((s) => s.step === 'split' || s.step === 'roll'),
      );
    });

    it('finishes a split a run was interrupted while publishing, and drops one that was not ready', async () => {
      await settleWholeRange();
      await run({});
      const [h] = inRange(await live());
      await run({}, { l2MaxBandItems: 2 });
      const parts = inRange(await live());
      assert.equal(parts.length, 20);

      // Interrupted after five moves: fifteen parts still staged, ready.
      const stage = path.join(dir, 'export', `.split-ardrive-l2-100000`);
      await fs.mkdir(stage, { recursive: true });
      for (const band of parts.slice(5)) {
        await fs.rename(band.dir, path.join(stage, band.id));
      }
      await fs.writeFile(
        path.join(stage, 'split-ready.json'),
        JSON.stringify({
          publishDir: indexDir(),
          band: h.id,
          parts: parts.map((b) => b.id),
        }),
      );
      // Half covered: the h is superseded by the parts already live.
      assert.equal(inRange(await live()).length, 5);
      // A stage without the marker never published anything: dropped.
      const notReady = path.join(dir, 'export', `.split-ardrive-l2-900000`);
      await fs.mkdir(path.join(notReady, 'some-part'), { recursive: true });

      await run({}, { l2MaxBandItems: 2 });
      const bands = inRange(await live());
      assert.deepEqual(
        bands.map((b) => b.id).sort(),
        parts.map((b) => b.id).sort(),
      );
      assert.equal(items(bands), 5);
      const work = await fs.readdir(path.join(dir, 'export'));
      assert.deepEqual(
        work.filter((n) => n.startsWith('.split-')),
        [],
      );
    });
  });

  it('builds a pinned range in a dry run, publishing nothing', async () => {
    const pinned = await run({ dryRun: true, range: [105_000, 109_999] });
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
    const kept = await run({ keepDir: keep, range: [100_000, 104_999] });
    assert.equal(kept.steps[0].result, 'dry_run');
    assert.equal(
      kept.steps[0].keptAt,
      path.join(keep, 'ardrive-l2', kept.steps[0].id!),
    );
    assert.deepEqual(await live(), []);
  });

  it('gates re-settles on the fingerprint: same rows are not rebuilt, changed or unrecorded ones are', async () => {
    await run();
    const stateFile = path.join(dir, 'export', 'state.json');
    const gated = (result: Awaited<ReturnType<typeof run>>) =>
      result.steps
        .filter((s) => s.step === 'resettle')
        .map((s) => [s.heightRange[0], s.result, s.reason, s.gate?.verdict])
        .sort((a, b) => (a[0] as number) - (b[0] as number));

    const same = await run({ resettle: 'gate' });
    assert.deepEqual(gated(same), [
      [100_000, 'unchanged', 'same_sources', 'same_sources'],
      [105_000, 'unchanged', 'same_sources', 'same_sources'],
    ]);
    // Not rebuilt: nothing read or written.
    assert.ok(
      same.steps.every((s) => s.stats === undefined || s.step !== 'resettle'),
    );

    // A row added to d1's heights: d1 rebuilt, d2 not.
    source.items.push(rows.get('a2')!);
    const changed = await run({ resettle: 'gate' });
    assert.deepEqual(gated(changed), [
      [100_000, 'published', 'replaces', 'changed'],
      [105_000, 'unchanged', 'same_sources', 'same_sources'],
    ]);
    assert.deepEqual(gated(await run({ resettle: 'gate' })), [
      [100_000, 'unchanged', 'same_sources', 'same_sources'],
      [105_000, 'unchanged', 'same_sources', 'same_sources'],
    ]);

    // No fingerprint recorded (state lost): each rebuilt once.
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    delete saved.indexes['ardrive-l2'].fingerprints;
    await fs.writeFile(stateFile, JSON.stringify(saved));
    assert.deepEqual(gated(await run({ resettle: 'gate' })), [
      [100_000, 'unchanged', 'same_id', 'unrecorded'],
      [105_000, 'unchanged', 'same_id', 'unrecorded'],
    ]);
    // `full` rebuilds whatever the fingerprints say.
    assert.deepEqual(
      gated(await run({ resettle: 'full' })).map((g) => g.slice(0, 3)),
      [
        [100_000, 'unchanged', 'same_id'],
        [105_000, 'unchanged', 'same_id'],
      ],
    );
  });

  it('re-settles only the frozen bands inside --range, and builds nothing else', async () => {
    await run();
    source.top = 115_200;
    const held = await run({ resettle: 'full', range: [100_000, 104_999] });
    assert.deepEqual(
      held.steps.map((s) => [s.step, s.heightRange[0], s.heightRange[1]]),
      [['resettle', 100_000, 104_999]],
    );
    // The tip that would have frozen and moved up is as it was.
    assert.ok(
      (await live()).some((b) => b.from === 110_000 && b.to === 110_200),
    );
  });

  it('runs nothing of a legacy root-TX layout with --range, and keeps its state', async () => {
    await run();
    const stateFile = path.join(dir, 'export', 'state.json');
    const before = indexState(await loadState(stateFile), 'root-tx-index');
    let opened = 0;
    const service = new ExportService({
      config: config({ kinds: ['root-tx-index', 'parquet-l2'] }),
      log,
      now: () => now,
      openSources: async () => {
        opened += 1;
        return [];
      },
      openRoots: () => ({
        openRoot: gatewayOf(roots).openRoot,
        close: () => undefined,
      }),
      openL2Source: async () => source,
      diskSpace: async () => ({ free: 1e13, total: 1e14 }),
      headerCheck: { retryDelayMs: 1 },
    });
    const report = await service.runOnce({
      resettle: 'full',
      range: [100_000, 104_999],
      force: true,
    });
    // No bootstrap, fold, delta or publish of the legacy layout.
    assert.equal(opened, 0);
    assert.deepEqual(report.steps, []);
    assert.equal(report.failed, undefined);
    assert.deepEqual(
      await fs
        .readdir(path.join(dir, 'published', 'root-tx-index'))
        .catch(() => []),
      [],
    );
    assert.deepEqual(
      report.l2?.[0]?.steps.map((s) => [s.step, s.heightRange[0]]),
      [['resettle', 100_000]],
    );
    assert.deepEqual(
      indexState(await loadState(stateFile), 'root-tx-index'),
      before,
    );
  });

  it("gates on the owners' keys bundles.db holds too", async () => {
    const db = path.join(dir, 'bundles.db');
    const sqlite = new Sqlite(db);
    sqlite.exec(
      'CREATE TABLE wallets (address BLOB PRIMARY KEY, public_modulus BLOB)',
    );
    const key = roots[0].items.get('a1')!.item.rawOwner;
    const address = crypto.createHash('sha256').update(key).digest();
    sqlite.prepare('INSERT INTO wallets VALUES (?, ?)').run(address, key);
    sqlite.close();
    await run({}, { l2WalletsDb: db });
    const same = await run({ resettle: 'gate' }, { l2WalletsDb: db });
    assert.ok(
      same.steps
        .filter((s) => s.step === 'resettle')
        .every((s) => s.gate?.verdict === 'same_sources'),
    );
    const again = new Sqlite(db);
    again.prepare('DELETE FROM wallets').run();
    again.close();
    const changed = await run({ resettle: 'gate' }, { l2WalletsDb: db });
    assert.ok(
      changed.steps
        .filter((s) => s.step === 'resettle')
        .every((s) => s.gate?.verdict === 'changed'),
    );
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
          {
            name: 'ardrive-l2',
            selection: ARDRIVE,
            keyTags: [],
            statTags: [],
            publishDir: indexDir(),
          },
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
    // In band.json an unproven item is an unresolved ambiguous one: the
    // same row. The 404s are the publisher's own.
    assert.deepEqual(first.checks?.unlocated, { ambiguous: 2 });
    assert.equal(first.stats?.proofs.unproven, 2);
    // The repaired b1's header can't be read either: passed over in the
    // sample, out of its pass ratio, and never a wrong header.
    assert.equal(first.header?.wrong, 0);
    assert.equal(first.header?.errors, 0);
    assert.equal(first.header?.unreadable, 1);
    assert.equal(first.header?.ok, 11);
    assert.equal(first.header?.poolSize, 12);
    assert.equal(first.header?.unreadableShare, Number((1 / 12).toFixed(3)));
    assert.equal(first.checks?.sampled, undefined);
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

  it('verifies a band most of whose roots are gone among those that answer', async () => {
    // The nested root and the lone item's root gone: 2 of the 13 located
    // rows' roots. Then the plain root too: nothing left to verify.
    gone.add(toB64Url(nested.id));
    gone.add(toB64Url(lone.id));
    const step = d1(await run({ dryRun: true }));
    assert.deepEqual([step.result, step.reason], ['dry_run', 'dry_run']);
    assert.equal(step.header?.unreadable, 2);
    assert.equal(step.header?.ok, 10);
    assert.ok((step.header?.byTag['']?.unreadable ?? 0) >= 1);
    gone.add(toB64Url(plain.id));
    const none = d1(await run({ dryRun: true }));
    assert.deepEqual([none.result, none.reason], ['couldnt_check', 'gate']);
    assert.equal(none.header?.ok, 0);
    assert.equal(none.header?.unreadableShare, 1);
  });

  it('rebuilds a band built with 404s on every fourth gated re-settle, so roots served again get in', async () => {
    gone.add(toB64Url(nested.id));
    const first = d1(await run());
    assert.equal(first.result, 'published');
    const [band] = await live();
    assert.deepEqual(band.facts.unreadable, { proofs: 2, keys: 0 });
    gone.clear();
    for (let pass = 1; pass <= 3; pass++) {
      const skipped = d1(await run({ resettle: 'gate' }));
      assert.deepEqual(
        [skipped.result, skipped.gate?.verdict],
        ['unchanged', 'same_sources'],
        `pass ${pass}`,
      );
    }
    const fourth = d1(await run({ resettle: 'gate' }));
    assert.deepEqual(
      [fourth.result, fourth.gate?.verdict],
      ['published', 'recheck_unreadable'],
    );
    assert.deepEqual(fourth.checks?.unlocated, {});
    const [rebuilt] = await live();
    assert.deepEqual(rebuilt.facts.unreadable, { proofs: 0, keys: 0 });
    // Nothing unreadable now: gated re-settles skip it for good.
    for (let pass = 1; pass <= 4; pass++) {
      const skipped = d1(await run({ resettle: 'gate' }));
      assert.equal(skipped.gate?.verdict, 'same_sources');
    }
  });

  it("keeps an owner's key a re-settle can no longer read, from the band it replaces", async () => {
    const first = d1(await run());
    assert.equal(first.result, 'published');
    assert.equal(first.rows?.wallets, 2);
    assert.equal(first.stats?.owners.fromReplaced, 0);
    gone.add(toB64Url(lone.id));
    // The root is gone, so the key can't be read; the replaced band holds
    // it, so the band is built with it and nothing is dropped.
    const without = d1(await run({ resettle: 'full' }));
    assert.deepEqual(
      [without.result, without.reason],
      ['unchanged', 'same_id'],
      JSON.stringify(without.details),
    );
    // Both owners' keys come from the replaced band: it is tried before
    // the roots, so a re-settle reads no key the band it replaces holds.
    assert.equal(without.stats?.owners.fromReplaced, 2);
    assert.equal(without.stats?.owners.fromGateway, 0);
    assert.equal(without.stats?.owners.withoutKey, 0);
    assert.equal(without.rows?.wallets, 2);
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
          {
            name: 'ardrive-l2',
            selection: ARDRIVE,
            keyTags: [],
            statTags: [],
            publishDir: indexDir(),
          },
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
