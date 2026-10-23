/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { exportL1Band } from '../src/index-export/kinds/parquet-l1/export.js';
import { l1BandId } from '../src/index-export/kinds/parquet-l1/kind.js';
import type { Database } from 'duckdb-async';

import {
  BAND_FILE,
  PARQUET_L1_TABLES,
  type ParquetL1Band,
  parseBandFile,
  serializeBandFile,
} from '../src/lib/parquet-l1/layout.js';
import { writeBandLookups } from '../src/lib/parquet-l1/lookups.js';
import { digestBandTable } from '../src/lib/parquet-l1/read.js';

/** The publisher test bands are named for. */
export const TEST_PUBLISHER = 'test-publisher-wallet';

/**
 * Exports each range of `coreDb` as a band into `bandsDir`, named by its
 * real id (`l1BandId`) as a publisher names it, with the real exporter, so
 * the bands are what a publisher of that `core.db` would publish.
 */
export async function exportBands(
  coreDb: string,
  bandsDir: string,
  ranges: Array<[number, number]>,
  publisher = TEST_PUBLISHER,
): Promise<Array<{ id: string; dir: string; band: ParquetL1Band }>> {
  const workDir = path.join(
    path.dirname(bandsDir),
    `.work-${path.basename(bandsDir)}`,
  );
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.mkdir(bandsDir, { recursive: true });
  const out = [];
  for (const [from, to] of ranges) {
    const result = await exportL1Band({
      coreDbPath: coreDb,
      workDir,
      from,
      to,
    });
    const id = l1BandId(result.band, publisher);
    const dir = path.join(bandsDir, id);
    await fsp.rename(result.dir, dir);
    await fsp.rm(path.dirname(result.dir), { recursive: true, force: true });
    out.push({ id, dir, band: result.band });
  }
  await fsp.rm(workDir, { recursive: true, force: true });
  return out;
}

/**
 * Rewrites a band's table with `select` over `SRC` (the table's rows),
 * keeping the layout's columns in order: a tampered copy.
 */
export async function rewriteTable(
  duck: Database,
  bandDir: string,
  table: string,
  select: string,
): Promise<void> {
  const spec = PARQUET_L1_TABLES.find((t) => t.name === table);
  if (spec === undefined) throw new Error(`no table ${table}`);
  const file = path.join(bandDir, spec.file);
  const cols = spec.columns.map((c) => `"${c.name}"`).join(', ');
  await duck.exec(
    `CREATE OR REPLACE TABLE src AS SELECT * FROM read_parquet('${file}')`,
  );
  await duck.exec(
    `COPY (SELECT ${cols} FROM (${select.replace(/\bSRC\b/g, 'src')})) TO '${file}.x' (FORMAT PARQUET)`,
  );
  await fsp.rename(`${file}.x`, file);
}

/**
 * Makes a tampered band self-consistent, as its publisher could: every
 * table's rows and digest in `band.json` recomputed, its lookups rebuilt
 * from its tables, and the directory renamed to the id those give. What is
 * left to catch it is the chain, not the band's own bookkeeping.
 *
 * @returns the band's new directory.
 */
export async function republish(
  duck: Database,
  bandDir: string,
  publisher = TEST_PUBLISHER,
): Promise<string> {
  const band = parseBandFile(
    await fsp.readFile(path.join(bandDir, BAND_FILE), 'utf8'),
  );
  for (const spec of PARQUET_L1_TABLES) {
    // Rewritten in the table's order first, as an exporter writes it.
    const file = path.join(bandDir, spec.file);
    const order = spec.orderBy.map((c) => `"${c}"`).join(', ');
    await duck.exec(
      `COPY (SELECT * FROM read_parquet('${file}') ORDER BY ${order}) TO '${file}.x' (FORMAT PARQUET)`,
    );
    await fsp.rename(`${file}.x`, file);
    const { rows, rowDigest } = await digestBandTable(duck, bandDir, spec);
    band.tables[spec.name] = { rows, rowDigest };
  }
  if (band.lookups !== undefined) {
    band.lookups = await writeBandLookups(duck, bandDir, bandDir);
  }
  await fsp.writeFile(path.join(bandDir, BAND_FILE), serializeBandFile(band));
  const dir = path.join(path.dirname(bandDir), l1BandId(band, publisher));
  if (dir !== bandDir) await fsp.rename(bandDir, dir);
  return dir;
}
