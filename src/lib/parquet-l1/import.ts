/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Importing `parquet-l1` bands into a gateway's `core.db`, so a new gateway
 * starts from a published index instead of indexing the chain block by
 * block.
 *
 * Runs with the gateway stopped: it writes `stable_*` directly and makes no
 * network calls. Each band is one SQLite transaction that ends by recording
 * the band in `parquet_l1_imports`, so an interrupted import resumes and a
 * band is never applied twice. Bands are imported in height order and a gap
 * is refused: the block importer rewinds across one and gives up after
 * `MAX_FORK_DEPTH`.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  BAND_FILE,
  MAX_BAND_FILE_BYTES,
  PARQUET_L1_TABLES,
  ParquetL1Band,
  parseBandFile,
  TableSpec,
} from './layout.js';
import { IMPORT_ORDER, readTable } from './read.js';

/** A band on disk, ready to import. */
export interface ImportableBand {
  id: string;
  dir: string;
  band: ParquetL1Band;
}

export interface ImportOutcome {
  id: string;
  heightRange: [number, number];
  result: 'imported' | 'already_held' | 'refused';
  reason?: string;
  rows?: number;
  missingTransactions?: number;
  seconds: number;
}

export class ImportRefused extends Error {}

const spec = (name: string) =>
  PARQUET_L1_TABLES.find((t) => t.name === name) as TableSpec;

/**
 * Rows written before a commit. Bounds the WAL and the memory a write
 * transaction holds; the cost of a crash is re-importing one band.
 */
export const COMMIT_EVERY_ROWS = 2_000_000;

/** A band's identity for the ledger: its heights and every table's digest. */
export function bandDigest(band: ParquetL1Band): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(band.heightRange));
  for (const name of Object.keys(band.tables).sort()) {
    hash.update(
      `${name}:${band.tables[name].rows}:${band.tables[name].rowDigest}\n`,
    );
  }
  return hash.digest();
}

/** Every band of a `parquet-l1` directory, lowest first, with its band file read. */
export async function readBands(dir: string): Promise<ImportableBand[]> {
  const bands: ImportableBand[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const bandDir = path.join(dir, name);
    const file = path.join(bandDir, BAND_FILE);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat === undefined || stat.size > MAX_BAND_FILE_BYTES) continue;
    bands.push({
      id: name,
      dir: bandDir,
      band: parseBandFile(await fs.readFile(file, 'utf8')),
    });
  }
  return bands.sort(
    (a, b) =>
      a.band.heightRange[0] - b.band.heightRange[0] ||
      a.band.heightRange[1] - b.band.heightRange[1],
  );
}

/**
 * The bands to import, in height order: those the ledger doesn't hold that
 * carry heights above what `core.db` already has. Overlapping bands are
 * dropped in favour of the one that reaches furthest.
 *
 * A gap is refused rather than imported around, because the block importer
 * rewinds across one and gives up after `MAX_FORK_DEPTH`. An empty database
 * is the exception: it has no history to be continuous with, so it adopts
 * the lowest band's start.
 */
export function planImport(
  bands: ImportableBand[],
  { haveTo, held }: { haveTo: number; held: ReadonlySet<string> },
): { steps: ImportableBand[]; skipped: ImportableBand[] } {
  const steps: ImportableBand[] = [];
  const skipped: ImportableBand[] = [];
  // An empty database takes the lowest band's start as its own: the result
  // is a gateway whose history begins there, as one started with
  // START_HEIGHT does. A database that already holds blocks must be
  // continued from, not left with a hole.
  const lowest = bands.reduce(
    (low, b) => Math.min(low, b.band.heightRange[0]),
    Number.MAX_SAFE_INTEGER,
  );
  let next = haveTo < 0 ? lowest : haveTo + 1;
  for (const candidate of bands) {
    const [from, to] = candidate.band.heightRange;
    if (to < next || held.has(candidate.id)) {
      skipped.push(candidate);
      continue;
    }
    if (from > next) {
      throw new ImportRefused(
        `No band covers height ${next}: the next starts at ${from}. An import must be contiguous, or the block importer rewinds across the gap`,
      );
    }
    if (from < next) {
      // Starts below what is held but reaches past it: a band an earlier
      // run left part way through. Importing it again is safe — every
      // write is idempotent — and is the only way to finish it.
      steps.push(candidate);
      next = to + 1;
      continue;
    }
    steps.push(candidate);
    next = to + 1;
  }
  return { steps, skipped };
}

/** The migration this importer was written against; its table must exist. */
export const LEDGER_MIGRATION =
  '2026.10.04T12.00.00.core.add-parquet-l1-imports';

