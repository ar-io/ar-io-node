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
  checkParquetDir,
  checkParquetStructure,
  MAX_FOOTER_BYTES,
  ParquetStructureError,
} from './check.js';

/**
 * Writes a sparse file shaped like Parquet: `PAR1`, a hole, then a footer
 * length and `PAR1`. Only the ends are real, which is all the structural
 * check reads, so a multi-megabyte footer costs no disk.
 */
async function writeShell(file: string, footer: number): Promise<void> {
  const size = footer + 12;
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(Buffer.from('PAR1'), 0, 4, 0);
    const tail = Buffer.alloc(8);
    tail.writeUInt32LE(footer, 0);
    tail.write('PAR1', 4);
    await handle.write(tail, 0, 8, size - 8);
  } finally {
    await handle.close();
  }
}

describe('checkParquetStructure', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-check-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts the largest footer published so far', async () => {
    // ardrive-l2 band h1800000's tags.parquet: 518M rows in 4,204 row
    // groups. The 2 MiB limit refused it, so no subscriber could install it.
    const file = path.join(dir, 'tags.parquet');
    await writeShell(file, 2_433_870);
    await checkParquetStructure(file);
  });

  it('accepts a footer at the limit and refuses one past it', async () => {
    const file = path.join(dir, 'tags.parquet');
    await writeShell(file, MAX_FOOTER_BYTES);
    await checkParquetStructure(file);
    await writeShell(file, MAX_FOOTER_BYTES + 1);
    await assert.rejects(
      checkParquetStructure(file),
      new RegExp(
        `footer length ${MAX_FOOTER_BYTES + 1} is over the ${MAX_FOOTER_BYTES}-byte limit`,
      ),
    );
  });

  it('says a footer past the file does not fit, not that it is too long', async () => {
    const file = path.join(dir, 'tags.parquet');
    const forged = Buffer.alloc(40);
    forged.write('PAR1', 0);
    forged.writeUInt32LE(1000, 32);
    forged.write('PAR1', 36);
    await fs.writeFile(file, forged);
    await assert.rejects(
      checkParquetStructure(file),
      /footer length 1000 doesn't fit the file/,
    );
  });
});

describe('checkParquetDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-check-dir-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('checks every Parquet file and nothing else', async () => {
    await writeShell(path.join(dir, 'blocks.parquet'), 1024);
    await writeShell(path.join(dir, 'tags.parquet'), 2_433_870);
    // Not Parquet, and not checked.
    await fs.writeFile(path.join(dir, 'band.json'), '{}');
    await fs.writeFile(path.join(dir, '.publisher.json'), '{}');
    await checkParquetDir(dir);
  });

  it('throws a structure error for the file, and an I/O error as it is', async () => {
    // A publisher rejects a band over the first and retries the second.
    await writeShell(path.join(dir, 'tags.parquet'), MAX_FOOTER_BYTES + 1);
    await assert.rejects(checkParquetDir(dir), ParquetStructureError);
    const missing = path.join(dir, 'gone');
    await assert.rejects(
      checkParquetDir(missing),
      (error: Error) =>
        !(error instanceof ParquetStructureError) &&
        (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });

  it('refuses a band with one file over the limit, naming it', async () => {
    await writeShell(path.join(dir, 'blocks.parquet'), 1024);
    await writeShell(path.join(dir, 'tags.parquet'), MAX_FOOTER_BYTES + 1);
    await assert.rejects(
      checkParquetDir(dir),
      (error: Error) =>
        error.message.includes(path.join(dir, 'tags.parquet')) &&
        error.message.includes('over the'),
    );
  });
});
