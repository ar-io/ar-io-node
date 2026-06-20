/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Connection, Database } from 'duckdb-async';

import { applyDuckDbResourcePragmas } from './parquet-exporter.js';

// Exercises the DuckDB resource-limit pragmas against a real in-memory DuckDB
// connection (the same engine the export worker uses). This is the guard for
// the OOM fix: without temp_directory + memory_limit, a large `COPY (... ORDER
// BY ...)` over an ultra-dense partition sorts entirely in memory and the
// worker is OOM-killed. We can't easily drive a full worker export here
// (it calls process.exit), so we verify the settings actually take effect.
describe('applyDuckDbResourcePragmas', () => {
  let db: Database;
  let connection: Connection;

  beforeEach(async () => {
    db = await Database.create(':memory:');
    connection = await db.connect();
  });

  afterEach(async () => {
    await connection.close();
    await db.close();
  });

  // `threads` reads back as a BigInt, which the duckdb-async JSON path can't
  // serialize, so cast everything to VARCHAR for uniform comparison.
  async function setting(key: string): Promise<string> {
    const rows = await connection.all(
      `SELECT current_setting('${key}')::VARCHAR AS v`,
    );
    return (rows[0] as { v: string }).v;
  }

  it('configures spill dir, memory budget, temp size, threads, and disables preserve_insertion_order', async () => {
    const defaultMemory = await setting('memory_limit');

    await applyDuckDbResourcePragmas(connection, {
      memoryLimit: '512MB',
      tempDirectory: '/tmp/parquet-export-test-spill',
      maxTempDirectorySize: '8GB',
      threads: 2,
    });

    assert.equal(
      await setting('temp_directory'),
      '/tmp/parquet-export-test-spill',
    );
    assert.equal(await setting('threads'), '2');
    assert.equal(await setting('preserve_insertion_order'), 'false');

    // memory_limit normalizes to a binary unit and must differ from the
    // engine default (which is a large fraction of host RAM).
    const memory = await setting('memory_limit');
    assert.notEqual(memory, defaultMemory);
    assert.match(memory, /MiB|GiB/);

    assert.match(await setting('max_temp_directory_size'), /MiB|GiB/);
  });

  it('leaves unspecified limits at their defaults', async () => {
    const defaultMemory = await setting('memory_limit');
    const defaultThreads = await setting('threads');

    await applyDuckDbResourcePragmas(connection, {
      tempDirectory: '/tmp/parquet-export-test-spill2',
    });

    assert.equal(await setting('memory_limit'), defaultMemory);
    assert.equal(await setting('threads'), defaultThreads);
    // preserve_insertion_order is always disabled regardless of which limits
    // are supplied (every export query carries an explicit ORDER BY).
    assert.equal(await setting('preserve_insertion_order'), 'false');
  });

  it('escapes single quotes in the temp directory path', async () => {
    const quotedPath = "/tmp/parquet's-export-test";
    await applyDuckDbResourcePragmas(connection, {
      tempDirectory: quotedPath,
    });
    assert.equal(await setting('temp_directory'), quotedPath);
  });
});
