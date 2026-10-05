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
import { after, afterEach, before, describe, it } from 'node:test';
import type { Database } from 'duckdb-async';

import { exportL1Band } from '../../index-export/kinds/parquet-l1/export.js';
import { buildCoreDb } from '../../../test/parquet-l1-core-db.js';
import { BandRowsError, IMPORT_ORDER, readTable } from './read.js';
import { ParquetL1Band, PARQUET_L1_TABLES, TableSpec } from './layout.js';

const FIRST = 1_900_000;
const spec = (name: string) =>
  PARQUET_L1_TABLES.find((t) => t.name === name) as TableSpec;

describe('readTable', () => {
  let dir: string;
  let bandDir: string;
  let band: ParquetL1Band;
  let duck: Database;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-read-'));
    const workDir = path.join(dir, 'work');
    await fs.mkdir(workDir);
    await buildCoreDb(path.join(dir, 'core.db'), FIRST, 30);
    const result = await exportL1Band({
      coreDbPath: path.join(dir, 'core.db'),
      workDir,
      from: FIRST,
      to: FIRST + 29,
    });
    bandDir = result.dir;
    band = result.band;
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
  });

  after(async () => {
    await duck?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const readAll = async (table: TableSpec, b = band, batchRows = 7) => {
    const rows: unknown[][] = [];
    const n = await readTable(
      duck,
      bandDir,
      table,
      b,
      async (batch) => {
        rows.push(...batch);
      },
      batchRows,
    );
    return { rows, n };
  };

  it('reads every table back, in batches, reproducing the digests the band claims', async () => {
    for (const table of IMPORT_ORDER) {
      const { rows, n } = await readAll(table);
      assert.equal(n, band.tables[table.name].rows, `${table.name} count`);
      assert.equal(rows.length, n, `${table.name} rows delivered`);
      assert.equal(
        rows[0]?.length,
        table.columns.length,
        `${table.name} column count`,
      );
    }
  });

  it('writes wallets before the rows that reference them, and blocks before their links', async () => {
    assert.deepEqual(
      IMPORT_ORDER.map((t) => t.name),
      ['wallets', 'blocks', 'transactions', 'block_transactions', 'tags'],
    );
  });

  it('refuses a row count the band does not claim', async () => {
    const lying = { ...band, tables: { ...band.tables } };
    lying.tables.blocks = { ...lying.tables.blocks, rows: 29 };
    await assert.rejects(
      readAll(spec('blocks'), lying),
      (e: Error) =>
        e instanceof BandRowsError && /more than the 29 rows/.test(e.message),
    );
  });

  it('refuses rows that do not reproduce the digest', async () => {
    const lying = { ...band, tables: { ...band.tables } };
    lying.tables.blocks = {
      ...lying.tables.blocks,
      rowDigest: 'f'.repeat(64),
    };
    await assert.rejects(
      readAll(spec('blocks'), lying),
      (e: Error) =>
        e instanceof BandRowsError &&
        /do not reproduce the digest/.test(e.message),
    );
  });

  it('refuses a table the band does not describe', async () => {
    const lying = { ...band, tables: { ...band.tables } };
    delete (lying.tables as Record<string, unknown>).tags;
    await assert.rejects(readAll(spec('tags'), lying), /is not described/);
  });

  /**
   * Rewrites one band file with a value changed, for the checks below. The
   * band is built once for the whole suite, so the original is kept and put
   * back afterwards: otherwise one test's damaged column is what the next
   * test reads, and a check fails for a reason that is not its own.
   */
  const rewritten = new Map<string, string>();
  const rewrite = async (table: string, expr: string) => {
    const file = path.join(bandDir, `${table}.parquet`);
    if (!rewritten.has(file)) {
      const keep = path.join(dir, `${table}.original.parquet`);
      await fs.copyFile(file, keep);
      rewritten.set(file, keep);
    }
    const copy = path.join(bandDir, `${table}.bad.parquet`);
    await duck.exec(
      `COPY (SELECT ${expr} FROM read_parquet('${file}')) TO '${copy}' (FORMAT PARQUET)`,
    );
    await fs.rename(copy, file);
  };

  afterEach(async () => {
    for (const [file, keep] of rewritten) await fs.copyFile(keep, file);
    rewritten.clear();
  });

  it('refuses a hash the chain fixes the width of', async () => {
    // Every column as it was, but one block's indep_hash cut short.
    const cols = spec('blocks')
      .columns.map((c) =>
        c.name === 'indep_hash'
          ? `CASE WHEN height = ${FIRST + 4} THEN '\\x0102'::BLOB ELSE indep_hash END AS indep_hash`
          : `"${c.name}"`,
      )
      .join(', ');
    await rewrite('blocks', cols);
    await assert.rejects(
      readAll(spec('blocks')),
      (e: Error) =>
        e instanceof BandRowsError &&
        /blocks\.indep_hash is \d+ bytes, not 48/.test(e.message),
    );
  });

  it('refuses an empty identifier, which would collapse a band into one row', async () => {
    // A blank id is not a short hash the old check let through by
    // accident: every one of the chain's 80M transaction ids is 32 bytes,
    // and a band of blank ones writes a single row over and over.
    const cols = spec('transactions')
      .columns.map((c) => (c.name === 'id' ? `''::BLOB AS id` : `"${c.name}"`))
      .join(', ');
    await rewrite('transactions', cols);
    await assert.rejects(
      readAll(spec('transactions')),
      (e: Error) =>
        e instanceof BandRowsError &&
        /transactions\.id is 0 bytes, not 32/.test(e.message),
    );
  });

  it('allows the empty previous_block the chain really does carry at genesis', async () => {
    const cols = spec('blocks')
      .columns.map((c) =>
        c.name === 'previous_block'
          ? `''::BLOB AS previous_block`
          : `"${c.name}"`,
      )
      .join(', ');
    await rewrite('blocks', cols);
    // The digest changes with the bytes, so the width check is what this
    // must get past; a digest complaint means the row was accepted.
    await assert.rejects(
      readAll(spec('blocks')),
      (e: Error) =>
        e instanceof BandRowsError &&
        /do not reproduce the digest/.test(e.message),
    );
  });

  it('refuses a previous_block that is neither 48 bytes nor empty', async () => {
    const cols = spec('blocks')
      .columns.map((c) =>
        c.name === 'previous_block'
          ? `'ab'::BLOB AS previous_block`
          : `"${c.name}"`,
      )
      .join(', ');
    await rewrite('blocks', cols);
    await assert.rejects(
      readAll(spec('blocks')),
      (e: Error) =>
        e instanceof BandRowsError &&
        /blocks\.previous_block is 2 bytes, not 48 or empty/.test(e.message),
    );
  });

  it('refuses a blob far larger than a band should carry', async () => {
    const big = "repeat('x', 20000)::BLOB";
    const cols = spec('tags')
      .columns.map((c) =>
        c.name === 'tag_value' ? `${big} AS tag_value` : `"${c.name}"`,
      )
      .join(', ');
    await rewrite('tags', cols);
    await assert.rejects(
      readAll(spec('tags')),
      (e: Error) =>
        e instanceof BandRowsError &&
        /tags.tag_value is 20000 bytes, over the/.test(e.message),
    );
  });

  it('refuses a height outside the band', async () => {
    const narrowed = {
      ...band,
      heightRange: [FIRST, FIRST + 5] as [number, number],
    };
    await assert.rejects(
      readAll(spec('blocks'), narrowed),
      (e: Error) =>
        e instanceof BandRowsError && /rows outside the band's/.test(e.message),
    );
  });
});
