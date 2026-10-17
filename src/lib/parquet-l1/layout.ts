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
 * From `l1-3` a band also carries lookup files ({@link PARQUET_L1_LOOKUPS}):
 * Parquet derived from its tables and sorted by a key, so a reader finds one
 * transaction, wallet or tag value without scanning the band. They are
 * declared here beside the tables, described in `band.json` like them, and
 * left out of the band's id, which covers only the tables' rows.
 *
 * The exporter that writes bands and the kind that checks them both read
 * this module, so the two cannot drift.
 */
import { FORK_2_0 } from './chain.js';
import { prefix64Sql, sha256_64Sql } from '../parquet/keys.js';
import {
  LookupDescription,
  LookupDigestOrder,
  LookupSpec,
  sqlPaths,
} from '../parquet/lookups.js';

/** The layout version a band is written with, in its `band.json`. */
export const PARQUET_L1_SCHEMA = 'l1-3';

/**
 * The layout whose rules the tables are written by. `l1-3` added lookups and
 * kept `l1-2`'s tables, so a band whose tables are current under `l1-2`
 * reaches `l1-3` by deriving its lookups, without rebuilding.
 */
export const PARQUET_L1_TABLE_RULES = 'l1-2';

/**
 * The versions a reader accepts, oldest first.
 *
 * `l1-1` copied three columns from `core.db` that the chain doesn't fix, so
 * two honest publishers wrote different rows; `l1-2` writes one canonical
 * value for each ({@link canonicalTxRoot}, {@link canonicalDataRoot},
 * {@link firstTagValue}). The first of them:
 *
 * `l1-1` wrote `blocks.tx_root` as `core.db` held it. Below the 2.0 fork
 * that field is not committed by the block hash and cannot be recomputed,
 * so a gateway keeps whatever its header source gave it, and the network
 * disagrees: of 346 pre-fork blocks compared between two publishers on
 * 2026-10-07, one side held 32 bytes and the other nothing, every time.
 * Two honest publishers could therefore never write identical pre-fork
 * bands, which defeats comparing their digests. `l1-2` writes one canonical
 * value instead ({@link canonicalTxRoot}).
 */
export const PARQUET_L1_SCHEMAS = ['l1-1', 'l1-2', 'l1-3'] as const;
export type ParquetL1Schema = (typeof PARQUET_L1_SCHEMAS)[number];

/**
 * What a band stores for a transaction's `data_root`: null for format 1.
 *
 * A format-1 header carries no `data_root` (a node returns `""`); one can be
 * computed from the data, and some gateways hold a computed root while
 * others hold nothing. Two publishers compared on 2026-10-08 disagreed on 352
 * format-1 transactions this way. Format 2 signs its `data_root`, so every
 * publisher holds the same one and it is kept, empty or not.
 */
export function canonicalDataRoot(
  format: number,
  dataRoot: Buffer | Uint8Array | null | undefined,
): Buffer | null {
  if (format === 1 || dataRoot === null || dataRoot === undefined) return null;
  return Buffer.isBuffer(dataRoot) ? dataRoot : Buffer.from(dataRoot);
}

/** One tag of a transaction, as a band stores it. */
export interface BandTag {
  index: number;
  name: Buffer;
  value: Buffer;
}

/**
 * The value of a transaction's first tag called `name`, by position, compared
 * without case, as UTF-8; null when there is none. How a band derives
 * `content_type` (`Content-Type`) and `content_encoding` (`Content-Encoding`)
 * from its own tags rather than copying whatever `core.db` holds.
 *
 * It is ar-io-node's rule since r70 (commit 40d5548e, 2026-02-14). Before
 * that the indexer kept the last match, so a gateway's stored value depends
 * on the release that indexed the row: 86 transactions with two
 * Content-Type tags differed between two publishers on 2026-10-08, though
 * their tags were identical.
 */
export function firstTagValue(tags: BandTag[], name: string): string | null {
  const wanted = name.toLowerCase();
  let best: BandTag | undefined;
  for (const tag of tags) {
    if (tag.name.toString('utf8').toLowerCase() !== wanted) continue;
    if (best === undefined || tag.index < best.index) best = tag;
  }
  return best === undefined ? null : best.value.toString('utf8');
}

