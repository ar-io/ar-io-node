/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The L2 import's SQLite target: writes one verified `parquet-l2` band into
 * `bundles.db`, for a gateway without ClickHouse. It writes
 * `stable_data_items`, `stable_data_item_tags`, `wallets`, `tag_names` and
 * `tag_values`, as the gateway's own flush does, and nothing else.
 *
 * What goes in, per item of the band:
 *
 * - **One placement**, chosen as the ClickHouse target chooses it
 *   ({@link createFirstPlacements}): `stable_data_items` is keyed by id.
 * - **Located items only** (DL-22). `data_offset` is NOT NULL here, and an
 *   invented offset would point retrieval at the wrong bytes.
 * - **Nothing above the gateway's stable L1 tip** (`ceiling`). SQLite
 *   GraphQL joins each item to `stable_blocks` by height, so an item without
 *   its block would be invisible; heights below the tip without a block
 *   refuse the band, as they do for ClickHouse.
 * - **First writer wins** (DL-22): every insert is `ON CONFLICT DO NOTHING`,
 *   as the gateway's flush is, so an import never changes a row the gateway
 *   has and the gateway's later flush never changes an imported one. An item
 *   held already is compared (`present`, `conflicting`, `elsewhere`), and its
 *   tags are not written: they are keyed by height as well as id, so they
 *   would add a second tag set where the gateway placed the item elsewhere.
 *
 * Every row carries the band's `createdAt` as `indexed_at`, so importing the
 * same band twice writes the same rows, and the rows a band wrote can be
 * told from the gateway's own (`--forget`, and `alreadyImported` here).
 *
 * It runs beside the gateway, as `index-l1-import --fill` does: short
 * `BEGIN IMMEDIATE` transactions, bounded by rows and by time, a pause after
 * each, no transaction open while DuckDB reads, and a WAL checkpoint every
 * few commits. Each transaction also adds its counts to the ledger, so a run
 * stopped part way leaves the ledger matching the database, and the next run
 * carries on: what is written already is found and skipped.
 */
import crypto from 'node:crypto';
import * as path from 'node:path';
import type Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import {
  bandIndexedAt,
  CONFLICT_EXAMPLES,
  createFirstPlacements,
  L2ImportRefused,
} from './import-clickhouse.js';
import { SqliteImportLedger } from './import-ledger.js';
import { bandTablesDigest, type ParquetL2Band } from './layout.js';

/** Items read from DuckDB at a time, and the most written in one transaction. */
export const SQLITE_BATCH_ROWS = 10_000;

/**
 * The longest a transaction holds the write lock. M1 measured 10,000-item
 * batches holding it 0.7 to 1.5 s, and a writer beside them waiting more
 * than a second on 1.2 to 1.6% of its writes.
 */
export const SQLITE_BATCH_MS = 250;

/** Pause after each transaction, so the gateway's writers get the lock. */
export const SQLITE_YIELD_MS = 50;

/**
 * Milliseconds between `wal_checkpoint(TRUNCATE)` calls. With the gateway
 * writing too, the WAL never reset by itself: one band grew it to 41.8 GB
 * in M1. By time, not commits: commits bounded at 250 ms come several a
 * second, and a checkpoint after every few would cost more than the writes.
 */
export const SQLITE_CHECKPOINT_MS = 10_000;

/**
 * The longest a checkpoint waits for the gateway's readers. A `TRUNCATE`
 * checkpoint holds off other writers while it waits, and the gateway's
 * writers give up after 30 s: one long GraphQL read must not make them fail.
 * A checkpoint that cannot finish in this time is simply tried again later.
 */
export const SQLITE_CHECKPOINT_WAIT_MS = 1_000;

/**
 * The importer's page cache, in KiB (as `cache_size` takes it, negative).
 * Every item lands in indexes keyed by random values (its id, its tags'
 * hashes), so once `bundles.db` outgrows the default 2 MB cache nearly every
 * insert read a page from disk: an 8M-item band slowed from 2,700 to 530
 * items a second as it went. Only this connection's: the gateway's own are
 * unchanged.
 */
export const SQLITE_CACHE_KIB = 256 * 1024;

/**
 * Tag-name and -value hashes remembered as written, so a run inserts each
 * once rather than once per tag. Most names, and many values (a drive, an
 * app), repeat across a band. Bounded: forgotten wholesale when full, which
 * costs only repeated `DO NOTHING` inserts.
 */
export const SQLITE_SEEN_TAG_HASHES = 1_000_000;

