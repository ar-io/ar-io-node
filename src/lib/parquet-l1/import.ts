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
 * dropped in favour of the one that reaches furthest, and a gap between
 * what the database holds and the first band, or between two bands, is
 * refused rather than imported around.
 */
export function planImport(
  bands: ImportableBand[],
  { haveTo, held }: { haveTo: number; held: ReadonlySet<string> },
): { steps: ImportableBand[]; skipped: ImportableBand[] } {
  const steps: ImportableBand[] = [];
  const skipped: ImportableBand[] = [];
  let next = haveTo + 1;
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
      // Overlaps what is held: a tip band that a whole one has since
      // covered, or two bands of different grids.
      skipped.push(candidate);
      continue;
    }
    steps.push(candidate);
    next = to + 1;
  }
  return { steps, skipped };
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
 * Order matters: owners and blocks before the rows that point at them,
 * transactions before the links and tags that name them. A link whose
 * transaction the band lacks becomes a `missing_transactions` row, so the
 * gateway backfills it the usual way rather than trusting a count.
 */
export async function importBand(
  db: Sqlite.Database,
  duck: import('duckdb-async').Database,
  entry: ImportableBand,
  { log, batchRows }: { log: Logger; batchRows?: number },
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
    bumpMissing: db.prepare(
      'UPDATE stable_blocks SET missing_tx_count = missing_tx_count + 1 WHERE height = ?',
    ),
    ledger: db.prepare(`INSERT INTO parquet_l1_imports (band_id, height_from,
      height_to, band_digest, rows_imported, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
  };

  // Heights to block hashes, for the links; the band's own blocks only.
  const hashAt = new Map<number, Buffer>();
  const haveTx = new Set<string>();
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
        hashAt.set(Number(r[1]), asBuffer(r[0]));
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
        haveTx.add(asBuffer(id).toString('hex'));
      }
    },
    block_transactions: (batch) => {
      for (const [height, bti, txId] of batch) {
        const h = Number(height);
        const indepHash = hashAt.get(h);
        if (indepHash === undefined) {
          throw new ImportRefused(
            `A link at height ${h} has no block in the band`,
          );
        }
        const id = asBuffer(txId);
        insert.link.run(indepHash, id, Number(bti));
        if (!haveTx.has(id.toString('hex'))) {
          insert.missing.run(indepHash, id, h);
          insert.bumpMissing.run(h);
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
  // One transaction for the whole band, ledger row included: a crash leaves
  // core.db exactly as it was and the band is imported again from the
  // start. Held open across the reads, which better-sqlite3 allows because
  // it is synchronous on a single connection. `missing_tx_count` is raised
  // with an UPDATE, which only a whole-band rollback makes safe to repeat.
  db.exec('BEGIN IMMEDIATE');
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
        },
        batchRows,
        extra,
      );
    }
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
