/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The layout of a `parquet-l1` band: one height range of the Arweave base
 * layer (L1) in Parquet, for a new gateway to import instead of indexing the
 * chain block by block, and for apps to query in place.
 *
 * A superset of the Parquet exporter's layout (`src/workers/parquet-exporter.ts`):
 * the same table and column names, plus every column a SQLite `core.db` needs
 * that the exporter leaves out, plus `block_transactions` and `wallets`. Tags
 * are plaintext (`core.db` stores only hashes into its dictionaries), so a
 * band reads in place. Left out: `indexed_at` (when a gateway indexed a row,
 * so two publishers of the same chain would never write the same rows; an
 * importer sets its own) and `blocks.missing_tx_count` (an importer derives
 * gaps from the band itself). `signature` is kept, null where a gateway
 * doesn't store it, so a publisher that does writes different rows.
 *
 * Bands cover fixed height ranges ({@link l1RangeOf}), so every publisher
 * cuts the chain at the same heights.
 *
 * The exporter that writes bands and the kind that checks them both read
 * this module, so the two cannot drift.
 */

/** The layout version, in each band's `band.json`. */
export const PARQUET_L1_SCHEMA = 'l1-1';

/**
 * Bands cover two nested fixed grids, so every publisher cuts the chain at
 * the same heights. L1 is append-only: a finalised height's rows never
 * change, so a band that covers a completed range is written once and never
 * rebuilt. Only the tip — the one incomplete sub-range — is rebuilt as the
 * chain grows, and it is bounded by {@link L1_SUB_SPAN}.
 */
export const L1_SPAN = 100_000;
export const L1_SUB_SPAN = 5_000;

/** The history range a height falls in: `[n * L1_SPAN, …]`. */
export function l1RangeOf(height: number): [number, number] {
  const from = Math.floor(height / L1_SPAN) * L1_SPAN;
  return [from, from + L1_SPAN - 1];
}

/** The sub-range a height falls in, always inside one {@link l1RangeOf}. */
export function l1SubRangeOf(height: number): [number, number] {
  const from = Math.floor(height / L1_SUB_SPAN) * L1_SUB_SPAN;
  return [from, from + L1_SUB_SPAN - 1];
}

/**
 * Whether `[from, to]` is a range a band may cover: a whole history range, a
 * whole sub-range, or a tip (a sub-range cut short at the chain's top). A
 * publisher offering anything else isn't following this layout.
 */
export function isL1BandRange(from: number, to: number): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false;
  if (from < 0 || to < from) return false;
  const [rf, rt] = l1RangeOf(from);
  if (from === rf && to === rt) return true;
  const [sf, st] = l1SubRangeOf(from);
  return from === sf && to <= st;
}

/** The band description file, beside the Parquet files. */
export const BAND_FILE = 'band.json';

/** A band's description file is small; anything bigger is refused unread. */
export const MAX_BAND_FILE_BYTES = 64 * 1024;

export type { ColumnSpec } from '../parquet/check.js';
import type { ColumnSpec } from '../parquet/check.js';

export interface TableSpec {
  name: string;
  file: string;
  columns: ColumnSpec[];
  /** The order rows are written in, and digested in. */
  orderBy: string[];
}

const col = (name: string, type: string): ColumnSpec => ({ name, type });

export const PARQUET_L1_TABLES: TableSpec[] = [
  {
    name: 'blocks',
    file: 'blocks.parquet',
    orderBy: ['height'],
    columns: [
      // The exporter's columns.
      col('indep_hash', 'BLOB'),
      col('height', 'UBIGINT'),
      col('previous_block', 'BLOB'),
      col('nonce', 'BLOB'),
      col('hash', 'BLOB'),
      col('block_timestamp', 'BIGINT'),
      col('tx_count', 'INTEGER'),
      col('block_size', 'UBIGINT'),
      // The rest of `stable_blocks`.
      col('diff', 'VARCHAR'),
      col('cumulative_diff', 'VARCHAR'),
      col('last_retarget', 'BIGINT'),
      col('reward_addr', 'BLOB'),
      col('reward_pool', 'VARCHAR'),
      col('weave_size', 'UBIGINT'),
      col('usd_to_ar_rate_dividend', 'BIGINT'),
      col('usd_to_ar_rate_divisor', 'BIGINT'),
      col('scheduled_usd_to_ar_rate_dividend', 'BIGINT'),
      col('scheduled_usd_to_ar_rate_divisor', 'BIGINT'),
      col('hash_list_merkle', 'BLOB'),
      col('wallet_list', 'BLOB'),
      col('tx_root', 'BLOB'),
    ],
  },
  {
    name: 'block_transactions',
    file: 'block_transactions.parquet',
    // Keyed by height rather than the 48-byte block hash: the blocks table
    // maps one to the other, and this halves the table.
    orderBy: ['height', 'block_transaction_index'],
    columns: [
      col('height', 'UBIGINT'),
      col('block_transaction_index', 'USMALLINT'),
      col('transaction_id', 'BLOB'),
    ],
  },
  {
    name: 'transactions',
    file: 'transactions.parquet',
    orderBy: ['height', 'block_transaction_index'],
    columns: [
      // The exporter's columns that an L1 transaction has.
      col('id', 'BLOB'),
      col('block_transaction_index', 'USMALLINT'),
      col('is_data_item', 'BOOLEAN'),
      col('target', 'BLOB'),
      col('quantity', 'DECIMAL(20,0)'),
      col('reward', 'DECIMAL(20,0)'),
      col('anchor', 'BLOB'),
      col('data_size', 'UBIGINT'),
      col('content_type', 'VARCHAR'),
      col('format', 'UTINYINT'),
      col('height', 'UBIGINT'),
      col('owner_address', 'BLOB'),
      col('data_root', 'BLOB'),
      col('offset', 'UBIGINT'),
      // The rest of `stable_transactions`.
      col('content_encoding', 'VARCHAR'),
      col('tag_count', 'INTEGER'),
      // Null where the gateway doesn't keep signatures (the default). Where
      // it does, an importer can prove each transaction (its id is the
      // signature's SHA-256): the "full proof" option of DL-13.
      col('signature', 'BLOB'),
    ],
  },
  {
    name: 'tags',
    file: 'tags.parquet',
    orderBy: ['height', 'id', 'tag_index'],
    columns: [
      // The exporter's columns, names and values in plaintext.
      col('height', 'UBIGINT'),
      col('id', 'BLOB'),
      col('tag_index', 'USMALLINT'),
      col('tag_name', 'BLOB'),
      col('tag_value', 'BLOB'),
      col('is_data_item', 'BOOLEAN'),
    ],
  },
  {
    name: 'wallets',
    file: 'wallets.parquet',
    orderBy: ['address'],
    columns: [col('address', 'BLOB'), col('public_modulus', 'BLOB')],
  },
];