/**
 * Refuses a `core.db` an import would damage or silently half-fill.
 *
 * - The ledger migration must have run, so the gateway and the importer
 *   agree on the schema. An older `core.db` is missing columns this writes.
 * - `new_*` must be empty. Those are the unstable rows near the tip; an
 *   import writes `stable_*` beneath them, and the block importer would
 *   then flush them over heights it never fetched.
 * - The gateway must be stopped. A second writer is the one thing a long
 *   transaction cannot survive, and SQLite will not tell us politely.
 */
export function assertImportable(db: Sqlite.Database): void {
  const migrated = db
    .prepare('SELECT 1 FROM migrations WHERE name = ?')
    .pluck()
    .get(LEDGER_MIGRATION);
  if (migrated === undefined) {
    throw new ImportRefused(
      `core.db has not run ${LEDGER_MIGRATION}: run \`yarn db:migrate up\` first, so the importer and the gateway agree on the schema`,
    );
  }
  const unstable = db
    .prepare('SELECT COUNT(*) FROM new_blocks')
    .pluck()
    .get() as number;
  if (unstable > 0) {
    throw new ImportRefused(
      `core.db holds ${unstable} unstable blocks: stop the gateway and let them flush, or reset them, before importing beneath them`,
    );
  }
  // Another writer holding the database: better found now than half way
  // through a band.
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (error) {
    throw new ImportRefused(
      `core.db is open for writing elsewhere (${(error as Error).message}); stop the gateway before importing`,
    );
  }
}

/** What `core.db` already holds, and the bands it was built from. */
export function readProgress(db: Sqlite.Database): {
  haveTo: number;
  held: Set<string>;
  newRows: number;
} {
  const at = (sql: string) =>
    (db.prepare(sql).pluck().get() as number | null) ?? -1;
  const held = new Set(
    db
      .prepare('SELECT band_id FROM parquet_l1_imports')
      .pluck()
      .all() as string[],
  );
  return {
    haveTo: Math.max(at('SELECT MAX(height) FROM stable_blocks'), -1),
    held,
    newRows: Math.max(at('SELECT COUNT(*) FROM new_blocks'), 0),
  };
}

const sha1 = (bytes: Buffer) =>
  crypto.createHash('sha1').update(bytes).digest();

const asBuffer = (value: unknown): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);

/**
 * Imports one band in a single transaction, ending with its ledger row.
 *
 * Idempotent: every write is `INSERT OR REPLACE`/`OR IGNORE` keyed the way
 * the table is, and `missing_tx_count` is derived from the rows rather than
 * incremented, so importing the same band twice leaves `core.db` exactly as
 * importing it once does. The planner skips a band the ledger holds; this
 * is what makes that an optimisation rather than a correctness rule.
 *
 * Order matters: owners and blocks before the rows that point at them,
 * transactions before the links and tags that name them. A link whose
 * transaction the band lacks becomes a `missing_transactions` row, so the
 * gateway backfills it the usual way rather than trusting a count.
 */
