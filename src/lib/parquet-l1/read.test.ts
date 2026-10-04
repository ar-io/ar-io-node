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
import { after, before, describe, it } from 'node:test';
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