/** What a band says about itself, in `band.json`. */
export interface ParquetL1Band {
  version: 1;
  schema: typeof PARQUET_L1_SCHEMA;
  /** The heights the band covers, both included. */
  heightRange: [number, number];
  /** Per table: rows, and a digest of the rows, independent of the Parquet bytes. */
  tables: Record<string, { rows: number; rowDigest: string }>;
  /** Ids of bands this one replaces (a rebuilt tip band). */
  supersedes?: string[];
  /** When the band was built. */
  createdAt: string;
}

const isHeight = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Parses and checks a `band.json`. A publisher's file comes from anywhere, so
 * every field is checked, and every table of the layout must be described.
 *
 * @throws with a message naming what is wrong.
 */
export function parseBandFile(text: string): ParquetL1Band {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${BAND_FILE} is not JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${BAND_FILE} must be an object`);
  }
  const band = raw as Record<string, unknown>;
  if (band.version !== 1) throw new Error(`${BAND_FILE}: version must be 1`);
  if (band.schema !== PARQUET_L1_SCHEMA) {
    throw new Error(
      `${BAND_FILE}: schema ${JSON.stringify(band.schema)} is not ${PARQUET_L1_SCHEMA}`,
    );
  }
  const range = band.heightRange;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !isHeight(range[0]) ||
    !isHeight(range[1]) ||
    range[1] < range[0]
  ) {
    throw new Error(`${BAND_FILE}: heightRange must be [from, to], from <= to`);
  }
  if (
    typeof band.createdAt !== 'string' ||
    Number.isNaN(Date.parse(band.createdAt))
  ) {
    throw new Error(`${BAND_FILE}: createdAt must be a date`);
  }
  const tables = band.tables;
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    throw new Error(`${BAND_FILE}: tables must be an object`);
  }
  const described = tables as Record<string, unknown>;
  const names = new Set(PARQUET_L1_TABLES.map((table) => table.name));
  for (const name of Object.keys(described)) {
    if (!names.has(name)) {
      throw new Error(`${BAND_FILE}: unknown table ${JSON.stringify(name)}`);
    }
  }
  const parsedTables: ParquetL1Band['tables'] = {};
  for (const { name } of PARQUET_L1_TABLES) {
    const entry = described[name] as Record<string, unknown> | undefined;
    if (
      entry === undefined ||
      !isHeight(entry.rows) ||
      typeof entry.rowDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.rowDigest)
    ) {
      throw new Error(
        `${BAND_FILE}: table ${name} needs rows and a 64-hex rowDigest`,
      );
    }
    parsedTables[name] = { rows: entry.rows, rowDigest: entry.rowDigest };
  }
  let supersedes: string[] | undefined;
  if (band.supersedes !== undefined) {
    if (
      !Array.isArray(band.supersedes) ||
      !band.supersedes.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error(`${BAND_FILE}: supersedes must be a list of band ids`);
    }
    supersedes = band.supersedes as string[];
  }
  return {
    version: 1,
    schema: PARQUET_L1_SCHEMA,
    heightRange: [range[0], range[1]],
    tables: parsedTables,
    ...(supersedes !== undefined ? { supersedes } : {}),
    createdAt: band.createdAt,
  };
}

/** Every file a band holds: its description and one Parquet file per table. */
export const BAND_FILES = [
  BAND_FILE,
  ...PARQUET_L1_TABLES.map((table) => table.file),
].sort();