/** What {@link importBandIntoSqlite} did with a band's rows. */
export interface L2SqliteCounts {
  /** Rows of the band's `data_items`. */
  bandRows: number;
  /** Rows left out as another placement of an item kept once. */
  otherPlacements: number;
  /** Items above the ceiling: a later run's. */
  aboveCeiling: number;
  /** Items no band row locates: not written (DL-22). */
  unlocated: number;
  /** Items the gateway holds at the same height and block index. */
  present: number;
  /** Of those, held with a different root, parent, owner, size or location. */
  conflicting: number;
  /** Items the gateway holds at another height or block index. */
  elsewhere: number;
  /** Items an earlier run of this band wrote (its `indexed_at`). */
  alreadyImported: number;
  /** Items written. */
  written: number;
  /** Tag rows written. */
  tags: number;
  /** Items written whose owner's key the band lacks: not in GraphQL. */
  noOwnerKey: number;
  /**
   * Items written whose band row gave a content type or encoding other than
   * their own tags give. The tags' is written: the signature covers them.
   */
  typeFromTags: number;
}

/** What {@link importBandIntoSqlite} returns. */
export interface L2SqliteOutcome {
  /** The heights written: the band's, cut at the ceiling. */
  heightRange: [number, number];
  counts: L2SqliteCounts;
  /** Up to {@link CONFLICT_EXAMPLES} conflicting ids, upper-case hex. */
  conflictExamples: string[];
}

/** The stored columns compared for `conflicting`. */
export const SQLITE_COMPARED_COLUMNS = [
  'root_transaction_id',
  'parent_id',
  'owner_address',
  'data_size',
  'offset',
  'size',
  'data_offset',
  'owner_offset',
  'owner_size',
  'signature_offset',
  'signature_size',
  'root_parent_offset',
] as const;