/**
 * Whether a band's tables hold the rows this build would write: written
 * under the current table rules ({@link PARQUET_L1_TABLE_RULES}, which `l1-3`
 * shares), or rebuilt under them and found identical (`confirmed`, ids the
 * exporter recorded). An older band can't be judged without rebuilding it:
 * `l1-2`'s rules touch format-1 `data_root` and `content_type` at any height,
 * not only below the fork.
 *
 * A rebuild that produces the same rows produces the same id (the id comes
 * from the rows), so the old files stay as they are and only the
 * confirmation is new. Without it the planner would rebuild that band on
 * every run.
 */
export function tablesCurrent(
  schema: ParquetL1Schema,
  id: string,
  confirmed: ReadonlySet<string>,
): boolean {
  return schema === 'l1-2' || schema === 'l1-3' || confirmed.has(id);
}

/**
 * Whether a band carries the lookups the current layout declares. A band
 * whose tables are current but whose lookups are not is upgraded by deriving
 * them ({@link tablesCurrent}), never rebuilt.
 */
export function lookupsCurrent(schema: ParquetL1Schema): boolean {
  return schema === PARQUET_L1_SCHEMA;
}

/**
 * What a band stores for a block's `tx_root`: the stored bytes at and above
 * the 2.0 fork, and `null` below it, where the protocol has no such field
 * and gateways hold whatever their header source gave them — 32 bytes,
 * nothing, or the empty string this gateway writes.
 *
 * Only below the fork. From the fork up, empty bytes are the real value of
 * a block with no transactions, every publisher stores them the same way,
 * and a band keeps them as they are.
 *
 * This is why {@link PARQUET_L1_SCHEMA} is `l1-2`: the rows, and so the
 * digests, differ from `l1-1` for every band holding a pre-fork block.
 */
export function canonicalTxRoot(
  height: number,
  txRoot: Buffer | Uint8Array | string | null | undefined,
): Buffer | null {
  if (height < FORK_2_0) return null;
  if (txRoot === null || txRoot === undefined) return null;
  return Buffer.isBuffer(txRoot)
    ? txRoot
    : typeof txRoot === 'string'
      ? Buffer.from(txRoot, 'utf8')
      : Buffer.from(txRoot);
}

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
import crypto from 'node:crypto';

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

/**
 * The lookups an `l1-3` band carries, derived from its own tables. Each file
 * is sorted by its key in row groups of 16,384, so a reader finds a key by
 * reading the footer and one or two row groups. Keys use the encodings in
 * `src/lib/parquet/keys.ts`; a key is a pointer, confirmed against the bytes
 * it came from.
 */
