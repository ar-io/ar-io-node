/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The shared setup of the index-export service's grid layout tests, split
 * across files so that none comes near the test runner's per-file timeout:
 * the root-TX service fixture, records on the 100,000/5,000 grid, and the
 * helpers that read what a run left published.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach } from 'node:test';

import type { ExportConfig } from '../src/index-export/config.js';
import { CsvOverlaySource } from '../src/index-export/kinds/root-tx/sources/csv.js';
import type { RecordSource } from '../src/index-export/kinds/root-tx/sources/rows.js';
import {
  deriveOwnBands,
  GRID_ROLES,
  OwnBand,
} from '../src/index-export/state.js';
import { fromB64Url, toB64Url } from '../src/lib/encoding.js';
import type { BandRecord } from '../src/lib/index-band/build.js';
import { bandEntries, readBandManifest } from '../src/lib/index-band/read.js';
import { PUBLISHER, useExportService } from './index-export-service-fixture.js';
import { createTestLogger } from './test-logger.js';

export const log = createTestLogger({ suite: 'index-export grid' });

/** One root per height, as on chain: a root is in one block. */
export const rootAt = (height: number) =>
  crypto.createHash('sha256').update(`root-${height}`).digest();

export const ids = (bands: OwnBand[]) => bands.map((band) => band.id);

export async function entryIds(band: { dir: string }): Promise<Set<string>> {
  const found = new Set<string>();
  const manifest = await readBandManifest(band.dir);
  for await (const { key } of bandEntries(band.dir, manifest)) {
    found.add(toB64Url(key));
  }
  return found;
}

/** Registers the suite's hooks, and returns its state and helpers. */
export function useGridService() {
  const ctx = useExportService();
  // A test may make some roots unreadable; the fixture keeps one reader.
  const readRoots = ctx.roots;
  afterEach(() => {
    ctx.roots = readRoots;
  });

  const grid = (more: Partial<ExportConfig> = {}): Partial<ExportConfig> => ({
    rootTxLayout: 'grid',
    settleBlocks: 100,
    resettleIntervalMs: 0,
    ...more,
  });
  const live = () =>
    deriveOwnBands(ctx.config().publishDir, PUBLISHER, {}, GRID_ROLES);
  const find = async (prefix: string) =>
    (await live()).find((band) => band.id.startsWith(prefix)) as OwnBand;
  const record = (i: number, height: number): BandRecord => {
    const item = ctx.items[i];
    return {
      id: fromB64Url(item.id),
      rootTxId: rootAt(height),
      height,
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
      size: item.dataItemSize,
    };
  };
  /** Every item id in some live band: what a subscriber relies on. */
  const assertAllHeld = async (expected: string[]) => {
    const held = new Set<string>();
    for (const band of await live()) {
      for (const id of await entryIds(band)) held.add(id);
    }
    const missing = expected.filter((id) => !held.has(id));
    assert.deepEqual(missing, [], 'every entry is in a live band');
  };

  /**
   * A: 500 items in h [0, 99999]; B and C: 300 in each of the d bands at
   * 100,000 and 105,000; D: 1,200 over the 100 heights above 110,000, the
   * tip at first; E: 1,000 above 115,000, beyond the sources at first.
   */
  const gridRecords = () => {
    ctx.records = ctx.items.map((_, i) =>
      record(
        i,
        i < 500
          ? 50_000 + i
          : i < 800
            ? 100_000 + (i % 300)
            : i < 1100
              ? 105_000 + (i % 300)
              : i < 2300
                ? 110_000 + (i % 100)
                : 115_000 + (i % 200),
      ),
    );
    ctx.gw1.top = 110_100;
  };
  const allIds = () => ctx.items.map((item) => item.id);
  const inBand = (from: number, to: number) =>
    ctx.records
      .filter((r) => (r.height ?? -1) >= from && (r.height ?? -1) <= to)
      .map((r) => toB64Url(r.id));

  /** An overlay directory relocating some of band C's entries. */
  const overlay = async (
    items: number[],
    place: (i: number) => { root: Buffer; from: number },
  ): Promise<RecordSource> => {
    const dir = path.join(ctx.dir, 'overlay');
    await fs.mkdir(dir, { recursive: true });
    const lines = items.map((i) => {
      const r = ctx.records[i];
      const { root, from } = place(i);
      const at = ctx.items[from];
      return `${toB64Url(r.id)},${toB64Url(root)},,${at.rootDataItemOffset},${at.rootDataOffset},${at.dataItemSize},${r.height}`;
    });
    await fs.writeFile(
      path.join(dir, '105000-109999.csv'),
      `${lines.join('\n')}\n`,
    );
    return new CsvOverlaySource('bundler', dir);
  };
  const withOverlay = (source: RecordSource) => () => [
    { source: ctx.gw1, optional: false },
    { source, optional: false },
  ];

  return {
    ctx,
    grid,
    live,
    find,
    record,
    assertAllHeld,
    gridRecords,
    allIds,
    inBand,
    overlay,
    withOverlay,
  };
}
