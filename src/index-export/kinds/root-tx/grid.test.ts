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

import { createTestLogger } from '../../../../test/test-logger.js';
import { toB64Url } from '../../../lib/encoding.js';
import { BandRecord, buildBand } from '../../../lib/index-band/build.js';
import { readBandManifest } from '../../../lib/index-band/read.js';
import type { OwnBand } from '../../state.js';
import {
  diffBands,
  emptyPlacement,
  frozenLookup,
  placeSeedEntries,
  RESETTLE_ADDED_TAG,
  RESETTLE_CHANGED_TAG,
  RootHeights,
} from './grid.js';
import type { BuildStep } from './planner.js';

const log = createTestLogger({ suite: 'index-export grid' });
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

const id = (n: number) => Buffer.alloc(32, n);
const entry = (
  n: number,
  root: number,
  offsets: [number, number] | null = [n * 1000, n * 1000 + 100],
): BandRecord => ({
  id: id(n),
  rootTxId: Buffer.alloc(32, root),
  ...(offsets !== null
    ? { rootOffset: offsets[0], rootDataOffset: offsets[1] }
    : {}),
});

describe('grid band reads', () => {
  let dir: string;
  let n = 0;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-grid-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const band = async (
    records: BandRecord[],
    heightRange: [number, number | null],
    top = heightRange[1] ?? heightRange[0],
  ): Promise<OwnBand> => {
    n += 1;
    const built = await buildBand({
      log,
      records,
      publishDir: path.join(dir, 'published'),
      workDir: path.join(dir, 'work'),
      publisher: PUBLISHER,
      kind: `t${n}`,
      heightRange,
    });
    const bandDir = built.dir as string;
    return {
      id: built.id,
      dir: bandDir,
      role: heightRange[1] === null ? 'tip' : 'd',
      from: heightRange[0],
      to: heightRange[1],
      top,
      adopted: false,
      manifest: await readBandManifest(bandDir),
    };
  };

  describe('diffBands', () => {
    const diff = async (old: OwnBand, next: OwnBand, maxChanged = 10) =>
      diffBands(old, next, { maxChanged, addedSampleSize: 10 });

    it('counts what was added, changed, kept and lost', async () => {
      const old = await band(
        [entry(1, 9), entry(2, 9), entry(3, 9), entry(4, 9, null)],
        [100, 199],
      );
      const next = await band(
        [
          entry(1, 9),
          entry(2, 8), // another root
          entry(4, 9), // offsets found for a root-only entry
          entry(5, 9),
        ],
        [100, 199],
      );
      const result = await diff(old, next);
      assert.equal(result.oldEntries, 4);
      assert.equal(result.newEntries, 4);
      assert.equal(result.added, 1);
      assert.equal(result.changed, 2);
      assert.equal(result.unchanged, 1);
      assert.equal(result.removed, 1);
      assert.deepEqual(result.removedSample, [toB64Url(id(3))]);
      assert.equal(result.unverifiable, 0);
      assert.deepEqual(
        result.changedEntries.map((e) => [e.id, e.rootTxId, e.tag]).sort(),
        [
          [
            toB64Url(id(2)),
            toB64Url(Buffer.alloc(32, 8)),
            RESETTLE_CHANGED_TAG,
          ],
          [
            toB64Url(id(4)),
            toB64Url(Buffer.alloc(32, 9)),
            RESETTLE_CHANGED_TAG,
          ],
        ].sort(),
      );
      assert.deepEqual(result.addedSample, [
        {
          id: toB64Url(id(5)),
          rootTxId: toB64Url(Buffer.alloc(32, 9)),
          rootOffset: 5000,
          rootDataOffset: 5100,
          tag: RESETTLE_ADDED_TAG,
        },
      ]);
    });

    it('finds no change between bands of the same entries', async () => {
      const records = [entry(1, 9), entry(2, 9), entry(200, 9)];
      const result = await diff(
        await band(records, [100, 199]),
        await band([...records].reverse(), [100, 199]),
      );
      assert.deepEqual(
        [result.added, result.changed, result.removed, result.unchanged],
        [0, 0, 0, 3],
      );
    });

    it('marks a change to a root without offsets as unverifiable', async () => {
      const result = await diff(
        await band([entry(1, 9)], [100, 199]),
        await band([entry(1, 8, null)], [100, 199]),
      );
      assert.equal(result.changed, 1);
      assert.equal(result.unverifiable, 1);
      assert.deepEqual(result.unverifiableSample, [toB64Url(id(1))]);
      assert.deepEqual(result.changedEntries, []);
    });

    it('lists changed entries only up to the cap, counting them all', async () => {
      const old = await band(
        Array.from({ length: 6 }, (_, i) => entry(i + 1, 9)),
        [100, 199],
      );
      const next = await band(
        Array.from({ length: 6 }, (_, i) => entry(i + 1, 8)),
        [100, 199],
      );
      const result = await diff(old, next, 4);
      assert.equal(result.changed, 6);
      assert.equal(result.changedEntries.length, 4);
    });
  });

  describe('RootHeights and placeSeedEntries', () => {
    it("places each seed entry by its root's height, and keeps the rest out of a freeze", async () => {
      const seed = await band(
        [entry(1, 1), entry(2, 1), entry(3, 2), entry(4, 3)],
        [100, null],
      );
      const heights = await RootHeights.of([seed]);
      heights.note(Buffer.alloc(32, 1), 150);
      heights.note(Buffer.alloc(32, 2), 260);
      heights.note(Buffer.alloc(32, 7), 120); // not a seed's root
      assert.deepEqual(heights.counts, { roots: 3, placed: 2 });
      assert.equal(heights.get(Buffer.alloc(32, 7)), undefined);

      const freeze = { heightRange: [100, 199], seeds: [seed] } as BuildStep;
      const placement = emptyPlacement();
      const placed: BandRecord[] = [];
      for await (const record of placeSeedEntries(
        freeze,
        { rootHeights: heights },
        placement,
      )) {
        placed.push(record);
      }
      assert.deepEqual(
        placed.map((r) => [r.id[0], r.height, r.folded]),
        [
          [1, 150, true],
          [2, 150, true],
        ],
      );
      assert.equal(placement.placed, 2);
    });

    it('keeps every tip entry but those a frozen band below the tip holds', async () => {
      const frozen = await band([entry(1, 1)], [100, 199]);
      const seed = await band(
        [entry(1, 1), entry(2, 1), entry(3, 2), entry(4, 3)],
        [100, null],
        120,
      );
      const heights = await RootHeights.of([seed]);
      heights.note(Buffer.alloc(32, 1), 150);
      heights.note(Buffer.alloc(32, 2), 260);
      const lookup = frozenLookup([frozen], log);
      const tip = { heightRange: [200, null], seeds: [seed] } as BuildStep;
      const placement = emptyPlacement();
      const kept: BandRecord[] = [];
      try {
        for await (const record of placeSeedEntries(
          tip,
          { rootHeights: heights, frozenHolds: lookup.holds },
          placement,
        )) {
          kept.push(record);
        }
      } finally {
        await lookup.close();
      }
      assert.deepEqual(
        kept.map((r) => [r.id[0], r.height]),
        [
          [2, 150], // below the tip, but the frozen band lacks it
          [3, 260],
          [4, 120], // no height: at its seed's top
        ],
      );
      assert.deepEqual(placement, {
        placed: 0,
        settled: 1,
        carried: 1,
        unresolved: 1,
      });
    });
  });
});