export const PARQUET_L1_LOOKUPS: LookupSpec[] = [
  {
    // A transaction id's prefix, to the height its row is at.
    name: 'tx_id',
    file: 'lookup_tx_id.parquet',
    columns: [col('id8', 'UBIGINT'), col('height', 'UBIGINT')],
    orderBy: ['id8', 'height'],
    derive: (t) =>
      `SELECT ${prefix64Sql('id')} AS id8, height
       FROM read_parquet(${sqlPaths(t.transactions)})`,
  },
  {
    // An address's prefix, to every transaction it signed (role 0) or
    // received (role 1), with its height and size: a wallet's count, bytes
    // stored and first and last heights come from here alone.
    name: 'wallet',
    file: 'lookup_wallet.parquet',
    columns: [
      col('addr8', 'UBIGINT'),
      col('role', 'UTINYINT'),
      col('height', 'UBIGINT'),
      col('data_size', 'UBIGINT'),
    ],
    orderBy: ['addr8', 'height', 'role', 'data_size'],
    derive: (t) =>
      `SELECT ${prefix64Sql('owner_address')} AS addr8, 0::UTINYINT AS role, height, data_size
       FROM read_parquet(${sqlPaths(t.transactions)})
       WHERE owner_address IS NOT NULL
       UNION ALL
       SELECT ${prefix64Sql('target')} AS addr8, 1::UTINYINT AS role, height, data_size
       FROM read_parquet(${sqlPaths(t.transactions)})
       WHERE target IS NOT NULL AND octet_length(target) > 0`,
  },
  {
    // Every (name, value) tag pair, keyed by hashes of both: how many
    // transactions carry it, and the first and last height it appears at.
    // An exact count for any tag, and where to read its rows; a value used
    // once points at its block.
    name: 'tag',
    file: 'lookup_tag.parquet',
    columns: [
      col('name8', 'UBIGINT'),
      col('val8', 'UBIGINT'),
      col('name', 'BLOB'),
      col('value', 'BLOB'),
      col('txs', 'UBIGINT'),
      col('first_height', 'UBIGINT'),
      col('last_height', 'UBIGINT'),
    ],
    orderBy: ['name8', 'val8', 'name', 'value'],
    // Distinct transactions are counted in two grouping steps, not with
    // count(DISTINCT id): DuckDB 1.4.2's parallel hash aggregate can fail
    // combining a DISTINCT aggregate's thread states (an internal error, a
    // segfault in a release build), about 3 runs in 8 on the 1.9M band. The
    // rows are the same either way.
    derive: (t) =>
      `SELECT ${sha256_64Sql('tag_name')} AS name8, ${sha256_64Sql('tag_value')} AS val8,
              tag_name AS name, tag_value AS value,
              count(*)::UBIGINT AS txs,
              min(first_height) AS first_height, max(last_height) AS last_height
       FROM (SELECT tag_name, tag_value, id,
                    min(height) AS first_height, max(height) AS last_height
             FROM read_parquet(${sqlPaths(t.tags)})
             GROUP BY tag_name, tag_value, id)
       GROUP BY tag_name, tag_value`,
  },
];

/**
 * The order `l1-3` lookup digests are taken in: `legacy-text`. l1-3 lookup
 * digests use text order of 64-bit columns (`id8`, `addr8`, `height`,
 * `data_size`, …: `10` < `100` < `9`), though the files are sorted by
 * value, because the digest query ordered by its own text aliases of them.
 * Kept so every published `l1-3` band still verifies; a future schema moves
 * to `numeric`, the files' own order.
 */
export const PARQUET_L1_LOOKUP_DIGEST_ORDER: LookupDigestOrder = 'legacy-text';

/** The lookups a layout declares: none before `l1-3`. */
export function lookupsOf(schema: ParquetL1Schema): LookupSpec[] {
  return schema === 'l1-3' ? PARQUET_L1_LOOKUPS : [];
}

/**
 * What a band says about itself, in `band.json`.
 *
 * Only what its rows determine, so every publisher of the same rows writes
 * the same file ({@link serializeBandFile}), the same torrent, and so one
 * swarm. What is the publisher's own, which bands this one replaces and
 * when it was built, is kept beside the band in {@link PUBLISHER_FILE}.
 */
export interface ParquetL1Band {
  version: 1;
  /** The version this band was written with, not the one we write. */
  schema: ParquetL1Schema;
  /** The heights the band covers, both included. */
  heightRange: [number, number];
  /** Per table: rows, and a digest of the rows, independent of the Parquet bytes. */
  tables: Record<string, { rows: number; rowDigest: string }>;
  /**
   * Per lookup, from `l1-3`: rows, and a digest of the rows. Derived from the
   * tables, so not part of the band's id ({@link bandTablesDigest}).
   */
  lookups?: Record<string, LookupDescription>;
  /**
   * Ids of bands this one replaces. Only in a band written before band files
   * were made the same for every publisher: the ids carry the publisher's
   * tag. A publisher now keeps them in {@link PUBLISHER_FILE}, and the
   * signed publication carries them.
   */
  supersedes?: string[];
  /**
   * The time of the band's top block ({@link bandTime}), the same for every
   * publisher, and stable, so importing a band twice writes the same rows.
   * A band written before band files were made the same for every publisher
   * carries when it was built.
   */
  createdAt: string;
}