export const SQLITE_IMPORT_SQL = {
  item: `INSERT INTO stable_data_items (
      id, parent_id, root_transaction_id, height, block_transaction_index,
      signature, anchor, owner_address, target, data_offset, data_size,
      content_type, tag_count, indexed_at, signature_type, offset, size,
      owner_offset, owner_size, signature_offset, signature_size,
      content_encoding, root_parent_offset, stable_at)
    VALUES (@id, @parent_id, @root_transaction_id, @height,
      @block_transaction_index, NULL, @anchor, @owner_address, @target,
      @data_offset, @data_size, @content_type, @tag_count, @indexed_at,
      @signature_type, @offset, @size, @owner_offset, @owner_size,
      @signature_offset, @signature_size, @content_encoding,
      @root_parent_offset, @indexed_at)
    ON CONFLICT DO NOTHING`,
  held: `SELECT height, block_transaction_index, indexed_at,
      ${SQLITE_COMPARED_COLUMNS.map((c) => `"${c}"`).join(', ')}
    FROM stable_data_items WHERE id = ?`,
  wallet:
    'INSERT INTO wallets (address, public_modulus) VALUES (?, ?) ON CONFLICT DO NOTHING',
  tagName:
    'INSERT INTO tag_names (hash, name) VALUES (?, ?) ON CONFLICT DO NOTHING',
  tagValue:
    'INSERT INTO tag_values (hash, value) VALUES (?, ?) ON CONFLICT DO NOTHING',
  tag: `INSERT INTO stable_data_item_tags (
      tag_name_hash, tag_value_hash, height, block_transaction_index,
      data_item_tag_index, data_item_id, parent_id, root_transaction_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
} as const;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * `wal_checkpoint(TRUNCATE)` waiting at most {@link SQLITE_CHECKPOINT_WAIT_MS}
 * for readers; the connection's own busy timeout is restored after.
 */
function checkpoint(db: Sqlite.Database): void {
  const timeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma(`busy_timeout = ${SQLITE_CHECKPOINT_WAIT_MS}`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    // Readers held on past the wait: the next checkpoint tries again.
    if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}

/** As the gateway hashes a tag's name or value (`hashTagPart`). */
const hashTagPart = (value: Buffer) =>
  crypto.createHash('sha1').update(value).digest();

const EMPTY = Buffer.alloc(0);

/**
 * An item's first tag of a name (case-insensitive) in tag order, as the
 * gateway takes `content_type` and `content_encoding` when it indexes an
 * item itself (`standalone-sqlite.ts`, `ans-104.ts`).
 */
function firstTagValue(tags: TagRow[], lowerName: string): string | null {
  for (const t of tags) {
    if (Buffer.from(t.tag_name).toString('utf8').toLowerCase() === lowerName) {
      return Buffer.from(t.tag_value).toString('utf8');
    }
  }
  return null;
}
const asNumber = (v: unknown) =>
  v === null || v === undefined ? null : Number(v as number | bigint);
const asBuffer = (v: unknown) =>
  v === null || v === undefined ? null : Buffer.from(v as Uint8Array);

/** Whether a stored value and the band's are the same. */
function same(stored: unknown, band: unknown): boolean {
  if (stored === null || stored === undefined) {
    return band === null || band === undefined;
  }
  if (Buffer.isBuffer(stored)) {
    return Buffer.isBuffer(band) && stored.equals(band);
  }
  return band !== null && band !== undefined && Number(stored) === Number(band);
}

interface ItemRow {
  rn: number | bigint;
  id: Buffer;
  height: number | bigint;
  block_transaction_index: number;
  root_transaction_id: Buffer;
  parent_id: Buffer;
  owner_address: Buffer;
  target: Buffer | null;
  anchor: Buffer | null;
  signature_type: number | null;
  data_size: number | bigint;
  content_type: string | null;
  content_encoding: string | null;
  tag_count: number | null;
  root_parent_offset: number | bigint;
  offset: number | bigint;
  size: number | bigint;
  data_offset: number | bigint;
  owner_offset: number | bigint;
  owner_size: number | bigint;
  signature_offset: number | bigint;
  signature_size: number | bigint;
  public_modulus: Buffer | null;
}

interface TagRow {
  rn: number | bigint;
  tag_index: number;
  tag_name: Buffer;
  tag_value: Buffer;
}

/**
 * Writes one verified band into `bundles.db`, through `db`, recording it in
 * the ledger as it goes. Reads the band through `duck`; `hasBlock` says
 * whether the gateway's `core.db` holds a block at a height.
 */
export async function importBandIntoSqlite({
  duck,
  db,
  band,
  bandDir,
  bandId,
  index,
  publisher,
  ceiling,
  hasBlock,
  accepted,
  checkRoom,
  batchRows = SQLITE_BATCH_ROWS,
  batchMs = SQLITE_BATCH_MS,
  yieldMs = SQLITE_YIELD_MS,
  checkpointMs = SQLITE_CHECKPOINT_MS,
  now = Date.now,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  signal,
  log,
}: {
  duck: Database;
  db: Sqlite.Database;
  band: ParquetL2Band;
  bandDir: string;
  bandId: string;
  index: string;
  publisher: string;
  /** The highest height written: the gateway's stable L1 tip. */
  ceiling: number;
  hasBlock: (height: number) => boolean;
  /** The allow flags the band was accepted with, for the ledger. */
  accepted: string[];
  /** Refuses, before anything is written, when `items` would not fit. */
  checkRoom?: (items: number) => Promise<void>;
  batchRows?: number;
  batchMs?: number;
  yieldMs?: number;
  checkpointMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: { info(message: string, meta?: Record<string, unknown>): void };
}): Promise<L2SqliteOutcome> {
  const indexedAt = bandIndexedAt(band);
  const top = Math.min(band.heightRange[1], ceiling);
  const items = `read_parquet(${sqlString(path.join(bandDir, 'data_items.parquet'))})`;
  const tags = `read_parquet(${sqlString(path.join(bandDir, 'tags.parquet'))})`;
  const wallets = `read_parquet(${sqlString(path.join(bandDir, 'wallets.parquet'))})`;
  const one = async (sql: string) =>
    Number(Object.values((await duck.all(sql))[0])[0]);

  try {
    await createFirstPlacements(duck, bandDir, 'l2s_first');
    const bandRows = await one(`SELECT count(*) FROM ${items}`);
    const firstRows = await one('SELECT count(*) FROM l2s_first');
    const aboveCeiling = await one(
      `SELECT count(*) FROM l2s_first WHERE height > ${ceiling}`,
    );
    const unlocated = await one(
      `SELECT count(*) FROM l2s_first WHERE height <= ${ceiling} AND "offset" IS NULL`,
    );
    // The items to write, in the order they are written; each one's place
    // in it (rowid) is how a batch is read and its tags found.
    await duck.exec('SET preserve_insertion_order = true');
    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2s_items AS
      SELECT f.*, w.public_modulus
      FROM l2s_first f LEFT JOIN ${wallets} w ON w.address = f.owner_address
      WHERE f.height <= ${ceiling} AND f."offset" IS NOT NULL
      ORDER BY f.height, f.block_transaction_index, f.id`);
    await duck.exec('DROP TABLE l2s_first');
    const total = await one('SELECT count(*) FROM l2s_items');

    const missing: number[] = [];
    for (const { height } of (await duck.all(
      'SELECT DISTINCT height FROM l2s_items ORDER BY height',
    )) as Array<{ height: number | bigint }>) {
      if (!hasBlock(Number(height))) missing.push(Number(height));
    }
    if (missing.length > 0) {
      // SQLite GraphQL joins an item to its block by height: without it the
      // item would be written and never shown.
      throw new L2ImportRefused(
        `this gateway's core.db lacks ${missing.length} block(s) the band's items are at (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}): import or fill those heights first`,
      );
    }
    await checkRoom?.(total);

    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE l2s_tags AS
      SELECT i.rowid AS rn, t.tag_index, t.tag_name, t.tag_value
      FROM l2s_items i JOIN ${tags} t ON t.id = i.id AND t.height = i.height
      ORDER BY rn, t.tag_index`);

    // This connection only. NORMAL is safe with the WAL: a crash can lose
    // the last commits, never corrupt, and the ledger moves in the same
    // transactions as the rows, so it never runs ahead of them.
    db.pragma(`cache_size = -${SQLITE_CACHE_KIB}`);
    db.pragma('synchronous = NORMAL');
    const ledger = new SqliteImportLedger(db);
    ledger.started({
      bandId,
      index,
      publisher,
      heightFrom: band.heightRange[0],
      bandDigest: bandTablesDigest(band),
      accepted,
      startedAt: Math.floor(now() / 1000),
    });

    const stmt = {
      item: db.prepare(SQLITE_IMPORT_SQL.item),
      held: db.prepare(SQLITE_IMPORT_SQL.held),
      wallet: db.prepare(SQLITE_IMPORT_SQL.wallet),
      tagName: db.prepare(SQLITE_IMPORT_SQL.tagName),
      tagValue: db.prepare(SQLITE_IMPORT_SQL.tagValue),
      tag: db.prepare(SQLITE_IMPORT_SQL.tag),
    };
    const counts: L2SqliteCounts = {
      bandRows,
      otherPlacements: bandRows - firstRows,
      aboveCeiling,
      unlocated,
      present: 0,
      conflicting: 0,
      elsewhere: 0,
      alreadyImported: 0,
      written: 0,
      tags: 0,
      noOwnerKey: 0,
      typeFromTags: 0,
    };
    const conflictExamples: string[] = [];
    let lastCheckpoint = now();
    const seenHashes = new Set<string>();
    // Keyed by table too: one string can be a tag's name and another's value.
    const writeOnce = (
      table: 'n' | 'v',
      stmt: Sqlite.Statement,
      hash: Buffer,
      value: Buffer,
    ) => {
      const key = table + hash.toString('base64');
      if (seenHashes.has(key)) return;
      if (seenHashes.size >= SQLITE_SEEN_TAG_HASHES) seenHashes.clear();
      stmt.run(hash, value);
      seenHashes.add(key);
    };
    let open = false;
    let txStarted = 0;
    let inTx = {
      written: 0,
      present: 0,
      conflicting: 0,
      elsewhere: 0,
      rows: 0,
    };

    const commit = async () => {
      if (!open) return;
      ledger.addProgress(bandId, inTx);
      db.exec('COMMIT');
      open = false;
      inTx = {
        written: 0,
        present: 0,
        conflicting: 0,
        elsewhere: 0,
        rows: 0,
      };
      if (now() - lastCheckpoint >= checkpointMs) {
        checkpoint(db);
        lastCheckpoint = now();
      }
      if (yieldMs > 0) await sleep(yieldMs);
    };

    try {
      for (let from = 0; from < total; from += batchRows) {
        signal?.throwIfAborted();
        const to = from + batchRows - 1;
        // Read before the transaction opens: no lock is held while DuckDB works.
        const rows = (await duck.all(
          `SELECT rowid AS rn, * FROM l2s_items WHERE rowid BETWEEN ${from} AND ${to} ORDER BY rowid`,
        )) as ItemRow[];
        const tagsOf = new Map<number, TagRow[]>();
        for (const t of (await duck.all(
          `SELECT rn, tag_index, tag_name, tag_value FROM l2s_tags WHERE rn BETWEEN ${from} AND ${to} ORDER BY rn, tag_index`,
        )) as TagRow[]) {
          const rn = Number(t.rn);
          const list = tagsOf.get(rn);
          if (list === undefined) tagsOf.set(rn, [t]);
          else list.push(t);
        }

        for (const r of rows) {
          if (!open) {
            db.exec('BEGIN IMMEDIATE');
            open = true;
            txStarted = now();
          }
          const itemTags = tagsOf.get(Number(r.rn)) ?? [];
          // Served as the item's own (Content-Type and Content-Encoding on
          // its data, ranked as indexed), so taken from the tags its
          // signature covers, as the gateway takes them when it unbundles,
          // never from the band's separate columns, which no check binds.
          const contentType = firstTagValue(itemTags, 'content-type');
          const contentEncoding = firstTagValue(itemTags, 'content-encoding');
          const typeDiffers =
            contentType !== r.content_type ||
            contentEncoding !== r.content_encoding;
          const height = Number(r.height);
          const id = Buffer.from(r.id);
          const parentId = Buffer.from(r.parent_id);
          const rootId = Buffer.from(r.root_transaction_id);
          const values = {
            id,
            parent_id: parentId,
            root_transaction_id: rootId,
            height,
            block_transaction_index: r.block_transaction_index,
            // As the gateway stores an item without one: empty bytes.
            anchor: asBuffer(r.anchor) ?? EMPTY,
            owner_address: Buffer.from(r.owner_address),
            target: asBuffer(r.target) ?? EMPTY,
            data_offset: asNumber(r.data_offset),
            data_size: asNumber(r.data_size),
            content_type: contentType,
            tag_count: r.tag_count ?? itemTags.length,
            indexed_at: indexedAt,
            signature_type: r.signature_type,
            offset: asNumber(r.offset),
            size: asNumber(r.size),
            owner_offset: asNumber(r.owner_offset),
            owner_size: asNumber(r.owner_size),
            signature_offset: asNumber(r.signature_offset),
            signature_size: asNumber(r.signature_size),
            content_encoding: contentEncoding,
            root_parent_offset: asNumber(r.root_parent_offset),
          };
          inTx.rows += 1;
          if (stmt.item.run(values).changes === 1) {
            counts.written += 1;
            inTx.written += 1;
            if (typeDiffers) counts.typeFromTags += 1;
            if (r.public_modulus !== null) {
              stmt.wallet.run(values.owner_address, asBuffer(r.public_modulus));
            } else {
              counts.noOwnerKey += 1;
            }
            for (const t of itemTags) {
              const name = Buffer.from(t.tag_name);
              const value = Buffer.from(t.tag_value);
              const nameHash = hashTagPart(name);
              const valueHash = hashTagPart(value);
              writeOnce('n', stmt.tagName, nameHash, name);
              writeOnce('v', stmt.tagValue, valueHash, value);
              stmt.tag.run(
                nameHash,
                valueHash,
                height,
                r.block_transaction_index,
                t.tag_index,
                id,
                parentId,
                rootId,
              );
              counts.tags += 1;
            }
          } else {
            const held = stmt.held.get(id) as Record<string, unknown>;
            if (Number(held.indexed_at) === indexedAt) {
              counts.alreadyImported += 1;
            } else if (
              Number(held.height) !== height ||
              Number(held.block_transaction_index) !== r.block_transaction_index
            ) {
              counts.elsewhere += 1;
              inTx.elsewhere += 1;
            } else {
              counts.present += 1;
              inTx.present += 1;
              const differs = SQLITE_COMPARED_COLUMNS.some(
                (c) => !same(held[c], (values as Record<string, unknown>)[c]),
              );
              if (differs) {
                counts.conflicting += 1;
                inTx.conflicting += 1;
                if (conflictExamples.length < CONFLICT_EXAMPLES) {
                  conflictExamples.push(id.toString('hex').toUpperCase());
                }
              }
            }
          }
          if (inTx.rows >= batchRows || now() - txStarted >= batchMs) {
            await commit();
          }
        }
        // No transaction stays open while the next batch is read.
        await commit();
        log?.info('Wrote a batch of a band into SQLite', {
          bandId,
          done: Math.min(to + 1, total),
          of: total,
          written: counts.written,
        });
      }
    } catch (error) {
      if (open) db.exec('ROLLBACK');
      throw error;
    }

    checkpoint(db);
    ledger.completed({
      bandId,
      heightTo: top,
      unlocated,
      completedAt: Math.floor(now() / 1000),
    });
    return {
      heightRange: [band.heightRange[0], top],
      counts,
      conflictExamples,
    };
  } finally {
    for (const t of ['l2s_first', 'l2s_items', 'l2s_tags']) {
      await duck.exec(`DROP TABLE IF EXISTS ${t}`).catch(() => undefined);
    }
  }
}

/** Items removed per transaction by {@link forgetSqliteBand}. */
export const SQLITE_FORGET_BATCH = 5_000;

/**
 * Removes what imports of one band wrote into `bundles.db`: its items and
 * their tags (but not items the gateway has since unbundled itself, which
 * `bundle_data_items` records), a batch at a time beside the running gateway, then its ledger
 * row, and those of every other SQLite import over the same heights when
 * any row was removed. A row is the band's when its `indexed_at` and `stable_at` are both
 * the band's `createdAt`, as only the importer writes them; the gateway's
 * flush sets `stable_at` when it flushes, after the item was indexed. The
 * wallets and tag names an import added stay: other rows may use them.
 */
export async function forgetSqliteBand({
  db,
  bandId,
  heightRange,
  indexedAt,
  batch = SQLITE_FORGET_BATCH,
  yieldMs = SQLITE_YIELD_MS,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  db: Sqlite.Database;
  bandId: string;
  heightRange: [number, number];
  indexedAt: number;
  batch?: number;
  yieldMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  items: number;
  tags: number;
  keptIndexed: number;
  reset: string[];
}> {
  const select = db
    .prepare(
      `SELECT sdi.id FROM stable_data_items sdi
       WHERE sdi.indexed_at = ? AND sdi.stable_at = ?
         AND sdi.height BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM bundle_data_items bdi WHERE bdi.id = sdi.id)
       LIMIT ?`,
    )
    .pluck();
  // The band's rows the gateway has also unbundled itself: its flush found
  // the row there and left it (first writer wins), so the row is the
  // gateway's item too, and its bundle is done, so nothing would write it
  // again. Kept, with its tags.
  const keptIndexed = db
    .prepare(
      `SELECT COUNT(*) FROM stable_data_items sdi
       WHERE sdi.indexed_at = ? AND sdi.stable_at = ?
         AND sdi.height BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM bundle_data_items bdi WHERE bdi.id = sdi.id)`,
    )
    .pluck();
  const deleteTags = db.prepare(
    'DELETE FROM stable_data_item_tags WHERE data_item_id = ?',
  );
  const deleteItem = db.prepare('DELETE FROM stable_data_items WHERE id = ?');
  const forgetOwn = db.prepare(
    "DELETE FROM parquet_l2_imports WHERE band_id = ? AND target = 'sqlite'",
  );
  // Rows are told apart by `indexed_at`, the band's `createdAt`, and a band
  // republished over the same heights can carry the same one: its rows are
  // the ones removed here. Its ledger row goes too, so the next run writes
  // its items again (a run writes only what is missing), rather than
  // holding it complete over heights that are now empty.
  const forgetOverlapping = db
    .prepare(
      `DELETE FROM parquet_l2_imports
       WHERE target = 'sqlite' AND band_id != ?
         AND height_from <= ? AND height_to >= ?
       RETURNING band_id`,
    )
    .pluck();
  let items = 0;
  let tags = 0;
  let reset: string[] = [];
  let ledgerForgotten = false;
  for (;;) {
    const ids = select.all(
      indexedAt,
      indexedAt,
      heightRange[0],
      heightRange[1],
      batch,
    ) as Buffer[];
    if (ids.length === 0) break;
    db.exec('BEGIN IMMEDIATE');
    try {
      // The ledger rows go with the first rows deleted, in one transaction:
      // a forget stopped part way then leaves no band held complete over
      // heights it has emptied, and running it again finishes the rows.
      if (!ledgerForgotten) {
        forgetOwn.run(bandId);
        reset = forgetOverlapping.all(
          bandId,
          heightRange[1],
          heightRange[0],
        ) as string[];
      }
      for (const id of ids) {
        tags += deleteTags.run(id).changes;
        items += deleteItem.run(id).changes;
      }
      db.exec('COMMIT');
      ledgerForgotten = true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (yieldMs > 0) await sleep(yieldMs);
  }
  // Nothing of the band was left: only its own ledger row goes, and the
  // other imports over its heights, whose rows this removed nothing of,
  // keep theirs.
  if (!ledgerForgotten) forgetOwn.run(bandId);
  checkpoint(db);
  return {
    items,
    tags,
    keptIndexed: keptIndexed.get(
      indexedAt,
      indexedAt,
      heightRange[0],
      heightRange[1],
    ) as number,
    reset,
  };
}
