/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The L2 import's ClickHouse target: turns one verified `parquet-l2` band
 * into a job in the Parquet exporter's layout, for `clickhouse-auto-import`
 * to load with the unchanged `clickhouse-import` (DL-23).
 *
 * A job is a directory:
 *
 * ```
 * <job>/job.json
 * <job>/written.parquet                       (id, height): what --forget removes
 * <job>/{blocks,transactions,tags}/data/height=<a>-<b>/*.parquet
 * ```
 *
 * assembled under `<jobs>/.partial/` and renamed into `<jobs>/queue/` only
 * when whole, so auto-import never sees half a job. Both are in the jobs
 * directory, so the rename never crosses a filesystem.
 *
 * What goes in, per item of the band:
 *
 * - **One placement.** A band holds a row per place an item sits; the
 *   gateway's own export writes one per id. The importer keeps a located
 *   place before an unlocated one, then the first in chain order (height,
 *   block index, `root_parent_offset`, `offset`): where the item first
 *   became permanent, and readable. An item no band locates is kept with
 *   zeros for its location (DL-22), which ClickHouse reads as unknown.
 * - **Only what ClickHouse lacks** (first writer wins, DL-22). Items held at
 *   the same key are left out, and their location and owner compared with
 *   the band's (`conflicting`); items held within {@link HELD_MARGIN_HEIGHTS}
 *   of the place chosen are left out too (`elsewhere`): the same item in
 *   another root, which the gateway unbundled itself.
 * - **Nothing above ClickHouse's top height** (`ceiling`). Below it the
 *   gateway has exported its own items already, so the check above is not
 *   racing the gateway's next export. The rest waits for a later run.
 *
 * The rows written carry the band's `createdAt` as `indexed_at`, as the L1
 * importer does, so writing the same band twice writes the same rows.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import type { ClickHouseHeld } from './clickhouse-held.js';
import { HELD_COLUMNS } from './clickhouse-held.js';
import { bandTablesDigest, type ParquetL2Band } from './layout.js';

/** Heights per partition: `clickhouse-auto-import`'s default interval. */
export const L2_IMPORT_PARTITION_HEIGHTS = 10_000;

/**
 * Heights either side of a window searched for the same item at another
 * height. The other placements M1 found were 2 and 6 blocks from the band's.
 * An item held further away is written anyway: a second true placement,
 * counted nowhere, never a changed row.
 */
export const HELD_MARGIN_HEIGHTS = 1_000;

export const JOB_FILE = 'job.json';
/** Where jobs wait to be loaded, and where they are assembled first. */
export const QUEUE_DIR = 'queue';
export const PARTIAL_DIR = '.partial';
export const WRITTEN_FILE = 'written.parquet';
export const JOB_KIND = 'parquet-l2-import';

/** A job directory's manifest, `job.json`. */
export interface L2ImportJob {
  version: 1;
  kind: typeof JOB_KIND;
  job: string;
  bandId: string;
  /** Hex of `bandTablesDigest`. */
  bandDigest: string;
  index: string;
  publisher: string;
  /** The band's `createdAt` in seconds: every row's `indexed_at`. */
  indexedAt: number;
  /** The heights this job covers: the band's, cut at the ceiling. */
  heightRange: [number, number];
  /** `height=<a>-<b>`, as `clickhouse-import --partition` takes them. */
  partitions: string[];
  counts: L2ImportCounts;
  /** Up to {@link CONFLICT_EXAMPLES} conflicting item ids, upper-case hex. */
  conflictExamples: string[];
  createdAt: string;
}

/** What {@link writeClickHouseJob} found, with or without a job to write. */
export interface L2ImportOutcome {
  /** Undefined when nothing was left to write. */
  job: L2ImportJob | undefined;
  /** The heights looked at: the band's, cut at the ceiling. */
  heightRange: [number, number];
  counts: L2ImportCounts;
  conflictExamples: string[];
}

/** Conflicting ids named in a job and its log line. */
export const CONFLICT_EXAMPLES = 5;

export interface L2ImportCounts {
  /** Rows of the band's `data_items`. */
  bandRows: number;
  /** Rows left out as another placement of an item kept once. */
  otherPlacements: number;
  /** Items whose place is above the ceiling: a later run's. */
  aboveCeiling: number;
  /** Items ClickHouse already holds at the same key. */
  present: number;
  /** Of those, held with a different location, root, parent, owner or size. */
  conflicting: number;
  /** Items ClickHouse holds near the place chosen, at another key. */
  elsewhere: number;
  /** Items written. */
  written: number;
  /** Of those, written without a location (zeros). */
  unlocated: number;
  tags: number;
  blocks: number;
}

