/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BAND_FILE,
  BAND_FILES,
  PARQUET_L1_SCHEMA,
  PARQUET_L1_TABLES,
  parseBandFile,
} from './layout.js';

const digest = 'a'.repeat(64);
const valid = () => ({
  version: 1,
  schema: PARQUET_L1_SCHEMA,
  heightRange: [0, 99_999],
  tables: Object.fromEntries(
    PARQUET_L1_TABLES.map((t) => [t.name, { rows: 5, rowDigest: digest }]),
  ),
  createdAt: '2026-10-02T00:00:00.000Z',
});

describe('parquet-l1 layout', () => {
  it('is a superset of the Parquet exporter’s columns', () => {
    const names = (table: string) =>
      PARQUET_L1_TABLES.find((t) => t.name === table)?.columns.map(
        (c) => c.name,
      ) ?? [];
    // The exporter's names (src/workers/parquet-exporter.ts), so tools that
    // read its files read these.
    for (const column of [
      'indep_hash',
      'height',
      'previous_block',
      'nonce',
      'hash',
      'block_timestamp',
      'tx_count',
      'block_size',
    ]) {
      assert.ok(names('blocks').includes(column), `blocks.${column}`);
    }
    for (const column of [
      'id',
      'height',
      'tag_index',
      'tag_name',
      'tag_value',
      'is_data_item',
    ]) {
      assert.ok(names('tags').includes(column), `tags.${column}`);
    }
    for (const column of [
      'id',
      'anchor',
      'owner_address',
      'data_root',
      'offset',
    ]) {
      assert.ok(
        names('transactions').includes(column),
        `transactions.${column}`,
      );
    }
  });

  it('names every file a band holds', () => {
    assert.deepEqual(BAND_FILES, [
      BAND_FILE,
      'block_transactions.parquet',
      'blocks.parquet',
      'tags.parquet',
      'transactions.parquet',
      'wallets.parquet',
    ]);
  });
});

describe('parseBandFile', () => {
  it('reads a valid band file', () => {
    const band = parseBandFile(
      JSON.stringify({ ...valid(), supersedes: ['l1-h0-99999-old'] }),
    );
    assert.deepEqual(band.heightRange, [0, 99_999]);
    assert.equal(band.tables.transactions.rows, 5);
    assert.deepEqual(band.supersedes, ['l1-h0-99999-old']);
  });

  it('refuses anything malformed, naming what', () => {
    const refuse = (change: (band: any) => void, pattern: RegExp) => {
      const band: any = valid();
      change(band);
      assert.throws(() => parseBandFile(JSON.stringify(band)), pattern);
    };
    assert.throws(() => parseBandFile('{'), /not JSON/);
    assert.throws(() => parseBandFile('[]'), /must be an object/);
    refuse((b) => (b.version = 2), /version must be 1/);
    refuse((b) => (b.schema = 'l1-0'), /schema "l1-0" is not/);
    refuse((b) => (b.heightRange = [5, 4]), /heightRange/);
    refuse((b) => (b.heightRange = [0, 1.5]), /heightRange/);
    refuse((b) => (b.heightRange = [-1, 4]), /heightRange/);
    refuse((b) => (b.createdAt = 'yesterday'), /createdAt/);
    refuse(
      (b) => (b.tables.extra = { rows: 1, rowDigest: digest }),
      /unknown table "extra"/,
    );
    refuse((b) => delete b.tables.wallets, /table wallets needs/);
    refuse((b) => (b.tables.blocks.rowDigest = 'xyz'), /table blocks needs/);
    refuse((b) => (b.tables.blocks.rows = -1), /table blocks needs/);
    refuse((b) => (b.supersedes = 'one'), /supersedes must be a list/);
    refuse((b) => (b.supersedes = ['']), /supersedes must be a list/);
  });
});