/**
 * Beside a band its publisher wrote, never part of it: no band file names
 * it, so it is not published, put in a torrent or served. What is the
 * publisher's own about the band, as {@link BandPublisherFacts}.
 */
export const PUBLISHER_FILE = '.publisher.json';

/** What only the band's publisher knows about it, in {@link PUBLISHER_FILE}. */
export interface BandPublisherFacts {
  /** Ids of this publisher's bands that this one replaces. */
  supersedes?: string[];
  /** When this publisher built it. */
  builtAt?: string;
  /**
   * Grid-built bands (`parquet-l2`): when the band was built, or confirmed,
   * with its heights settled (the settle lag below the sources' top). A band
   * without it is still rebuilt as its heights settle.
   */
  settledAt?: string;
  /**
   * `parquet-l2`: what the header check of the band's sample read, which
   * depends on the sample and the gateway, so is kept out of `band.json`.
   */
  headerCheck?: Record<string, number>;
  /**
   * `parquet-l2`: reads the gateway answered 404 for when the band was
   * built: ambiguous items left `proofs` unproven, owners left without a
   * key (`keys`). A band with any is rebuilt now and then, in case the
   * roots are served again.
   */
  unreadable?: Record<string, number>;
}

/** A band's `createdAt`: its top block's timestamp, in seconds, as a date. */
export function bandTime(topBlockTimestamp: number): string {
  if (!Number.isSafeInteger(topBlockTimestamp) || topBlockTimestamp < 0) {
    throw new Error(`not a block timestamp: ${topBlockTimestamp}`);
  }
  return new Date(topBlockTimestamp * 1000).toISOString();
}

/**
 * A band's `band.json`, written the one way: fields, tables and lookups in
 * the layout's order, and no `supersedes`, which is the publisher's own.
 * Two publishers of the same rows therefore write the same bytes.
 */
export function serializeBandFile(band: ParquetL1Band): string {
  const lookups = lookupsOf(band.schema);
  const canonical = {
    version: band.version,
    schema: band.schema,
    heightRange: [band.heightRange[0], band.heightRange[1]],
    tables: Object.fromEntries(
      PARQUET_L1_TABLES.map(({ name }) => [
        name,
        {
          rows: band.tables[name].rows,
          rowDigest: band.tables[name].rowDigest,
        },
      ]),
    ),
    ...(lookups.length > 0 && band.lookups !== undefined
      ? {
          lookups: Object.fromEntries(
            lookups.map(({ name }) => [
              name,
              {
                rows: band.lookups![name].rows,
                rowDigest: band.lookups![name].rowDigest,
              },
            ]),
          ),
        }
      : {}),
    createdAt: band.createdAt,
  };
  return JSON.stringify(canonical, null, 2);
}

/**
 * Parses {@link PUBLISHER_FILE}. It is this node's own, but checked all the
 * same: a malformed one is refused rather than half-read.
 *
 * @throws with a message naming what is wrong.
 */