/** One `stable_blocks` row as the exporter writes `blocks`. */
export interface L2ImportBlock {
  indepHash: Buffer;
  height: number;
  previousBlock: Buffer | null;
  nonce: Buffer;
  hash: Buffer;
  blockTimestamp: number;
  txCount: number;
  blockSize: number | null;
}

/** Where block rows come from: this gateway's L1 index. */
export interface L2ImportBlockSource {
  /** Every block the gateway holds from `from` to `to`. */
  blocks(from: number, to: number): Iterable<L2ImportBlock>;
}

/** The location and owner columns compared for `conflicting`. */
export const COMPARED_COLUMNS = HELD_COLUMNS.map((c) => c.name).filter(
  (c) => !['id', 'height', 'block_transaction_index'].includes(c),
);

export class L2ImportRefused extends Error {}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A band's partitions, cut at the ceiling, on the auto-import grid. */
export function importPartitions(
  heightRange: [number, number],
  ceiling: number,
  partitionHeights = L2_IMPORT_PARTITION_HEIGHTS,
): Array<[number, number]> {
  const [from, top] = heightRange;
  const to = Math.min(top, ceiling);
  const out: Array<[number, number]> = [];
  for (
    let a = Math.floor(from / partitionHeights) * partitionHeights;
    a <= to;
    a += partitionHeights
  ) {
    const lo = Math.max(a, from);
    const hi = Math.min(a + partitionHeights - 1, to);
    if (lo <= hi) out.push([lo, hi]);
  }
  return out;
}

/** The `indexed_at` of a band's rows: its `createdAt`, in seconds. */
export function bandIndexedAt(band: ParquetL2Band): number {
  const ms = Date.parse(band.createdAt);
  if (!Number.isFinite(ms)) {
    throw new L2ImportRefused(
      `band createdAt is not a time: ${band.createdAt}`,
    );
  }
  return Math.floor(ms / 1000);
}

