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
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BandRecord,
  buildBand,
  BuiltBand,
  OVERLAY_CHANGED_TAG,
} from './build.js';
import { openBandRecords } from './read.js';
import { checkBandHeaders } from './verify.js';
import { ByteRangeSource } from '../byte-range-source.js';
import { Cdb64Writer } from '../cdb64.js';
import {
  Cdb64RootTxValue,
  decodeCdb64Value,
  encodeCdb64Value,
  getDataItemSize,
  getRootTxId,
  isCompleteValue,
} from '../cdb64-encoding.js';
import {
  indexToPrefix,
  parseManifest,
  serializeManifest,
} from '../cdb64-manifest.js';
import { toB64Url } from '../encoding.js';
import { PartitionedCdb64Reader } from '../partitioned-cdb64-reader.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'buildBand merge rules' });
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

const id32 = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 7 + i) % 256;
  return buf;
};

/** A record for item `seed` in root `root`, with offsets unless `offset` is null. */
const row = (
  seed: number,
  root: number,
  height: number,
  more: Partial<BandRecord> & { offset?: number | null } = {},
): BandRecord => {
  const { offset = 1000, ...rest } = more;
  return {
    id: id32(seed),
    rootTxId: id32(root),
    height,
    ...(offset !== null
      ? { rootOffset: offset, rootDataOffset: offset + 100 }
      : {}),
    ...rest,
  };
};

