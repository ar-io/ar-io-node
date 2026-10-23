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
  witnessesOf,
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
 * from its tables, its witnesses re-sorted and described, and the
 * directory renamed to the id those give. What is left to catch it is the
 * chain, not the band's own bookkeeping.
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
  // Witnesses too, each in its order and described as it now is.
  for (const spec of witnessesOf(band.schema, band.heightRange)) {
    const file = path.join(bandDir, spec.file);
    const order = spec.orderBy.map((c) => `"${c}"`).join(', ');
    await duck.exec(
      `COPY (SELECT * FROM read_parquet('${file}') ORDER BY ${order}) TO '${file}.x' (FORMAT PARQUET)`,
    );
    await fsp.rename(`${file}.x`, file);
    const { rows, rowDigest } = await digestBandTable(duck, bandDir, spec);
    band.witnesses ??= {};
    band.witnesses[spec.name] = { rows, rowDigest };
  }
  await fsp.writeFile(path.join(bandDir, BAND_FILE), serializeBandFile(band));
  const dir = path.join(path.dirname(bandDir), l1BandId(band, publisher));
  if (dir !== bandDir) await fsp.rename(bandDir, dir);
  return dir;
}

/**
 * What the chain of `coreDb` (`buildCoreDb({ verifiable: true })`) fixes
 * for an `l1-4` band of heights `from` to `to` below the 2.0 fork: the v1
 * roots from the data its transactions sign, and, since the chain is not
 * mainnet's, its own pinned folds: `SHA-384(seedLabel)` below the band, and
 * the 2.0 seed fold from there through the band's top.
 */
export async function testChainWitnesses(
  coreDb: string,
  from: number,
  to: number,
  seedLabel = 'pre20',
): Promise<{
  roots: Map<string, Buffer>;
  pins: { fold: Map<number, Buffer>; h2: Map<number, Buffer> };
}> {
  const crypto = await import('node:crypto');
  const { default: Sqlite } = await import('better-sqlite3');
  const { computeTxRoot, foldBlockIndexEntry, foldH2, v1DataRoot } =
    await import('../src/lib/parquet-l1/chain.js');
  const { hash20Of10Block } = await import(
    '../src/lib/parquet-l1/block-hash.js'
  );
  const db = new Sqlite(coreDb, { readonly: true });
  const roots = new Map<string, Buffer>();
  const txsAt = new Map<
    number,
    Array<{ id: Buffer; format: number; data_size: number; data_root: null }>
  >();
  let fold = crypto.createHash('sha384').update(seedLabel).digest();
  let h2Fold = crypto.createHash('sha384').update(`${seedLabel}-h2`).digest();
  const pins = {
    fold: new Map<number, Buffer>([[from - 1, fold]]),
    h2: new Map<number, Buffer>([[from - 1, h2Fold]]),
  };
  try {
    for (const row of db
      .prepare(
        `SELECT t.id, t.height, t.format, t.data_size, s.data
         FROM stable_transactions t JOIN test_signatures s ON s.id = t.id
         WHERE t.height BETWEEN ? AND ?
         ORDER BY t.height, t.block_transaction_index`,
      )
      .all(from, to) as Array<{
      id: Buffer;
      height: number;
      format: number;
      data_size: number;
      data: Buffer | null;
    }>) {
      if (row.data !== null && row.data.length > 0) {
        roots.set(row.id.toString('base64url'), await v1DataRoot(row.data));
      }
      const list = txsAt.get(row.height) ?? [];
      list.push({
        id: row.id,
        format: row.format,
        data_size: row.data_size,
        data_root: null,
      });
      txsAt.set(row.height, list);
    }
    const links = db.prepare(
      'SELECT transaction_id FROM stable_block_transactions WHERE block_indep_hash = ?',
    );
    for (const block of db
      .prepare(
        'SELECT * FROM stable_blocks WHERE height BETWEEN ? AND ? ORDER BY height',
      )
      .all(from, to) as Array<Record<string, any>>) {
      const txRoot = (await computeTxRoot(
        block.height,
        txsAt.get(block.height) ?? [],
        roots,
      )) as Buffer;
      fold = foldBlockIndexEntry(fold, {
        indep_hash: block.indep_hash,
        weave_size: block.weave_size,
        tx_root: txRoot,
      });
      h2Fold = foldH2(
        h2Fold,
        hash20Of10Block(
          { ...block, height: block.height } as never,
          (
            links.all(block.indep_hash) as Array<{ transaction_id: Buffer }>
          ).map((l) => l.transaction_id),
          txRoot,
        ),
      );
    }
  } finally {
    db.close();
  }
  pins.fold.set(to, fold);
  pins.h2.set(to, h2Fold);
  return { roots, pins };
}

/**
 * Gives a test band below the 2.0 fork its `l1-4` witnesses, by the real
 * builder, as the chain of `coreDb` fixes them ({@link testChainWitnesses}),
 * and returns the chain's pinned folds for the verifier (`foldPins`).
 */
export async function witnessTestBand(
  duck: Database,
  coreDb: string,
  bandDir: string,
  seedLabel = 'pre20',
): Promise<{ fold: Map<number, Buffer>; h2: Map<number, Buffer> }> {
  const { buildBandWitnesses } = await import(
    '../src/lib/parquet-l1/witnesses.js'
  );
  const file = path.join(bandDir, BAND_FILE);
  const band = parseBandFile(await fsp.readFile(file, 'utf8'));
  const { roots, pins } = await testChainWitnesses(
    coreDb,
    band.heightRange[0],
    band.heightRange[1],
    seedLabel,
  );
  const built = await buildBandWitnesses(
    duck,
    bandDir,
    band,
    bandDir,
    { v1Roots: async () => roots },
    { foldPins: pins },
  );
  await fsp.writeFile(
    file,
    serializeBandFile({ ...band, schema: 'l1-4', witnesses: built.witnesses }),
  );
  return pins;
}