/** A job's directory name: the band and when it was written. */
export function jobName(bandId: string, now: Date): string {
  return `${bandId}.${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
}

const hex = (b: Buffer | null) => (b === null ? '\\N' : b.toString('hex'));
const num = (n: number | null) => (n === null ? '\\N' : String(n));

/** The order a band's placements of one item are kept in: the first is. */
export const PLACEMENT_ORDER = `("offset" IS NULL), height, block_transaction_index, root_parent_offset NULLS LAST, "offset" NULLS LAST`;

/**
 * Writes one band's job into `<jobsDir>/queue`. Reads the band through
 * `duck`, ClickHouse through `held`, and blocks through `blocks`. The job is
 * assembled in `<jobsDir>/.partial` and renamed into the queue when whole;
 * scratch files go to `workDir` (beside DuckDB's spill).
 *
 * @returns the job, or undefined when there is nothing to write (every item
 *   held, or above the ceiling).
 */
export async function writeClickHouseJob({
  duck,
  band,
  bandDir,
  bandId,
  index,
  publisher,
  held,
  blocks,
  ceiling,
  jobsDir,
  workDir,
  now = new Date(),
  partitionHeights = L2_IMPORT_PARTITION_HEIGHTS,
  marginHeights = HELD_MARGIN_HEIGHTS,
  signal,
  log,
}: {
  duck: Database;
  band: ParquetL2Band;
  bandDir: string;
  bandId: string;
  index: string;
  publisher: string;
  held: ClickHouseHeld;
  blocks: L2ImportBlockSource;
  ceiling: number;
  jobsDir: string;
  workDir: string;
  now?: Date;
  partitionHeights?: number;
  marginHeights?: number;
  signal?: AbortSignal;
  log?: { info(message: string, meta?: Record<string, unknown>): void };
}): Promise<L2ImportOutcome> {
  const name = jobName(bandId, now);
  const queueDir = path.join(jobsDir, QUEUE_DIR);
  const partial = path.join(jobsDir, PARTIAL_DIR, name);
  const scratch = path.join(workDir, `${name}.scratch`);
  await fsp.rm(partial, { recursive: true, force: true });
  await fsp.rm(scratch, { recursive: true, force: true });
  await fsp.mkdir(partial, { recursive: true });
  await fsp.mkdir(scratch, { recursive: true });
  const items = `read_parquet(${sqlString(path.join(bandDir, 'data_items.parquet'))})`;
  const tags = `read_parquet(${sqlString(path.join(bandDir, 'tags.parquet'))})`;
  const wallets = `read_parquet(${sqlString(path.join(bandDir, 'wallets.parquet'))})`;
  const indexedAt = bandIndexedAt(band);
  const one = async (sql: string) =>
    Number(Object.values((await duck.all(sql))[0])[0]);

  try {
    // One placement per item, then the ceiling.
    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2i_first AS
      SELECT * EXCLUDE (rn) FROM (
        SELECT *, row_number() OVER (PARTITION BY id ORDER BY ${PLACEMENT_ORDER}) AS rn
        FROM ${items}
      ) WHERE rn = 1`);
    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2i_chosen AS
      SELECT * FROM l2i_first WHERE height <= ${ceiling}`);
    const bandRows = await one(`SELECT count(*) FROM ${items}`);
    const firstRows = await one('SELECT count(*) FROM l2i_first');
    const chosenRows = await one('SELECT count(*) FROM l2i_chosen');
    await duck.exec('DROP TABLE l2i_first');

    // What ClickHouse holds of them, a window at a time.
    await duck.exec(
      `CREATE OR REPLACE TEMP TABLE l2i_held (${HELD_COLUMNS.map((c) => `"${c.name}" ${c.type}`).join(', ')})`,
    );
    const partitions = importPartitions(
      band.heightRange,
      ceiling,
      partitionHeights,
    );
    const decoded = HELD_COLUMNS.map((c) =>
      c.type === 'BLOB'
        ? `from_hex("${c.name}") AS "${c.name}"`
        : `"${c.name}"::${c.type} AS "${c.name}"`,
    ).join(', ');
    const asText = HELD_COLUMNS.map((c) => `'${c.name}': 'VARCHAR'`).join(', ');
    for (const [a, b] of partitions) {
      signal?.throwIfAborted();
      const idsFile = path.join(scratch, `ids-${a}-${b}.tsv`);
      const heldFile = path.join(scratch, `held-${a}-${b}.tsv`);
      await duck.exec(
        `COPY (SELECT hex(id) FROM l2i_chosen WHERE height BETWEEN ${a} AND ${b}) TO ${sqlString(idsFile)} (FORMAT CSV, HEADER false)`,
      );
      if ((await fsp.stat(idsFile)).size === 0) continue;
      await held.heldIn({
        from: Math.max(0, a - marginHeights),
        to: b + marginHeights,
        idsFile,
        outFile: heldFile,
        ...(signal !== undefined ? { signal } : {}),
      });
      if ((await fsp.stat(heldFile)).size > 0) {
        await duck.exec(
          `INSERT INTO l2i_held SELECT ${decoded} FROM read_csv(${sqlString(heldFile)}, header = false, delim = '\t', quote = '', escape = '', auto_detect = false, nullstr = '\\N', columns = {${asText}})`,
        );
      }
      await fsp.rm(idsFile, { force: true });
      await fsp.rm(heldFile, { force: true });
    }

    // Held at the same key: left out, and compared.
    const sameKey = `h.id = c.id AND h.height = c.height AND h.block_transaction_index = c.block_transaction_index`;
    const present = await one(
      `SELECT count(*) FROM l2i_chosen c WHERE EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey})`,
    );
    // Conflicting: no stored version of the key equals the band's row. The
    // band's NULL location is ClickHouse's 0.
    const equal = COMPARED_COLUMNS.map((col) =>
      HELD_COLUMNS.find((c) => c.name === col)?.type === 'BLOB'
        ? `h."${col}" IS NOT DISTINCT FROM c."${col}"`
        : `h."${col}" = coalesce(c."${col}", 0)`,
    ).join(' AND ');
    const conflicting = await one(
      `SELECT count(*) FROM l2i_chosen c
       WHERE EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey})
         AND NOT EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey} AND ${equal})`,
    );
    const conflictExamples = (
      await duck.all(
        `SELECT hex(c.id) AS id FROM l2i_chosen c
         WHERE EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey})
           AND NOT EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey} AND ${equal})
         ORDER BY c.height, c.id LIMIT ${CONFLICT_EXAMPLES}`,
      )
    ).map((r) => String(r.id));
    const elsewhere = await one(
      `SELECT count(*) FROM l2i_chosen c
       WHERE EXISTS (SELECT 1 FROM l2i_held h WHERE h.id = c.id)
         AND NOT EXISTS (SELECT 1 FROM l2i_held h WHERE ${sameKey})`,
    );
    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2i_written AS
      SELECT c.* FROM l2i_chosen c ANTI JOIN l2i_held h ON h.id = c.id`);
    const written = await one('SELECT count(*) FROM l2i_written');
    const unlocated = await one(
      'SELECT count(*) FROM l2i_written WHERE "offset" IS NULL',
    );
    const top = Math.min(band.heightRange[1], ceiling);
    const counts: L2ImportCounts = {
      bandRows,
      otherPlacements: bandRows - firstRows,
      aboveCeiling: firstRows - chosenRows,
      present,
      conflicting,
      elsewhere,
      written,
      unlocated,
      tags: 0,
      blocks: 0,
    };
    if (written === 0) {
      log?.info('Nothing to write: ClickHouse holds every item', {
        bandId,
        ...counts,
        conflictExamples,
      });
      return {
        job: undefined,
        heightRange: [band.heightRange[0], top],
        counts,
        conflictExamples,
      };
    }

    // Blocks for every height written, from the gateway's L1 index.
    const blocksCsv = path.join(scratch, 'blocks.csv');
    const lines: string[] = [];
    for (const b of blocks.blocks(band.heightRange[0], top)) {
      lines.push(
        [
          hex(b.indepHash),
          b.height,
          hex(b.previousBlock),
          hex(b.nonce),
          hex(b.hash),
          b.blockTimestamp,
          b.txCount,
          num(b.blockSize),
        ].join(','),
      );
    }
    await fsp.writeFile(
      blocksCsv,
      lines.length > 0 ? `${lines.join('\n')}\n` : '',
    );
    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2i_blocks (indep_hash BLOB, height UBIGINT, previous_block BLOB, nonce BLOB, hash BLOB, block_timestamp INTEGER, tx_count INTEGER, block_size UBIGINT)`);
    if (lines.length > 0) {
      await duck.exec(`
        INSERT INTO l2i_blocks SELECT from_hex(ih), h::UBIGINT, from_hex(pb), from_hex(n), from_hex(hh), ts::INTEGER, tc::INTEGER, bs::UBIGINT
        FROM read_csv(${sqlString(blocksCsv)}, header = false, delim = ',', quote = '', escape = '', auto_detect = false, nullstr = '\\N',
          columns = {'ih': 'VARCHAR', 'h': 'VARCHAR', 'pb': 'VARCHAR', 'n': 'VARCHAR', 'hh': 'VARCHAR', 'ts': 'VARCHAR', 'tc': 'VARCHAR', 'bs': 'VARCHAR'})`);
    }
    const missingBlocks = await duck.all(`
      SELECT DISTINCT height FROM l2i_written ANTI JOIN l2i_blocks USING (height)
      ORDER BY height LIMIT 5`);
    if (missingBlocks.length > 0) {
      // clickhouse-import inner-joins staging_blocks: an item without its
      // block would be dropped there, silently.
      throw new L2ImportRefused(
        `this gateway's core.db lacks blocks the band's items are at (${missingBlocks.map((r) => String(r.height)).join(', ')}…): import or fill those heights first`,
      );
    }

    // The job, in the exporter's layout and types (parquet-exporter.ts,
    // TYPED_SELECTS), one file per table and partition.
    const usedPartitions: string[] = [];
    let tagRows = 0;
    let blockRows = 0;
    for (const [a, b] of partitions) {
      const n = await one(
        `SELECT count(*) FROM l2i_written WHERE height BETWEEN ${a} AND ${b}`,
      );
      if (n === 0) continue;
      const p = `height=${a}-${b}`;
      usedPartitions.push(p);
      const file = (table: string) =>
        path.join(
          partial,
          table,
          'data',
          p,
          `${table}_${a}_${b}_${name}.parquet`,
        );
      for (const table of ['blocks', 'transactions', 'tags']) {
        await fsp.mkdir(path.dirname(file(table)), { recursive: true });
      }
      await duck.exec(`
        COPY (
          SELECT indep_hash, height, previous_block, nonce, hash, block_timestamp, tx_count, block_size
          FROM l2i_blocks
          WHERE height BETWEEN ${a} AND ${b}
            AND height IN (SELECT height FROM l2i_written WHERE height BETWEEN ${a} AND ${b})
          ORDER BY height, indep_hash
        ) TO ${sqlString(file('blocks'))} (FORMAT PARQUET, COMPRESSION 'zstd')`);
      await duck.exec(`
        COPY (
          SELECT w.id, ${indexedAt}::UBIGINT AS indexed_at,
                 w.block_transaction_index::USMALLINT AS block_transaction_index,
                 true AS is_data_item, w.target,
                 NULL::DECIMAL(20,0) AS quantity, NULL::DECIMAL(20,0) AS reward,
                 coalesce(w.anchor, ''::BLOB) AS anchor,
                 w.data_size::UBIGINT AS data_size, w.content_type,
                 NULL::UTINYINT AS format, w.height::UBIGINT AS height,
                 w.owner_address, NULL::BLOB AS data_root, w.parent_id AS parent,
                 coalesce(w."offset", 0)::UBIGINT AS "offset",
                 coalesce(w.size, 0)::UBIGINT AS size,
                 coalesce(w.data_offset, 0)::UBIGINT AS data_offset,
                 coalesce(w.owner_offset, 0)::UBIGINT AS owner_offset,
                 coalesce(w.owner_size, 0)::UINTEGER AS owner_size,
                 CASE WHEN octet_length(k.public_modulus) <= 64 THEN k.public_modulus ELSE NULL END AS owner,
                 coalesce(w.signature_offset, 0)::UBIGINT AS signature_offset,
                 coalesce(w.signature_size, 0)::UINTEGER AS signature_size,
                 w.signature_type::UINTEGER AS signature_type,
                 w.root_transaction_id,
                 coalesce(w.root_parent_offset, 0)::UBIGINT AS root_parent_offset
          FROM l2i_written w LEFT JOIN ${wallets} k ON k.address = w.owner_address
          WHERE w.height BETWEEN ${a} AND ${b}
          ORDER BY height, id
        ) TO ${sqlString(file('transactions'))} (FORMAT PARQUET, COMPRESSION 'zstd')`);
      await duck.exec(`
        COPY (
          SELECT t.height::UBIGINT AS height, t.id, t.tag_index::USMALLINT AS tag_index,
                 ${indexedAt}::UBIGINT AS indexed_at, t.tag_name, t.tag_value,
                 true AS is_data_item
          FROM ${tags} t SEMI JOIN l2i_written w ON w.id = t.id AND w.height = t.height
          WHERE t.height BETWEEN ${a} AND ${b}
          ORDER BY height, id, tag_index
        ) TO ${sqlString(file('tags'))} (FORMAT PARQUET, COMPRESSION 'zstd')`);
      tagRows += await one(
        `SELECT count(*) FROM read_parquet(${sqlString(file('tags'))})`,
      );
      blockRows += await one(
        `SELECT count(*) FROM read_parquet(${sqlString(file('blocks'))})`,
      );
    }
    await duck.exec(`
      COPY (SELECT id, height FROM l2i_written ORDER BY height, id)
      TO ${sqlString(path.join(partial, WRITTEN_FILE))} (FORMAT PARQUET, COMPRESSION 'zstd')`);

    const job: L2ImportJob = {
      version: 1,
      kind: JOB_KIND,
      job: name,
      bandId,
      bandDigest: bandTablesDigest(band).toString('hex'),
      index,
      publisher,
      indexedAt,
      heightRange: [band.heightRange[0], top],
      partitions: usedPartitions,
      counts: { ...counts, tags: tagRows, blocks: blockRows },
      conflictExamples,
      createdAt: now.toISOString(),
    };
    await fsp.writeFile(
      path.join(partial, JOB_FILE),
      `${JSON.stringify(job, null, 2)}\n`,
    );
    await fsp.mkdir(queueDir, { recursive: true });
    await fsp.rename(partial, path.join(queueDir, name));
    return {
      job,
      heightRange: job.heightRange,
      counts: job.counts,
      conflictExamples,
    };
  } finally {
    for (const t of [
      'l2i_first',
      'l2i_chosen',
      'l2i_held',
      'l2i_written',
      'l2i_blocks',
    ]) {
      await duck.exec(`DROP TABLE IF EXISTS ${t}`).catch(() => undefined);
    }
    await fsp.rm(scratch, { recursive: true, force: true });
    await fsp.rm(partial, { recursive: true, force: true });
  }
}