describe('buildBand merge rules', () => {
  let root: string;
  let publishDir: string;
  let workDir: string;
  let builds = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-band-merge-'));
    publishDir = path.join(root, 'published', 'root-tx-index');
    workDir = path.join(root, 'export');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const build = (
    records: BandRecord[],
    overrides: Partial<Parameters<typeof buildBand>[0]> = {},
  ) =>
    buildBand({
      log,
      records,
      // Each build its own publish directory, so none is `unchanged`.
      publishDir: path.join(publishDir, String((builds += 1))),
      workDir,
      publisher: PUBLISHER,
      kind: 'd',
      heightRange: [100, null],
      ...overrides,
    });

  const lookup = async (
    band: BuiltBand,
    seed: number,
  ): Promise<Cdb64RootTxValue | undefined> => {
    assert.ok(band.dir !== undefined);
    const manifest = parseManifest(
      await fs.readFile(path.join(band.dir, 'manifest.json'), 'utf8'),
    );
    const reader = new PartitionedCdb64Reader({
      manifest,
      baseDir: band.dir,
      log,
    });
    await reader.open();
    try {
      const value = await reader.get(id32(seed));
      return value === undefined ? undefined : decodeCdb64Value(value);
    } finally {
      await reader.close();
    }
  };

  const rootOf = async (band: BuiltBand, seed: number) => {
    const value = await lookup(band, seed);
    assert.ok(value !== undefined, `item ${seed} is in the band`);
    return getRootTxId(value);
  };

  const offsetOf = async (band: BuiltBand, seed: number) => {
    const value = await lookup(band, seed);
    assert.ok(value !== undefined && isCompleteValue(value));
    return value.rootDataItemOffset;
  };

  // A filler entry, so a band whose subject was dropped still has one.
  const filler = row(250, 250, 100);

  describe('precedence', () => {
    it('lets an overlay row beat a peer row at a higher height', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1' }),
        row(1, 12, 400, { source: 'bundler', rank: 1 }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
      assert.equal(band.duplicates, 1);
    });

    it('lets an overlay row beat a folded entry', async () => {
      const band = await build([
        row(1, 11, 500, { folded: true }),
        row(1, 12, 400, { source: 'bundler', rank: 1 }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
    });

    it('lets a peer re-bundle above an overlay coverage beat the overlay', async () => {
      // A weekly extract covering up to 2000700 can't know of a re-bundle
      // at 2000900.
      const band = await build([
        row(1, 11, 2000500, {
          source: 'bundler',
          rank: 1,
          coverageTo: 2000700,
        }),
        row(1, 12, 2000900, { source: 'gw1' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
      assert.equal(band.overlayOutranked, 1);
      assert.equal(band.overlayChanged, 0);
      assert.equal(band.duplicates, 1);
    });

    it('keeps an overlay over peers within its coverage, and over folded entries above it', async () => {
      const band = await build([
        // A peer at the coverage top: still outranked.
        row(1, 11, 2000500, {
          source: 'bundler',
          rank: 1,
          coverageTo: 2000700,
        }),
        row(1, 12, 2000700, { source: 'gw1' }),
        // A folded entry above the coverage: its height is its band's top,
        // not the item's, so it is outranked.
        row(2, 21, 2000500, {
          source: 'bundler',
          rank: 1,
          coverageTo: 2000700,
        }),
        row(2, 22, 2000900, { folded: true }),
        // No coverage given: rank alone decides, as before.
        row(3, 31, 2000500, { source: 'bundler', rank: 1 }),
        row(3, 32, 2000900, { source: 'gw1' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
      assert.ok((await rootOf(band, 2)).equals(id32(21)));
      assert.ok((await rootOf(band, 3)).equals(id32(31)));
      assert.equal(band.overlayOutranked, 0);
    });

    it('checks the peers left after an outranked overlay for conflicts', async () => {
      const band = await build([
        row(1, 11, 2000500, {
          source: 'bundler',
          rank: 1,
          coverageTo: 2000700,
        }),
        row(1, 12, 2000900, { source: 'gw1', offset: 1000 }),
        row(1, 12, 2000900, { source: 'gw2', offset: 2000 }),
        row(1, 13, 2000800, { source: 'gw1' }),
      ]);
      assert.equal(band.conflicts, 1);
      assert.ok((await rootOf(band, 1)).equals(id32(13)));
      // The overlay row lost; the two conflicting rows are set aside.
      assert.equal(band.duplicates, 1);
    });

    it('lets the later root win among peer rows', async () => {
      const band = await build([
        row(1, 11, 400, { source: 'gw1' }),
        row(1, 12, 500, { source: 'gw2' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
    });

    it('lets a peer row above a folded band top win (a later re-bundle)', async () => {
      const band = await build([
        row(1, 11, 1000, { folded: true }),
        row(1, 12, 1001, { source: 'gw1' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
    });

    it('keeps a folded entry over a peer row at or below its band top', async () => {
      // The folded entry holds an overlay correction; a peer re-exporting
      // the uncorrected row inside the old range must not undo it.
      const band = await build([
        row(1, 11, 1000, { folded: true }),
        row(1, 12, 900, { source: 'gw1' }),
        row(2, 21, 1000, { folded: true, offset: 5000 }),
        row(2, 22, 1000, { source: 'gw1', offset: 9000 }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
      assert.ok((await rootOf(band, 2)).equals(id32(21)));
      assert.equal(await offsetOf(band, 2), 5000);
    });

    it('keeps a root-only folded entry over a peer row with offsets at its height', async () => {
      // As the design orders it: folded before offsets, so a folded
      // correction is never second-guessed by a source.
      const band = await build([
        row(1, 11, 1000, { folded: true, offset: null }),
        row(1, 12, 1000, { source: 'gw1' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
      assert.ok(!isCompleteValue((await lookup(band, 1))!));
    });

    it('still prefers offsets at equal rank and height', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: null }),
        row(1, 11, 500, { source: 'gw2' }),
      ]);
      assert.equal(await offsetOf(band, 1), 1000);
    });

    it('gives the same band for any input order and source names', async () => {
      const records = [
        row(1, 11, 500, { source: 'gw1' }),
        row(1, 12, 500, { source: 'gw2' }),
        row(2, 21, 500, { source: 'gw1', sampleTag: 'repaired' }),
        row(2, 21, 500, { source: 'gw2' }),
        row(3, 31, 600, { folded: true }),
        row(3, 32, 600, { source: 'gw1' }),
        row(4, 41, 600, { rank: 1, source: 'bundler' }),
        row(4, 42, 700, { source: 'gw2' }),
      ];
      const forward = await build(records);
      const reversed = await build(
        [...records]
          .reverse()
          .map((r) =>
            r.source !== undefined ? { ...r, source: `x-${r.source}` } : r,
          ),
      );
      assert.equal(reversed.contentDigest, forward.contentDigest);
      assert.equal(reversed.id, forward.id);
    });
  });

  describe('conflicts', () => {
    it('drops an ID two sources give different offsets for', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw2', offset: 2000 }),
        filler,
      ]);
      assert.equal(band.conflicts, 1);
      assert.equal(band.duplicates, 0);
      assert.equal(band.records, 1);
      assert.equal(await lookup(band, 1), undefined);
      assert.ok(!band.sample.some((e) => e.id === toB64Url(id32(1))));
    });

    it('drops an ID two sources give different item offsets for', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1' }),
        { ...row(1, 11, 500, { source: 'gw2' }), rootOffset: 1050 },
        filler,
      ]);
      assert.equal(band.conflicts, 1);
      assert.equal(await lookup(band, 1), undefined);
    });

    it('drops an ID two sources give different payload offsets for', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1' }),
        {
          ...row(1, 11, 500, { source: 'gw2' }),
          rootDataOffset: 1200,
        },
        filler,
      ]);
      assert.equal(band.conflicts, 1);
      assert.equal(await lookup(band, 1), undefined);
    });

    it('drops an ID two sources give different sizes for', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', size: 600 }),
        row(1, 11, 500, { source: 'gw2', size: 700 }),
        filler,
      ]);
      assert.equal(band.conflicts, 1);
    });

    it('does not count a field only one source has as a conflict', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', size: 600 }),
        row(1, 11, 500, { source: 'gw2' }),
        row(2, 21, 500, { source: 'gw1', offset: null }),
        row(2, 21, 500, { source: 'gw2' }),
      ]);
      assert.equal(band.conflicts, 0);
      const one = await lookup(band, 1);
      assert.ok(one !== undefined);
      assert.equal(getDataItemSize(one), 600);
      assert.equal(await offsetOf(band, 2), 1000);
    });

    it('agrees when both sources give the same values', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', size: 600 }),
        row(1, 11, 500, { source: 'gw2', size: 600 }),
      ]);
      assert.equal(band.conflicts, 0);
      assert.equal(band.duplicates, 1);
    });

    it('never finds a conflict within one source, or without sources', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw1', offset: 2000 }),
        row(2, 21, 500, { offset: 1000 }),
        row(2, 21, 500, { offset: 2000 }),
        row(3, 31, 500, { source: 'gw1', offset: 1000 }),
        row(3, 31, 500, { offset: 2000 }),
      ]);
      assert.equal(band.conflicts, 0);
      assert.equal(band.records, 3);
    });

    it('lets different roots at one height tie-break, not conflict', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 12, 500, { source: 'gw2', offset: 2000 }),
      ]);
      assert.equal(band.conflicts, 0);
      assert.equal(band.records, 1);
    });

    it('ignores a disagreement below the winning row', async () => {
      const band = await build([
        // Below a later root.
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw2', offset: 2000 }),
        row(1, 12, 600, { source: 'gw1' }),
        // Below an overlay.
        row(2, 21, 500, { source: 'gw1', offset: 1000 }),
        row(2, 21, 500, { source: 'gw2', offset: 2000 }),
        row(2, 22, 400, { source: 'bundler', rank: 1 }),
        // Below a folded entry at the same height.
        row(3, 31, 500, { source: 'gw1', offset: 1000 }),
        row(3, 31, 500, { source: 'gw2', offset: 2000 }),
        row(3, 31, 500, { folded: true, offset: 3000 }),
      ]);
      assert.equal(band.conflicts, 0);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
      assert.ok((await rootOf(band, 2)).equals(id32(22)));
      assert.equal(await offsetOf(band, 3), 3000);
    });

    it('finds conflicts between overlays too', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'bundler-a', rank: 1, offset: 1000 }),
        row(1, 11, 500, { source: 'bundler-b', rank: 1, offset: 2000 }),
        filler,
      ]);
      assert.equal(band.conflicts, 1);
    });

    it('never counts a folded entry in a conflict', async () => {
      const band = await build([
        row(1, 11, 500, { folded: true, source: 'old', offset: 1000 }),
        row(1, 11, 400, { source: 'gw1', offset: 2000 }),
        row(2, 21, 500, { folded: true, source: 'a', offset: 1000 }),
        row(2, 21, 500, { folded: true, source: 'b', offset: 2000 }),
      ]);
      assert.equal(band.conflicts, 0);
      assert.equal(await offsetOf(band, 1), 1000);
    });

    it('falls back to the best record below the conflicting ones', async () => {
      const band = await build([
        // A folded entry, then two sources disagreeing on a later root.
        row(1, 11, 1000, { folded: true, offset: 5000 }),
        row(1, 12, 1001, { source: 'gw1', offset: 1000 }),
        row(1, 12, 1001, { source: 'gw2', offset: 2000 }),
        // An earlier root from one source.
        row(2, 21, 400, { source: 'gw1' }),
        row(2, 22, 500, { source: 'gw1', offset: 1000 }),
        row(2, 22, 500, { source: 'gw2', offset: 2000 }),
      ]);
      assert.equal(band.conflicts, 2);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
      assert.equal(await offsetOf(band, 1), 5000);
      assert.ok((await rootOf(band, 2)).equals(id32(21)));
      // The conflicting records are not duplicates.
      assert.equal(band.duplicates, 0);
      assert.ok(band.conflictSample.every((c) => c.fallback));
    });

    it('finds a conflict when two of three sources agree', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw2', offset: 1000 }),
        row(1, 11, 500, { source: 'bundler', offset: 2000 }),
        filler,
      ]);
      assert.equal(band.conflicts, 1);
      assert.equal(await lookup(band, 1), undefined);
    });

    it('drops an ID whose same-root records conflict beside another root', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw2', offset: 2000 }),
        row(1, 99, 500, { source: 'gw3', offset: 3000 }),
        filler,
      ]);
      assert.equal(band.conflicts, 1);
      assert.equal(await lookup(band, 1), undefined);
    });

    it('names the items and sources that conflicted', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1', offset: 1000 }),
        row(1, 11, 500, { source: 'gw2', offset: 2000 }),
        filler,
      ]);
      assert.deepEqual([...(band.conflictSample[0]?.sources ?? [])].sort(), [
        'gw1',
        'gw2',
      ]);
      assert.deepEqual(band.conflictSample, [
        {
          id: toB64Url(id32(1)),
          rootTxId: toB64Url(id32(11)),
          sources: band.conflictSample[0]?.sources,
          fallback: false,
        },
      ]);
    });

    it('gives the check before publishing the conflicts, so it can refuse', async () => {
      let seen: { conflicts: number; ids: string[] } | undefined;
      const band = await build(
        [
          row(1, 11, 500, { source: 'gw1', offset: 1000 }),
          row(1, 11, 500, { source: 'gw2', offset: 2000 }),
          filler,
        ],
        {
          beforePublish: async (staged) => {
            seen = {
              conflicts: staged.conflicts,
              ids: staged.conflictSample.map((c) => c.id),
            };
            return { publish: false, reasons: ['too many conflicts'] };
          },
        },
      );
      assert.deepEqual(seen, { conflicts: 1, ids: [toB64Url(id32(1))] });
      assert.equal(band.published, false);
      assert.deepEqual(band.rejected, ['too many conflicts']);
    });

    it('refuses a band in which every ID conflicted, and says so', async () => {
      await assert.rejects(
        build([
          row(1, 11, 500, { source: 'gw1', offset: 1000 }),
          row(1, 11, 500, { source: 'gw2', offset: 2000 }),
        ]),
        /1 IDs conflicted/,
      );
    });
  });

  describe('offsets for a root-only winner', () => {
    it('takes them from another record for the same root', async () => {
      const band = await build([
        row(1, 11, 400, { source: 'bundler', rank: 1, offset: null }),
        row(1, 11, 500, { source: 'gw1', size: 600 }),
        row(2, 21, 1000, { folded: true, offset: null }),
        row(2, 21, 900, { source: 'gw1' }),
      ]);
      assert.equal(band.filledOffsets, 2);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
      assert.equal(await offsetOf(band, 1), 1000);
      const one = await lookup(band, 1);
      assert.ok(one !== undefined);
      assert.equal(getDataItemSize(one), 600);
      assert.equal(await offsetOf(band, 2), 1000);
      assert.equal(band.rootOnly, 0);
    });

    it("never takes another root's offsets", async () => {
      const band = await build([
        row(1, 11, 400, { source: 'bundler', rank: 1, offset: null }),
        row(1, 12, 500, { source: 'gw1' }),
      ]);
      assert.equal(band.filledOffsets, 0);
      assert.equal(band.rootOnly, 1);
      assert.ok((await rootOf(band, 1)).equals(id32(11)));
    });
  });

  describe('counts', () => {
    it('counts IDs a source gave twice, and roots settled by the tie-break', async () => {
      const band = await build([
        row(1, 11, 400, { source: 'gw1' }),
        row(1, 12, 500, { source: 'gw1' }),
        row(2, 21, 500, { source: 'gw1' }),
        row(2, 22, 500, { source: 'gw2' }),
        row(3, 31, 500, { source: 'gw1' }),
        row(3, 31, 500, { source: 'gw2' }),
      ]);
      assert.equal(band.sameSourceDuplicates, 1);
      assert.equal(band.rootTies, 1);
      assert.equal(band.conflicts, 0);
    });
  });

  describe('samples', () => {
    const many = (
      from: number,
      count: number,
      more: Parameters<typeof row>[3] = {},
    ): BandRecord[] =>
      Array.from({ length: count }, (_, i) =>
        row(from + i, 1, 500, { offset: 1000 + i * 1000, ...more }),
      );

    it('samples each tag apart, up to its size', async () => {
      const band = await build(
        [
          ...many(1000, 30),
          ...many(2000, 30, { sampleTag: 'repaired' }),
          ...many(3000, 30, { sampleTag: 'unlisted' }),
        ],
        { sampleSize: 10, sampleSizes: { repaired: 4 } },
      );
      const repaired = band.sample.filter((e) => e.tag === 'repaired');
      const general = band.sample.filter((e) => e.tag === undefined);
      assert.equal(repaired.length, 4);
      assert.equal(general.length, 10);
      assert.equal(band.sample.length, 14);
      // General first, then the tags.
      assert.equal(band.sample[0].tag, undefined);
      const repairedIds = new Set(many(2000, 30).map((r) => toB64Url(r.id)));
      for (const entry of repaired) assert.ok(repairedIds.has(entry.id));
    });

    it('samples no root-only entry under any tag', async () => {
      const band = await build(
        [
          ...many(1000, 5, { sampleTag: 'repaired', offset: null }),
          ...many(2000, 5, { offset: null }),
          row(3000, 1, 500),
        ],
        { sampleSizes: { repaired: 10 } },
      );
      assert.equal(band.sample.length, 1);
    });

    it('tags an overlay row that changed a peer root or offsets', async () => {
      const band = await build(
        [
          // Another root.
          row(1, 11, 500, { source: 'gw1' }),
          row(1, 12, 400, { source: 'bundler', rank: 1 }),
          // Other offsets.
          row(2, 21, 500, { source: 'gw1', offset: 1000 }),
          row(2, 21, 500, { source: 'bundler', rank: 1, offset: 2000 }),
          // Offsets where the peer had none.
          row(3, 31, 500, { source: 'gw1', offset: null }),
          row(3, 31, 500, { source: 'bundler', rank: 1 }),
          // Agreeing, at another height and size: not a change.
          row(4, 41, 500, { source: 'gw1', size: 600 }),
          row(4, 41, 300, { source: 'bundler', rank: 1, size: 700 }),
          // Alone: nothing to change.
          row(5, 51, 500, { source: 'bundler', rank: 1 }),
          // Over a folded entry.
          row(6, 61, 900, { folded: true }),
          row(6, 62, 400, { source: 'bundler', rank: 1 }),
        ],
        { sampleSizes: { [OVERLAY_CHANGED_TAG]: 50, repaired: 50 } },
      );
      const changed = band.sample
        .filter((e) => e.tag === OVERLAY_CHANGED_TAG)
        .map((e) => e.id)
        .sort();
      assert.deepEqual(
        changed,
        [1, 2, 3, 6].map((s) => toB64Url(id32(s))).sort(),
      );
    });

    it('compares an overlay only with the record that would have won', async () => {
      // gw1's later row would have won without the overlay, and the overlay
      // agrees with it; gw2's stale row is no change.
      const band = await build(
        [
          row(1, 11, 500, { source: 'gw1' }),
          row(1, 12, 300, { source: 'gw2', offset: 9000 }),
          row(1, 11, 450, { source: 'bundler', rank: 1 }),
        ],
        { sampleSizes: { [OVERLAY_CHANGED_TAG]: 10 } },
      );
      assert.equal(band.overlayChanged, 0);
      assert.equal(band.sample[0].tag, undefined);
    });

    it('counts overlay changes', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1' }),
        row(1, 12, 400, { source: 'bundler', rank: 1 }),
      ]);
      assert.equal(band.overlayChanged, 1);
    });

    it('puts overlay changes in the general sample unless asked for', async () => {
      const band = await build([
        row(1, 11, 500, { source: 'gw1' }),
        row(1, 12, 400, { source: 'bundler', rank: 1 }),
      ]);
      assert.equal(band.sample.length, 1);
      assert.equal(band.sample[0].tag, undefined);
    });

    it('rejects invalid sample sizes', async () => {
      await assert.rejects(
        build([filler], { sampleSizes: { repaired: -1 } }),
        /sampleSizes/,
      );
      await assert.rejects(
        build([filler], { sampleSizes: { '': 1 } }),
        /sampleSizes/,
      );
      await assert.rejects(
        build([filler], { sampleSizes: { repaired: 0 } }),
        /positive/,
      );
    });
  });

  describe('invalid records', () => {
    it('refuses a rank other than 0 or 1', async () => {
      await assert.rejects(
        build([{ ...filler, rank: 2 as 0 }]),
        /rank must be 0 or 1, not 2/,
      );
    });

    it('refuses coverage on a non-overlay record, or a height outside it', async () => {
      await assert.rejects(
        build([{ ...filler, coverageTo: 500 }]),
        /coverageTo is for rank-1 records/,
      );
      await assert.rejects(
        build([{ ...filler, rank: 1, height: 600, coverageTo: 500 }]),
        /outside its coverage/,
      );
      await assert.rejects(
        build([{ ...filler, rank: 1, height: undefined, coverageTo: 500 }]),
        /outside its coverage/,
      );
    });

    it("refuses the build's own sample tag on a record", async () => {
      await assert.rejects(
        build([{ ...filler, sampleTag: OVERLAY_CHANGED_TAG }]),
        /is the build's own/,
      );
    });

    it('refuses a folded record without a height', async () => {
      await assert.rejects(
        build([{ id: id32(1), rootTxId: id32(2), folded: true }]),
        /a folded record needs the height of its band/,
      );
    });
  });

  describe('readBandRecords', () => {
    it('reads a band back as folded records at the given height', async () => {
      const records = [
        row(1, 11, 500, { size: 600 }),
        row(2, 21, 600),
        row(3, 31, 700, { offset: null }),
      ];
      const band = await build(records);
      assert.ok(band.dir !== undefined);

      const { records: read, stats } = await openBandRecords(band.dir, 1234);
      const back: BandRecord[] = [];
      for await (const record of read) back.push(record);

      assert.equal(stats.records, 3);
      assert.equal(stats.pathSkipped, 0);
      const bySeed = (seed: number) =>
        back.find((r) => r.id.equals(id32(seed)));
      for (const record of back) {
        assert.equal(record.folded, true);
        assert.equal(record.height, 1234);
        assert.equal(record.rank, undefined);
        assert.equal(record.source, undefined);
      }
      assert.deepEqual(
        { ...bySeed(1), id: undefined },
        {
          id: undefined,
          rootTxId: id32(11),
          height: 1234,
          folded: true,
          rootOffset: 1000,
          rootDataOffset: 1100,
          size: 600,
        },
      );
      assert.equal(bySeed(2)?.size, undefined);
      assert.equal(bySeed(3)?.rootOffset, undefined);
      assert.ok(bySeed(3)?.rootTxId.equals(id32(31)));
    });

    it('rebuilds a band with the same content from its own records', async () => {
      const first = await build([
        row(1, 11, 500, { size: 600 }),
        row(2, 21, 600),
        row(3, 31, 700, { offset: null }),
      ]);
      assert.ok(first.dir !== undefined);
      const again = await build([], {
        records: (await openBandRecords(first.dir, 700)).records,
      });
      assert.equal(again.contentDigest, first.contentDigest);
    });

    it('folds an earlier band under a newer peer row', async () => {
      const old = await build([row(1, 11, 500), row(2, 21, 500)]);
      assert.ok(old.dir !== undefined);
      const folded: BandRecord[] = [];
      for await (const record of (await openBandRecords(old.dir, 500))
        .records) {
        folded.push(record);
      }
      const band = await build([
        ...folded,
        row(1, 12, 501, { source: 'gw1' }),
        row(2, 22, 499, { source: 'gw1' }),
      ]);
      assert.ok((await rootOf(band, 1)).equals(id32(12)));
      assert.ok((await rootOf(band, 2)).equals(id32(21)));
    });

    it('skips and counts path values, which bands never hold', async () => {
      // A band written by hand: buildBand can't write paths.
      const dir = path.join(root, 'hand-made');
      await fs.mkdir(dir, { recursive: true });
      const prefix = indexToPrefix(0);
      const key = (n: number) => {
        const k = Buffer.alloc(32, n);
        k[0] = 0;
        return k;
      };
      const writer = new Cdb64Writer(path.join(dir, `${prefix}.cdb`));
      await writer.open();
      await writer.add(key(1), encodeCdb64Value({ rootTxId: id32(11) }));
      await writer.add(key(2), encodeCdb64Value({ path: [id32(21)] }));
      await writer.add(
        key(3),
        encodeCdb64Value({
          path: [id32(31), id32(32)],
          rootDataItemOffset: 10,
          rootDataOffset: 20,
        }),
      );
      await writer.finalize();
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        serializeManifest({
          version: 1,
          createdAt: new Date().toISOString(),
          totalRecords: 3,
          metadata: { heightRange: [0, null] },
          partitions: [
            {
              prefix,
              location: { type: 'file', filename: `${prefix}.cdb` },
              recordCount: 3,
              size: (await fs.stat(path.join(dir, `${prefix}.cdb`))).size,
            },
          ],
        }),
      );

      const { records, stats } = await openBandRecords(dir, 10);
      const back: BandRecord[] = [];
      for await (const record of records) back.push(record);
      assert.equal(back.length, 1);
      assert.ok(back[0].rootTxId.equals(id32(11)));
      assert.deepEqual(stats, { records: 1, pathSkipped: 2 });
    });

    it('refuses an invalid height', async () => {
      await assert.rejects(openBandRecords(root, -1), /non-negative integer/);
      await assert.rejects(openBandRecords(root, 1.5), /non-negative integer/);
    });

    it('refuses a height other than a closed band top', async () => {
      const band = await build([row(1, 11, 500)], { heightRange: [100, 900] });
      assert.ok(band.dir !== undefined);
      await assert.rejects(
        openBandRecords(band.dir, 899),
        /at height 899: the band ends at 900/,
      );
      await assert.rejects(
        openBandRecords(band.dir, 901),
        /the band ends at 900/,
      );
      const { records, close } = await openBandRecords(band.dir, 900);
      assert.ok(records !== undefined);
      await close();
    });

    it('refuses a height below the start of a band open at the tip', async () => {
      const band = await build([row(1, 11, 500)], { heightRange: [100, null] });
      assert.ok(band.dir !== undefined);
      await assert.rejects(
        openBandRecords(band.dir, 99),
        /the band starts at 100/,
      );
    });

    it('reads a band whole even when it is deleted while being read', async () => {
      const band = await build(
        Array.from({ length: 50 }, (_, i) => row(i + 1, 11, 500)),
      );
      assert.ok(band.dir !== undefined);
      const { records, stats } = await openBandRecords(band.dir, 500);
      // The publisher retires the band before the fold reads it.
      await fs.rm(band.dir, { recursive: true, force: true });
      let count = 0;
      for await (const record of records) {
        void record;
        count += 1;
      }
      assert.equal(count, 50);
      assert.equal(stats.records, 50);
    });

    it('refuses a band holding fewer entries than its manifest says', async () => {
      const band = await build([row(1, 11, 500), row(2, 21, 500)]);
      assert.ok(band.dir !== undefined);
      const manifestPath = path.join(band.dir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.totalRecords = 3;
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      const { records } = await openBandRecords(band.dir, 500);
      await assert.rejects(async () => {
        for await (const record of records) void record;
      }, /read 2 entries, its manifest says 3/);
    });

    it('refuses a band without a heightRange', async () => {
      const band = await build([row(1, 11, 500)]);
      assert.ok(band.dir !== undefined);
      const manifestPath = path.join(band.dir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      delete manifest.metadata;
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await assert.rejects(openBandRecords(band.dir, 500), /no heightRange/);
    });

    it('refuses a manifest naming a file that is not a partition', async () => {
      const band = await build([row(1, 11, 500)]);
      assert.ok(band.dir !== undefined);
      const manifestPath = path.join(band.dir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.partitions[0].location.filename = '../../secret';
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        openBandRecords(band.dir, 500),
        /not a partition file/,
      );
    });
  });

  describe('header check over tagged samples', () => {
    it('reports wrong entries and counts per tag', async () => {
      const entries = [
        { id: 'a', rootTxId: 'r', rootOffset: 0, rootDataOffset: 10 },
        {
          id: 'b',
          rootTxId: 'r',
          rootOffset: 0,
          rootDataOffset: 10,
          tag: 'repaired',
        },
      ];
      // A root whose bytes are no data item header: every entry is wrong.
      const openRoot = (): ByteRangeSource =>
        ({
          read: async (_offset: number, size: number) => Buffer.alloc(size),
          close: async () => undefined,
        }) as unknown as ByteRangeSource;
      const result = await checkBandHeaders({
        entries,
        totalRecords: 5000,
        openRoot,
      });
      assert.deepEqual(result.byTag, {
        '': { checked: 1, ok: 0, wrong: 1 },
        repaired: { checked: 1, ok: 0, wrong: 1 },
      });
      assert.deepEqual(result.wrong.map((w) => [w.id, w.tag]).sort(), [
        ['a', undefined],
        ['b', 'repaired'],
      ]);
    });
  });
});
