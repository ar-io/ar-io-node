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
  checkParquetFile,
  checkParquetStructure,
  openFooterReader,
} from '../../lib/parquet/check.js';
import type { ColumnSpec } from '../../lib/parquet/check.js';
import {
  BAND_FILE,
  bandFiles,
  PARQUET_L1_LOOKUPS,
  PARQUET_L1_TABLES,
} from '../../lib/parquet-l1/layout.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { ParquetL1Kind } from './parquet-l1.js';

const log = createTestLogger({ suite: 'ParquetL1Kind' });

/** Writes `rows` rows of a table or lookup, every column null, in the layout's types. */
async function writeTable(
  file: string,
  table: { columns: ColumnSpec[] },
  rows: number,
  override: Record<string, string> = {},
): Promise<void> {
  const db = await openFooterReader();
  try {
    const columns = table.columns
      .map((c) => `CAST(NULL AS ${override[c.name] ?? c.type}) AS "${c.name}"`)
      .join(', ');
    await db.exec(
      `COPY (SELECT ${columns} FROM range(${rows})) TO '${file}' (FORMAT PARQUET)`,
    );
  } finally {
    await db.close();
  }
}

describe('ParquetL1Kind', () => {
  let root: string;
  let band: string;
  const kind = new ParquetL1Kind({ log });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l1-'));
    band = path.join(root, 'l1-h0-99999-abc');
    await fs.mkdir(band);
    for (const table of PARQUET_L1_TABLES) {
      await writeTable(path.join(band, table.file), table, 3);
    }
    // An l1-2 band: tables, no lookups. The l1-3 tests add them.
    await fs.writeFile(
      path.join(band, BAND_FILE),
      JSON.stringify({
        version: 1,
        schema: 'l1-2',
        heightRange: [0, 99_999],
        tables: Object.fromEntries(
          PARQUET_L1_TABLES.map((t) => [
            t.name,
            { rows: 3, rowDigest: 'b'.repeat(64) },
          ]),
        ),
        supersedes: ['l1-h0-99999-old'],
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('describes a band: its files, heights, rows and what it supersedes', async () => {
    const descriptor = await kind.describe(band);
    assert.equal(descriptor.id, 'l1-h0-99999-abc');
    assert.deepEqual(descriptor.heightRange, [0, 99_999]);
    assert.equal(descriptor.records, 3);
    assert.deepEqual(
      descriptor.files.map((f) => f.name),
      bandFiles('l1-2'),
    );
    assert.ok(descriptor.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.deepEqual(descriptor.metadata, {
      schema: 'l1-2',
      supersedes: ['l1-h0-99999-old'],
    });
  });

  it('validates a band of the layout', async () => {
    await kind.validate(await kind.describe(band), band);
  });

  it('refuses another file set, a missing file or a size the publication didn’t sign', async () => {
    const descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate(
        {
          ...descriptor,
          files: [
            ...descriptor.files,
            { name: 'extra.bin', size: 1, sha256: 'c'.repeat(64) },
          ],
        },
        band,
      ),
      /not Parquet L1 files/,
    );
    await fs.rm(path.join(band, 'tags.parquet'));
    await assert.rejects(
      kind.validate(descriptor, band),
      /missing tags\.parquet/,
    );
    await writeTable(
      path.join(band, 'tags.parquet'),
      PARQUET_L1_TABLES[3],
      5000,
    );
    await assert.rejects(
      kind.validate(descriptor, band),
      /bytes, the publication says/,
    );
  });

  it('refuses heights the publication and the band file disagree on', async () => {
    const descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate({ ...descriptor, heightRange: [0, 5] }, band),
      /the publication says heights/,
    );
  });

  it('refuses heights off the fixed grids, or an id that doesn’t name them', async () => {
    const descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate({ ...descriptor, id: 'l1-h0-5-abc' }, band),
      /doesn't name its heights \[0, 99999\]/,
    );
    const file = path.join(band, BAND_FILE);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const range of [
      [5, 99_999], // not on a boundary
      [100_000, 149_999], // neither a whole range nor a sub-range
      [100_000, 105_000], // past the end of its sub-range
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...json, heightRange: range }));
      await assert.rejects(
        kind.validate(await kind.describe(band), band),
        /are not a whole 100000-height range, a whole 5000-height sub-range, or a sub-range cut short/,
      );
    }
    // A whole sub-range and a tip are both fine.
    for (const range of [
      [100_000, 104_999],
      [100_000, 100_003],
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...json, heightRange: range }));
      const d = await kind.describe(band);
      await kind.validate(
        { ...d, id: `l1-h${range[0]}-${range[1]}-abc` },
        band,
      );
    }
  });

  it('refuses a column of another type, or a row count the band file doesn’t say', async () => {
    const blocks = PARQUET_L1_TABLES[0];
    await writeTable(path.join(band, blocks.file), blocks, 3, {
      height: 'VARCHAR',
    });
    await assert.rejects(
      kind.validate(await kind.describe(band), band),
      /columns differ from the layout at 1: have "height VARCHAR", want "height UBIGINT"/,
    );
    await writeTable(path.join(band, blocks.file), blocks, 7);
    await assert.rejects(
      kind.validate(await kind.describe(band), band),
      /holds 7 rows, its band says 3/,
    );
  });

  it('refuses a file that isn’t Parquet before DuckDB reads it', async () => {
    const file = path.join(band, 'wallets.parquet');
    await fs.writeFile(file, Buffer.alloc(100, 1));
    await assert.rejects(checkParquetStructure(file), /no PAR1 magic/);
    await fs.writeFile(file, Buffer.from('PAR1'));
    await assert.rejects(checkParquetStructure(file), /too short/);
    // The magic at both ends, but a footer length past the file.
    const forged = Buffer.alloc(40);
    forged.write('PAR1', 0);
    forged.writeUInt32LE(1000, 32);
    forged.write('PAR1', 36);
    await fs.writeFile(file, forged);
    await assert.rejects(checkParquetStructure(file), /footer length 1000/);
    await assert.rejects(
      kind.validate(await kind.describe(band), band),
      /footer length 1000/,
    );
  });

  it('checks a file’s columns in order', async () => {
    const db = await openFooterReader();
    try {
      const wallets = PARQUET_L1_TABLES[4];
      await checkParquetFile(db, path.join(band, wallets.file), {
        columns: wallets.columns,
      });
      await assert.rejects(
        checkParquetFile(db, path.join(band, wallets.file), {
          columns: [...wallets.columns].reverse(),
        }),
        /columns differ from the layout at 0/,
      );
    } finally {
      await db.close();
    }
  });

  it('installs, retires and sweeps a band', async () => {
    const descriptor = await kind.describe(band);
    const target = path.join(root, 'installed', 'parquet-l1', descriptor.id);
    let installed = await kind.install({
      band: descriptor,
      sourceDir: band,
      targetDir: target,
      current: {},
    });
    assert.ok(installed[descriptor.id] !== undefined);
    assert.deepEqual((await fs.readdir(target)).sort(), bandFiles('l1-2'));
    installed = await kind.retire({
      bandId: descriptor.id,
      dir: target,
      current: installed,
    });
    await assert.rejects(fs.stat(path.join(target, BAND_FILE)));
    installed = await kind.sweepRetired({
      current: installed,
      dirFor: () => target,
      graceMs: 0,
    });
    assert.deepEqual(installed, {});
    await assert.rejects(fs.stat(target));
  });

  describe('an l1-3 band, with lookups', () => {
    /** Adds the lookups with `rows` rows each, and an l1-3 band.json naming `declared` rows. */
    const upgrade = async (rows = 4, declared = rows) => {
      for (const spec of PARQUET_L1_LOOKUPS) {
        await writeTable(path.join(band, spec.file), spec, rows);
      }
      const file = path.join(band, BAND_FILE);
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(
        file,
        JSON.stringify({
          ...json,
          schema: 'l1-3',
          lookups: Object.fromEntries(
            PARQUET_L1_LOOKUPS.map((l) => [
              l.name,
              { rows: declared, rowDigest: 'd'.repeat(64) },
            ]),
          ),
        }),
      );
    };

    it('describes and validates its lookups with its tables', async () => {
      await upgrade();
      const descriptor = await kind.describe(band);
      assert.deepEqual(
        descriptor.files.map((f) => f.name),
        bandFiles('l1-3'),
      );
      assert.equal((descriptor.metadata as any).schema, 'l1-3');
      await kind.validate(descriptor, band);
    });

    it('refuses an l1-3 band published without a lookup', async () => {
      await upgrade();
      const descriptor = await kind.describe(band);
      await assert.rejects(
        kind.validate(
          {
            ...descriptor,
            files: descriptor.files.filter(
              (f) => f.name !== 'lookup_tag.parquet',
            ),
          },
          band,
        ),
        /not the l1-3 files/,
      );
    });

    it('refuses a lookup whose rows its band.json does not say', async () => {
      await upgrade(4, 9);
      await assert.rejects(
        kind.validate(await kind.describe(band), band),
        /lookup_\w+\.parquet: holds 4 rows, its band says 9/,
      );
    });

    it('refuses a name no layout knows before reading anything', async () => {
      const descriptor = await kind.describe(band);
      await assert.rejects(
        kind.validate(
          {
            ...descriptor,
            files: [
              ...descriptor.files,
              { name: '../escape.parquet', size: 1, sha256: 'c'.repeat(64) },
            ],
          },
          band,
        ),
        /not Parquet L1 files/,
      );
    });

    it('leaves out a lookup file its l1-2 band.json does not name', async () => {
      // As a derive interrupted between moving the lookups in and replacing
      // band.json leaves it: the band is still the l1-2 band.
      await writeTable(
        path.join(band, PARQUET_L1_LOOKUPS[0].file),
        PARQUET_L1_LOOKUPS[0],
        4,
      );
      const descriptor = await kind.describe(band);
      assert.deepEqual(
        descriptor.files.map((f) => f.name),
        bandFiles('l1-2'),
      );
      await kind.validate(descriptor, band);
    });

    it('installs with its lookups', async () => {
      await upgrade();
      const descriptor = await kind.describe(band);
      const target = path.join(root, 'installed', 'parquet-l1', descriptor.id);
      await kind.install({
        band: descriptor,
        sourceDir: band,
        targetDir: target,
        current: {},
      });
      assert.deepEqual((await fs.readdir(target)).sort(), bandFiles('l1-3'));
    });
  });
});