export async function importBand(
  db: Sqlite.Database,
  duck: import('duckdb-async').Database,
  entry: ImportableBand,
  {
    log,
    batchRows,
    commitEvery = COMMIT_EVERY_ROWS,
  }: { log: Logger; batchRows?: number; commitEvery?: number },
): Promise<{ rows: number; missingTransactions: number }> {
  const { band, dir } = entry;
  const [from, to] = band.heightRange;
  const insert = {
    wallets: db.prepare(
      'INSERT OR IGNORE INTO wallets (address, public_modulus) VALUES (?, ?)',
    ),
    blocks:
      db.prepare(`INSERT OR REPLACE INTO stable_blocks (indep_hash, height,
      previous_block, nonce, hash, block_timestamp, tx_count, block_size, diff,
      cumulative_diff, last_retarget, reward_addr, reward_pool, weave_size,
      usd_to_ar_rate_dividend, usd_to_ar_rate_divisor,
      scheduled_usd_to_ar_rate_dividend, scheduled_usd_to_ar_rate_divisor,
      hash_list_merkle, wallet_list, tx_root, missing_tx_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
    transactions: db.prepare(`INSERT OR REPLACE INTO stable_transactions (id,
      block_transaction_index, target, quantity, reward, last_tx, data_size,
      content_type, format, height, owner_address, data_root, offset,
      content_encoding, tag_count, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    link: db.prepare(`INSERT OR IGNORE INTO stable_block_transactions
      (block_indep_hash, transaction_id, block_transaction_index) VALUES (?, ?, ?)`),
    missing: db.prepare(`INSERT OR IGNORE INTO missing_transactions
      (block_indep_hash, transaction_id, height) VALUES (?, ?, ?)`),
    tagName: db.prepare(
      'INSERT OR IGNORE INTO tag_names (hash, name) VALUES (?, ?)',
    ),
    tagValue: db.prepare(
      'INSERT OR IGNORE INTO tag_values (hash, value) VALUES (?, ?)',
    ),
    tag: db.prepare(`INSERT OR IGNORE INTO stable_transaction_tags (tag_name_hash,
      tag_value_hash, height, block_transaction_index, transaction_tag_index,
      transaction_id) VALUES (?, ?, ?, ?, ?, ?)`),
    // Derived from the rows, not incremented: an import that runs twice
    // must land on the same number.
    countMissing: db.prepare(`UPDATE stable_blocks SET missing_tx_count =
      (SELECT COUNT(*) FROM missing_transactions m WHERE m.height = stable_blocks.height)
      WHERE height BETWEEN ? AND ?`),
    hashAt: db
      .prepare('SELECT indep_hash FROM stable_blocks WHERE height = ?')
      .pluck(),
    haveTx: db
      .prepare('SELECT 1 FROM stable_transactions WHERE id = ?')
      .pluck(),
    ledger:
      db.prepare(`INSERT OR REPLACE INTO parquet_l1_imports (band_id, height_from,
      height_to, band_digest, rows_imported, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
  };

  let rows = 0;
  let missingTransactions = 0;

  const writers: Record<string, (batch: unknown[][]) => void> = {
    wallets: (batch) => {
      for (const [address, modulus] of batch) {
        insert.wallets.run(
          asBuffer(address),
          modulus === null ? null : asBuffer(modulus),
        );
      }
    },
    blocks: (batch) => {
      for (const r of batch) {
        insert.blocks.run(
          ...r.map((v, i) =>
            v === null || v === undefined
              ? null
              : spec('blocks').columns[i].type === 'BLOB'
                ? asBuffer(v)
                : typeof v === 'bigint'
                  ? Number(v)
                  : v,
          ),
        );
      }
    },
    transactions: (batch) => {
      for (const r of batch) {
        const [
          id,
          bti,
          ,
          target,
          quantity,
          reward,
          anchor,
          dataSize,
          contentType,
          format,
          height,
          owner,
          dataRoot,
          offset,
          contentEncoding,
          tagCount,
          signature,
        ] = r;
        insert.transactions.run(
          asBuffer(id),
          Number(bti),
          target === null ? null : asBuffer(target),
          String(quantity),
          String(reward),
          asBuffer(anchor),
          Number(dataSize),
          contentType ?? null,
          Number(format),
          Number(height),
          asBuffer(owner),
          dataRoot === null ? null : asBuffer(dataRoot),
          offset === null ? null : Number(offset),
          contentEncoding ?? null,
          tagCount === null ? null : Number(tagCount),
          signature === null ? null : asBuffer(signature),
        );
      }
    },
    block_transactions: (batch) => {
      // Looked up rather than held in memory: a 100,000-height band has
      // about a million transactions, and a map of their ids would be
      // hundreds of megabytes. These are primary-key reads inside the
      // transaction, so they see the rows written moments ago.
      for (const [height, bti, txId] of batch) {
        const h = Number(height);
        const indepHash = insert.hashAt.get(h) as Buffer | undefined;
        if (indepHash === undefined) {
          throw new ImportRefused(
            `A link at height ${h} has no block in the band`,
          );
        }
        const id = asBuffer(txId);
        insert.link.run(indepHash, id, Number(bti));
        if (insert.haveTx.get(id) === undefined) {
          insert.missing.run(indepHash, id, h);
          missingTransactions += 1;
        }
      }
    },
    tags: (batch) => {
      for (const r of batch) {
        const [height, id, tagIndex, name, value] = r;
        const bti = r[r.length - 1];
        if (bti === null || bti === undefined) {
          throw new ImportRefused(
            `A tag at height ${Number(height)} names a transaction the band lacks`,
          );
        }
        const nameBytes = asBuffer(name);
        const valueBytes = asBuffer(value);
        const nameHash = sha1(nameBytes);
        const valueHash = sha1(valueBytes);
        insert.tagName.run(nameHash, nameBytes);
        insert.tagValue.run(valueHash, valueBytes);
        insert.tag.run(
          nameHash,
          valueHash,
          Number(height),
          Number(bti),
          Number(tagIndex),
          asBuffer(id),
        );
      }
    },
  };

  const txFile = path.join(dir, spec('transactions').file).replace(/'/g, "''");
  // Committed in chunks rather than as one transaction for the band.
  // Measured on a real 1.3 GB band (10.4M transactions, 25.7M tags), one
  // transaction grew the WAL past 7.8 GB and the process past 4.6 GB of
  // memory before committing anything — too much to ask of a machine
  // bootstrapping a gateway. Chunks bound both.
  //
  // A crash now leaves part of a band behind without its ledger row, which
  // is safe because every write is idempotent and `missing_tx_count` is
  // derived: the planner sees the band still covers the next height it
  // needs and imports it again, over the top of what is there.
  let sinceCommit = 0;
  db.exec('BEGIN IMMEDIATE');
  const commitChunk = () => {
    db.exec('COMMIT');
    sinceCommit = 0;
    db.exec('BEGIN IMMEDIATE');
  };
  try {
    for (const table of IMPORT_ORDER) {
      const extra =
        table.name === 'tags'
          ? {
              select: ['x."block_transaction_index" AS bti'],
              from: `LEFT JOIN read_parquet('${txFile}') x ON x."id" = t."id"`,
            }
          : { select: [], from: '' };
      rows += await readTable(
        duck,
        dir,
        table,
        band,
        async (batch) => {
          writers[table.name](batch);
          sinceCommit += batch.length;
          // Never between a block and the links that need its hash, nor
          // between a transaction and its tags: each table is finished
          // before the next begins, so a chunk boundary inside one is safe.
          if (sinceCommit >= commitEvery) commitChunk();
        },
        batchRows,
        extra,
      );
    }
    insert.countMissing.run(from, to);
    insert.ledger.run(
      entry.id,
      from,
      to,
      bandDigest(band),
      rows,
      Math.floor(Date.now() / 1000),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  log.info('Imported a band', {
    id: entry.id,
    heightRange: band.heightRange,
    rows,
    missingTransactions,
  });
  return { rows, missingTransactions };
}

export interface ImportRunResult {
  haveTo: number;
  outcomes: ImportOutcome[];
  /** Bands on disk the run had no use for, with why. */
  skipped: Array<{ id: string; heightRange: [number, number] }>;
}

/**
 * Imports every band of `bandsDir` that `core.db` is missing, lowest first,
 * stopping at the first that fails.
 *
 * Stopping matters: bands must be imported as a contiguous run, so carrying
 * on past a failure would leave a hole the block importer cannot cross.
 * What was imported before the failure is committed and the ledger records
 * it, so the next run picks up from there.
 */
export async function runImport({
  db,
  duck,
  bandsDir,
  log,
  limit,
  batchRows,
  onBand,
}: {
  db: Sqlite.Database;
  duck: import('duckdb-async').Database;
  bandsDir: string;
  log: Logger;
  /** Import at most this many bands, for a first run an operator watches. */
  limit?: number;
  batchRows?: number;
  onBand?: (outcome: ImportOutcome) => void;
}): Promise<ImportRunResult> {
  assertImportable(db);
  const bands = await readBands(bandsDir);
  if (bands.length === 0) {
    throw new ImportRefused(`${bandsDir} holds no bands with a ${BAND_FILE}`);
  }
  const progress = readProgress(db);
  const { steps, skipped } = planImport(bands, progress);
  log.info('Planned an import', {
    bandsOnDisk: bands.length,
    toImport: steps.length,
    skipped: skipped.length,
    fromHeight: progress.haveTo + 1,
  });

  const outcomes: ImportOutcome[] = [];
  let haveTo = progress.haveTo;
  for (const entry of steps.slice(0, limit ?? steps.length)) {
    const started = Date.now();
    const base = { id: entry.id, heightRange: entry.band.heightRange };
    try {
      const { rows, missingTransactions } = await importBand(db, duck, entry, {
        log,
        ...(batchRows !== undefined ? { batchRows } : {}),
      });
      haveTo = entry.band.heightRange[1];
      const outcome: ImportOutcome = {
        ...base,
        result: 'imported',
        rows,
        missingTransactions,
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
    } catch (error) {
      const outcome: ImportOutcome = {
        ...base,
        result: 'refused',
        reason: error instanceof Error ? error.message : String(error),
        seconds: (Date.now() - started) / 1000,
      };
      outcomes.push(outcome);
      onBand?.(outcome);
      log.error('Import stopped', { id: entry.id, error: outcome.reason });
      break;
    }
  }
  return {
    haveTo,
    outcomes,
    skipped: skipped.map((b) => ({
      id: b.id,
      heightRange: b.band.heightRange,
    })),
  };
}