export function parsePublisherFile(text: string): BandPublisherFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${PUBLISHER_FILE} is not JSON: ${(error as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${PUBLISHER_FILE} must be an object`);
  }
  const facts = raw as Record<string, unknown>;
  const out: BandPublisherFacts = {};
  if (facts.supersedes !== undefined) {
    if (
      !Array.isArray(facts.supersedes) ||
      !facts.supersedes.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error(
        `${PUBLISHER_FILE}: supersedes must be a list of band ids`,
      );
    }
    out.supersedes = facts.supersedes as string[];
  }
  if (facts.builtAt !== undefined) {
    if (
      typeof facts.builtAt !== 'string' ||
      Number.isNaN(Date.parse(facts.builtAt))
    ) {
      throw new Error(`${PUBLISHER_FILE}: builtAt must be a date`);
    }
    out.builtAt = facts.builtAt;
  }
  if (facts.settledAt !== undefined) {
    if (
      typeof facts.settledAt !== 'string' ||
      Number.isNaN(Date.parse(facts.settledAt))
    ) {
      throw new Error(`${PUBLISHER_FILE}: settledAt must be a date`);
    }
    out.settledAt = facts.settledAt;
  }
  for (const key of ['headerCheck', 'unreadable'] as const) {
    const value = facts[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((n) => typeof n === 'number')
    ) {
      throw new Error(`${PUBLISHER_FILE}: ${key} must be an object of numbers`);
    }
    out[key] = value as Record<string, number>;
  }
  return out;
}

/**
 * The publisher's facts kept beside a band, or undefined when there is no
 * {@link PUBLISHER_FILE} (a band written before it existed, or one a
 * subscriber installed).
 */
export async function readPublisherFacts(
  bandDir: string,
): Promise<BandPublisherFacts | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let text: string;
  try {
    text = await fs.readFile(path.join(bandDir, PUBLISHER_FILE), 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  return parsePublisherFile(text);
}

/** Writes {@link PUBLISHER_FILE} beside a band, replacing it by a rename. */
export async function writePublisherFacts(
  bandDir: string,
  facts: BandPublisherFacts,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = path.join(bandDir, PUBLISHER_FILE);
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(facts, null, 2));
  await fs.rename(temporary, file);
}

/**
 * The ids a band of this publisher's replaces: from {@link PUBLISHER_FILE},
 * else, for a band written before it existed, from the band's own file.
 * The one rule for the publication (the sidecar) and the exporter's view of
 * its live bands, so the two cannot disagree on what is retired.
 */
export async function bandSupersedes(found: {
  dir: string;
  band: ParquetL1Band;
}): Promise<string[] | undefined> {
  const facts = await readPublisherFacts(found.dir);
  return facts?.supersedes ?? found.band.supersedes;
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
  // Every version this build can read, so a subscriber keeps importing a
  // publisher that has not upgraded yet.
  if (!PARQUET_L1_SCHEMAS.includes(band.schema as ParquetL1Schema)) {
    throw new Error(
      `${BAND_FILE}: schema ${JSON.stringify(band.schema)} is not one of ` +
        PARQUET_L1_SCHEMAS.join(', '),
    );
  }
  const schema = band.schema as ParquetL1Schema;
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
  // Exactly the lookups the layout declares: none before `l1-3`.
  const expected = lookupsOf(schema);
  let parsedLookups: ParquetL1Band['lookups'];
  if (expected.length === 0) {
    if (band.lookups !== undefined) {
      throw new Error(`${BAND_FILE}: layout ${schema} has no lookups`);
    }
  } else {
    const lookups = band.lookups;
    if (
      typeof lookups !== 'object' ||
      lookups === null ||
      Array.isArray(lookups)
    ) {
      throw new Error(`${BAND_FILE}: layout ${schema} needs lookups`);
    }
    const names = new Set(expected.map((spec) => spec.name));
    for (const name of Object.keys(lookups)) {
      if (!names.has(name)) {
        throw new Error(`${BAND_FILE}: unknown lookup ${JSON.stringify(name)}`);
      }
    }
    parsedLookups = {};
    for (const { name } of expected) {
      const entry = (lookups as Record<string, unknown>)[name] as
        | Record<string, unknown>
        | undefined;
      if (
        entry === undefined ||
        !isHeight(entry.rows) ||
        typeof entry.rowDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.rowDigest)
      ) {
        throw new Error(
          `${BAND_FILE}: lookup ${name} needs rows and a 64-hex rowDigest`,
        );
      }
      parsedLookups[name] = { rows: entry.rows, rowDigest: entry.rowDigest };
    }
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
    schema,
    heightRange: [range[0], range[1]],
    tables: parsedTables,
    ...(parsedLookups !== undefined ? { lookups: parsedLookups } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    createdAt: band.createdAt,
  };
}

/**
 * Every file a band of a layout holds, sorted: its description, one Parquet
 * file per table, and one per lookup the layout declares. Publisher,
 * subscriber and verifier all take a band's files from here, by the layout
 * its `band.json` names.
 */
export function bandFiles(schema: ParquetL1Schema): string[] {
  return [
    BAND_FILE,
    ...PARQUET_L1_TABLES.map((table) => table.file),
    ...lookupsOf(schema).map((spec) => spec.file),
  ].sort();
}

/**
 * A digest of what a band holds: its heights, and every table's row count
 * and row digest. Independent of the Parquet bytes, so two publishers that
 * wrote the same rows agree on it. Lookups are left out: they are derived
 * from the tables, so adding or changing them never changes a band's id.
 *
 * Both the band's id ({@link l1BandId}) and the importer's ledger key are
 * taken from this, so a band cannot be recorded as imported under one
 * identity and served under another.
 */
export function bandTablesDigest(band: ParquetL1Band): Buffer {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(band.heightRange))
    .update(
      Object.keys(band.tables)
        .sort()
        .map((t) => `${t}:${band.tables[t].rows}:${band.tables[t].rowDigest}`)
        .join('\n'),
    )
    .digest();
}

/** A band directory that could be read: its band id, its path, and its description. */
export interface BandOnDisk {
  /** The band id: the directory's name without any installed generation. */
  id: string;
  dir: string;
  band: ParquetL1Band;
}

/**
 * The heights a band's id claims, or `undefined` if it is not a band id.
 * The id is whoever-published-it's, and it is the import ledger's key, so it
 * has to agree with the band it names.
 */
export function idHeightRange(id: string): [number, number] | undefined {
  const m = /^l1-h(\d{1,15})-(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{12}$/.exec(id);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Separates a band id from its generation in the name the index-swarm
 * sidecar installs a band under, `<band id>~<generation>`
 * (`GENERATION_SEPARATOR` in `src/index-swarm/subscriber.ts`). A band id
 * cannot contain it.
 */
export const INSTALLED_GENERATION_SEPARATOR = '~';

/**
 * Every band of a directory whose `band.json` could be read, once each.
 *
 * A directory is named by its band id as a publisher writes it, or
 * `<band id>~<generation>` as the index-swarm sidecar installs it; `id` is
 * the band id either way. While the sidecar replaces a band it holds two
 * generations of it for a while. Both have the same tables, since a band's
 * id is their digest, so only one is returned: one whose heights agree with
 * its id over one that does not (a copy that disagrees is no copy of that
 * band, and must not hide one that is), then the one changed last, the
 * replacement rather than the copy about to be retired.
 *
 * Shared by the publisher's view of what it has published and the
 * importer's view of what it may import, so the two cannot drift on what
 * counts as readable. A directory is passed over — never thrown on —
 * when it has no description, when the description is bigger than a
 * description should be, or when it does not parse: the directory holds
 * whatever a publisher and a subscriber left there, and one unreadable
 * band must not stop the rest being used.
 *
 * Callers add their own rules on top: the importer checks the name
 * against the heights inside, the publisher filters by publisher tag.
 */
export async function readBandDirectory(dir: string): Promise<BandOnDisk[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  type Candidate = BandOnDisk & { agrees: boolean; changedAt: number };
  const better = (a: Candidate, b: Candidate) =>
    a.agrees !== b.agrees ? a.agrees : a.changedAt > b.changedAt;
  const found = new Map<string, Candidate>();
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const bandDir = path.join(dir, name);
    const file = path.join(bandDir, BAND_FILE);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat === undefined || stat.size > MAX_BAND_FILE_BYTES) continue;
    let band: ParquetL1Band;
    try {
      band = parseBandFile(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const id = name.split(INSTALLED_GENERATION_SEPARATOR)[0];
    const named = idHeightRange(id);
    const candidate: Candidate = {
      id,
      dir: bandDir,
      band,
      agrees:
        named !== undefined &&
        named[0] === band.heightRange[0] &&
        named[1] === band.heightRange[1],
      // ctime, as the sidecar judges an installed copy's age: a rename into
      // place keeps a directory's mtime but not its ctime.
      changedAt: (await fs.stat(bandDir).catch(() => stat)).ctimeMs,
    };
    const held = found.get(id);
    if (held !== undefined && !better(candidate, held)) continue;
    found.set(id, candidate);
  }
  return [...found.values()].map((b) => ({
    id: b.id,
    dir: b.dir,
    band: b.band,
  }));
}
