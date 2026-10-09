/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Exports one height range of a gateway's L1 index (`core.db`, read-only)
 * as a `parquet-l1` band, after checking the rows against the chain's own
 * consensus fields.
 *
 * - **Short reads.** `core.db` is read in windows of heights, a few
 *   statements each, every one by primary key or index, so no read holds back
 *   the live gateway's WAL checkpoint for long; the event loop runs between
 *   windows.
 * - **Scratch as text.** Rows are written to one scratch file per table, with
 *   every binary and text value hex-encoded (nothing to quote) and `\N` for
 *   null. DuckDB's built-in CSV reader and Parquet writer turn them into the
 *   band: no extension, so nothing is downloaded.
 * - **Row digests** are computed as rows are written, in each table's order.
 * - **Checks before anything publishes:** block links, `hash_list_merkle`
 *   (anchored to the block just below the range) and each block's `tx_root`.
 *   A band that fails them is refused; so are two wrong blocks a gateway kept
 *   from a fork (found this way on vilenarios.com, 2026-09-30).
 */
import crypto from 'node:crypto';
import { createWriteStream, WriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';

import {
  ChainBlock,
  ChainReport,
  ChainTransaction,
  checkBlockChain,
  checkTxRoot,
} from '../../../lib/parquet-l1/chain.js';
import { RowDigest } from '../../../lib/parquet/digest.js';
import { LookupDescription } from '../../../lib/parquet/lookups.js';
import { writeBandLookups } from '../../../lib/parquet-l1/lookups.js';
import {
  BAND_FILE,
  BandTag,
  canonicalDataRoot,
  canonicalTxRoot,
  firstTagValue,
  PARQUET_L1_SCHEMA,
  PARQUET_L1_TABLES,
  ParquetL1Band,
  TableSpec,
} from '../../../lib/parquet-l1/layout.js';

/**
 * Heights read per window: each window's transactions are held in memory,
 * and the chain's busiest stretches carry about a thousand to a block.
 */
export const EXPORT_WINDOW_HEIGHTS = 200;
const NULL = '\\N';

/** DuckDB's spill while sorting a table, at most. */
export const DUCKDB_SPILL_MAX_GB = 16;

const sha256 = (bytes: Buffer) =>
  crypto.createHash('sha256').update(bytes).digest();

export interface L1ExportResult {
  dir: string;
  band: ParquetL1Band;
  chain: ChainReport;
  txRoots: { checked: number; skipped: number; failed: number[] };
  /** Block links whose transaction row the index doesn't hold. */
  missingTransactions: number;
  /** Owners whose key the index doesn't hold: their `wallets` row is left out. */
  missingWallets: number;
  /** Rows in the range no block lists (a fork's leftovers): left out. */
  strayTransactions: number;
  /** Bytes of scratch at its peak, and of the finished band. */
  scratchBytes: number;
  bandBytes: number;
  seconds: number;
}

const table = (name: string): TableSpec =>
  PARQUET_L1_TABLES.find((t) => t.name === name) as TableSpec;

/**
 * Byte columns as bytes. The block importer stores an empty value (the
 * `tx_root` of every block before 2.0) as the text `''`; it is zero bytes.
 * Any other text in a byte column is refused, not guessed at.
 */
function normalizeBytes<T extends Record<string, unknown>>(
  rows: T[],
  spec: TableSpec,
): T[] {
  const blobs = spec.columns
    .filter((c) => c.type === 'BLOB')
    .map((c) => c.name);
  for (const row of rows) {
    for (const name of blobs) {
      const value = row[name];
      if (typeof value !== 'string') continue;
      if (value !== '') {
        throw new Error(
          `${spec.name}.${name} holds text where bytes belong: ${JSON.stringify(value.slice(0, 40))}`,
        );
      }
      (row as Record<string, unknown>)[name] = Buffer.alloc(0);
    }
  }
  return rows;
}

/** One scratch file and the digest of what is written to it. */
class ScratchTable {
  readonly digest: RowDigest;
  private readonly stream: WriteStream;
  private error?: Error;

  constructor(
    readonly spec: TableSpec,
    readonly file: string,
  ) {
    this.digest = new RowDigest(spec.columns);
    this.stream = createWriteStream(file);
    this.stream.on('error', (error) => {
      this.error ??= error;
    });
  }

  async write(values: unknown[]): Promise<void> {
    if (this.error !== undefined) throw this.error;
    this.digest.add(values);
    const line = values
      .map((value, i) => encodeField(value, this.spec.columns[i].type))
      .join(',');
    if (!this.stream.write(`${line}\n`)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.stream.end((error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (this.error !== undefined) throw this.error;
  }
}

function encodeField(value: unknown, type: string): string {
  if (value === null || value === undefined) return NULL;
  if (type === 'BLOB') return Buffer.from(value as Uint8Array).toString('hex');
  if (type === 'VARCHAR')
    return Buffer.from(String(value), 'utf8').toString('hex');
  if (type === 'BOOLEAN')
    return value === true || value === 1 ? 'true' : 'false';
  return String(value);
}

/** The DuckDB expression turning a scratch column back into its layout type. */
function decodeColumn(name: string, type: string): string {
  const column = `"${name}"`;
  if (type === 'BLOB') return `from_hex(${column}) AS ${column}`;
  if (type === 'VARCHAR') return `decode(from_hex(${column})) AS ${column}`;
  return `CAST(${column} AS ${type}) AS ${column}`;
}

interface CoreStatements {
  blocks: Sqlite.Statement;
  links: Sqlite.Statement;
  transactions: Sqlite.Statement;
  tags: Sqlite.Statement;
  tagValue: Sqlite.Statement;
  wallet: Sqlite.Statement;
  blockCount: Sqlite.Statement;
  blockAt: Sqlite.Statement;
}

/**
 * The statements an export runs on `core.db`, each by primary key or index.
 * `stable_block_transactions` declares its columns `BYTEA`, which gives them
 * numeric affinity, so a join to `stable_transactions.id` can't use the key:
 * links are looked up per block, rows per id.
 */
export function prepareCoreStatements(db: Sqlite.Database): CoreStatements {
  return {
    blocks: db.prepare(`
      SELECT indep_hash, height, previous_block, nonce, hash, block_timestamp,
        tx_count, block_size, diff, cumulative_diff, last_retarget,
        reward_addr, reward_pool, weave_size, usd_to_ar_rate_dividend,
        usd_to_ar_rate_divisor, scheduled_usd_to_ar_rate_dividend,
        scheduled_usd_to_ar_rate_divisor, hash_list_merkle, wallet_list, tx_root
      FROM stable_blocks WHERE height BETWEEN ? AND ? ORDER BY height`),
    links: db.prepare(`
      SELECT transaction_id, block_transaction_index
      FROM stable_block_transactions WHERE block_indep_hash = ?`),
    transactions: db.prepare(`
      SELECT id, block_transaction_index, target, quantity, reward,
        last_tx, data_size, content_type, format, height, owner_address,
        data_root, offset, content_encoding, tag_count, signature
      FROM stable_transactions WHERE height BETWEEN ? AND ?
      ORDER BY height, block_transaction_index`),
    tags: db.prepare(`
      SELECT tag_name_hash, tag_value_hash, transaction_tag_index
      FROM stable_transaction_tags
      WHERE transaction_id = ? AND height = ? AND block_transaction_index = ?`),
    tagValue: db.prepare('SELECT value FROM tag_values WHERE hash = ?').pluck(),
    wallet: db.prepare(
      'SELECT address, public_modulus FROM wallets WHERE address = ?',
    ),
    blockCount: db
      .prepare(
        'SELECT COUNT(*) FROM stable_blocks WHERE height BETWEEN ? AND ?',
      )
      .pluck(),
    blockAt: db.prepare(`
      SELECT height, indep_hash, previous_block, weave_size, tx_root,
        hash_list_merkle FROM stable_blocks WHERE height = ?`),
  };
}

/**
 * Exports `[from, to]` from `coreDbPath` into a new directory under
 * `workDir`, checks it, and returns it ready to publish. The directory is
 * the caller's to rename into place or remove.
 *
 * @throws when the range fails the chain checks, naming the heights.
 */
export async function exportL1Band({
  coreDbPath,
  workDir,
  from,
  to,
  supersedes = [],
  windowHeights = EXPORT_WINDOW_HEIGHTS,
  requireComplete = false,
}: {
  coreDbPath: string;
  workDir: string;
  from: number;
  to: number;
  supersedes?: string[];
  windowHeights?: number;
  /**
   * Refuse the range (as incomplete) unless every listed transaction and
   * owner's key is in the index and the block above is there to anchor it:
   * a whole band is never rebuilt, so it waits rather than keep a gap.
   */
  requireComplete?: boolean;
}): Promise<L1ExportResult> {
  const started = Date.now();
  const staging = await fs.mkdtemp(path.join(workDir, '.band-build-l1-'));
  const scratchDir = path.join(staging, 'scratch');
  const bandDir = path.join(staging, 'band');
  await fs.mkdir(scratchDir);
  await fs.mkdir(bandDir);

  const db = new Sqlite(coreDbPath, { readonly: true, fileMustExist: true });
  const scratch = new Map(
    PARQUET_L1_TABLES.map((spec) => [
      spec.name,
      new ScratchTable(spec, path.join(scratchDir, `${spec.name}.csv`)),
    ]),
  );
  const write = (name: string, values: unknown[]) =>
    (scratch.get(name) as ScratchTable).write(values);
  try {
    const sql = prepareCoreStatements(db);
    const held = sql.blockCount.get(from, to) as number;
    if (held !== to - from + 1) {
      throw new L1IncompleteError(
        `core.db holds ${held} of the ${to - from + 1} blocks at heights ${from}-${to}`,
      );
    }
    const tagNames = new Map(
      (
        db.prepare('SELECT hash, name FROM tag_names').all() as Array<{
          hash: Buffer;
          name: Buffer;
        }>
      ).map((row) => [row.hash.toString('hex'), row.name]),
    );
    const owners = new Set<string>();
    const chainBlocks: ChainBlock[] = [];
    const txRoots = { checked: 0, skipped: 0, failed: [] as number[] };
    let missingTransactions = 0;
    let missingWallets = 0;
    let strayTransactions = 0;
    const positionFailures: number[] = [];
    const signatureFailures: number[] = [];
    const walletFailures: string[] = [];

    for (let start = from; start <= to; start += windowHeights) {
      const end = Math.min(to, start + windowHeights - 1);
      const blocks = normalizeBytes(
        sql.blocks.all(start, end) as Array<Record<string, any>>,
        table('blocks'),
      );
      // One value for a pre-fork `tx_root`, whatever this gateway's header
      // source gave it, so two publishers of the same chain write the same
      // rows. Nothing checks a pre-fork `tx_root`: `checkTxRoot` skips
      // below the fork, where the protocol has no such field.
      for (const block of blocks) {
        block.tx_root = canonicalTxRoot(block.height, block.tx_root);
      }
      const txs = normalizeBytes(
        sql.transactions.all(start, end) as Array<Record<string, any>>,
        table('transactions'),
      );
      const txById = new Map(txs.map((tx) => [tx.id.toString('hex'), tx]));
      // Only transactions a checked block lists are written: a row a fork
      // left in the range is counted, never published.
      let linked = 0;

      for (const block of blocks) {
        await write(
          'blocks',
          table('blocks').columns.map((c) => block[c.name]),
        );
        chainBlocks.push({
          height: block.height,
          indep_hash: block.indep_hash,
          previous_block: block.previous_block,
          weave_size: block.weave_size,
          tx_root: block.tx_root,
          hash_list_merkle: block.hash_list_merkle,
        });
        const links = (
          sql.links.all(block.indep_hash) as Array<{
            transaction_id: Buffer;
            block_transaction_index: number;
          }>
        ).sort((a, b) => a.block_transaction_index - b.block_transaction_index);
        const blockTxs: Array<Record<string, any>> = [];
        let complete = true;
        for (const link of links) {
          await write('block_transactions', [
            block.height,
            link.block_transaction_index,
            link.transaction_id,
          ]);
          const tx = txById.get(
            Buffer.from(link.transaction_id).toString('hex'),
          );
          if (tx === undefined) {
            missingTransactions += 1;
            complete = false;
          } else if (
            tx.height !== block.height ||
            tx.block_transaction_index !== link.block_transaction_index
          ) {
            positionFailures.push(block.height);
          } else if (
            tx.signature !== null &&
            !sha256(tx.signature).equals(tx.id)
          ) {
            // A transaction's id is the SHA-256 of its signature.
            signatureFailures.push(block.height);
          } else {
            blockTxs.push(tx);
          }
        }
        linked += blockTxs.length;
        if (complete) {
          const ok = await checkTxRoot(
            block as ChainBlock,
            blockTxs as ChainTransaction[],
          );
          if (ok === undefined) txRoots.skipped += 1;
          else if (ok) txRoots.checked += 1;
          else txRoots.failed.push(block.height);
        } else {
          txRoots.skipped += 1;
        }

        // Tags in the table's order: by id, then position, within the height.
        const tags: unknown[][] = [];
        for (const tx of blockTxs) {
          // The tags first: the row's content type and encoding come from
          // them, by one rule, not from whatever core.db holds.
          const txTags: BandTag[] = [];
          for (const tag of sql.tags.all(
            tx.id,
            tx.height,
            tx.block_transaction_index,
          ) as Array<{
            tag_name_hash: Buffer;
            tag_value_hash: Buffer;
            transaction_tag_index: number;
          }>) {
            const name = tagNames.get(tag.tag_name_hash.toString('hex'));
            const value = sql.tagValue.get(tag.tag_value_hash) as
              | Buffer
              | undefined;
            if (name === undefined || value === undefined) {
              throw new Error(
                `Transaction ${tx.id.toString('base64url')} at ${tx.height} has a tag missing from the dictionary`,
              );
            }
            txTags.push({ index: tag.transaction_tag_index, name, value });
          }
          const canonical: Record<string, unknown> = {
            data_root: canonicalDataRoot(tx.format, tx.data_root),
            content_type: firstTagValue(txTags, 'Content-Type'),
            content_encoding: firstTagValue(txTags, 'Content-Encoding'),
          };
          await write(
            'transactions',
            table('transactions').columns.map((c) =>
              c.name === 'is_data_item'
                ? false
                : c.name === 'anchor'
                  ? tx.last_tx
                  : c.name in canonical
                    ? canonical[c.name]
                    : tx[c.name],
            ),
          );
          owners.add(tx.owner_address.toString('hex'));
          for (const tag of txTags) {
            tags.push([
              tx.height,
              tx.id,
              tag.index,
              tag.name,
              tag.value,
              false,
            ]);
          }
        }
        tags.sort(
          (a, b) =>
            Buffer.compare(a[1] as Buffer, b[1] as Buffer) ||
            (a[2] as number) - (b[2] as number),
        );
        for (const row of tags) await write('tags', row);
      }
      strayTransactions += txs.length - linked;
      // Let the heartbeat and anything else in the process run.
      await setImmediate();
    }

    for (const owner of [...owners].sort()) {
      const wallet = sql.wallet.get(Buffer.from(owner, 'hex')) as
        | { address: Buffer; public_modulus: Buffer | null }
        | undefined;
      if (wallet === undefined || wallet.public_modulus === null) {
        missingWallets += 1;
        continue;
      }
      // An address is the SHA-256 of its owner's key (RSA or ECDSA alike).
      if (!sha256(wallet.public_modulus).equals(wallet.address)) {
        walletFailures.push(wallet.address.toString('base64url'));
        continue;
      }
      await write('wallets', [wallet.address, wallet.public_modulus]);
    }
    for (const file of scratch.values()) await file.close();

    // Checks, before any Parquet is written. The band's first block links to
    // the one below it, and its last is anchored by the one above: a fork
    // block at either edge would otherwise chain to its canonical neighbour.
    const below =
      from > 0
        ? (sql.blockAt.get(from - 1) as Record<string, unknown> | undefined)
        : undefined;
    const prior =
      below === undefined
        ? undefined
        : (normalizeBytes(
            [below],
            table('blocks'),
          )[0] as unknown as ChainBlock);
    const chain = checkBlockChain(chainBlocks, prior);
    if (chainBlocks.length !== to - from + 1) {
      chain.failures.push({
        height: from,
        check: 'contiguous',
        detail: `${chainBlocks.length} blocks for ${to - from + 1} heights`,
      });
    }
    const above = sql.blockAt.get(to + 1) as
      | { previous_block: Buffer }
      | undefined;
    const top = chainBlocks.at(-1);
    if (
      above !== undefined &&
      top !== undefined &&
      !Buffer.from(above.previous_block).equals(Buffer.from(top.indep_hash))
    ) {
      chain.failures.push({
        height: to,
        check: 'anchor',
        detail: `block ${to + 1} doesn't build on it`,
      });
    }
    for (const height of signatureFailures) {
      chain.failures.push({
        height,
        check: 'signature',
        detail: "a transaction's id isn't the hash of its signature",
      });
    }
    for (const height of positionFailures) {
      chain.failures.push({
        height,
        check: 'position',
        detail: 'a listed transaction is indexed at another height or position',
      });
    }
    if (
      chain.failures.length > 0 ||
      txRoots.failed.length > 0 ||
      walletFailures.length > 0
    ) {
      const problems = [
        ...chain.failures.map((f) => `${f.height} (${f.check})`),
        ...txRoots.failed.map((h) => `${h} (tx_root)`),
        ...walletFailures.map((a) => `wallet ${a} (address)`),
      ];
      throw new L1CheckError(
        `Heights ${from}-${to} fail the chain checks at ${problems.slice(0, 10).join(', ')}${problems.length > 10 ? ` and ${problems.length - 10} more` : ''}`,
      );
    }
    if (
      requireComplete &&
      (missingTransactions > 0 || missingWallets > 0 || above === undefined)
    ) {
      throw new L1IncompleteError(
        above === undefined
          ? `core.db has no block ${to + 1} to anchor heights ${from}-${to}`
          : `core.db lacks ${missingTransactions} transactions and ${missingWallets} owners' keys at heights ${from}-${to}; a whole band waits for them`,
      );
    }

    const scratchBytes = await directoryBytes(scratchDir);
    const lookups = await writeParquet(bandDir, staging, scratch);
    await fs.rm(scratchDir, { recursive: true, force: true });

    const band: ParquetL1Band = {
      version: 1,
      schema: PARQUET_L1_SCHEMA,
      heightRange: [from, to],
      tables: Object.fromEntries(
        [...scratch.values()].map((file) => [
          file.spec.name,
          { rows: file.digest.rows, rowDigest: file.digest.hex() },
        ]),
      ),
      lookups,
      ...(supersedes.length > 0 ? { supersedes } : {}),
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(bandDir, BAND_FILE),
      JSON.stringify(band, null, 2),
    );
    return {
      dir: bandDir,
      band,
      chain,
      txRoots,
      missingTransactions,
      missingWallets,
      strayTransactions,
      scratchBytes,
      bandBytes: await directoryBytes(bandDir),
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    for (const file of scratch.values())
      await file.close().catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    db.close();
  }
}

/** Rows that fail the chain checks: a band is refused, not retried. */
export class L1CheckError extends Error {}

/**
 * A read of `core.db` that failed for a reason that passes: the gateway
 * writes to it while this reads, and a reader riding along on another
 * process's WAL index can be refused during a checkpoint or a WAL restart.
 * SQLite reports that as a write to a read-only database, which it isn't.
 */
export function isTransientSqliteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === 'string' &&
    /^SQLITE_(READONLY|BUSY|PROTOCOL|IOERR)/.test(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /attempt to write a readonly database|database is locked|database table is locked|locking protocol/i.test(
    message,
  );
}

/**
 * `core.db` doesn't hold every block of the range, as when the gateway
 * started above it (`START_HEIGHT`). Nothing is wrong with what it holds,
 * but no band can be built from it.
 */
export class L1IncompleteError extends Error {}

/**
 * A DuckDB for writing a band's Parquet: 1 GB and two threads, spilling a
 * large sort into `staging` (the bands' volume, cleared with it), never the
 * container's own layer, and bounded. Used for a new band's tables and
 * lookups, and for deriving a published band's lookups.
 */
export async function withBandWriter<T>(
  staging: string,
  run: (duck: Database) => Promise<T>,
): Promise<T> {
  const { Database } = await import('duckdb-async');
  const duck = await Database.create(':memory:');
  const spill = path.join(staging, 'spill');
  try {
    await fs.mkdir(spill, { recursive: true });
    await duck.exec(
      `SET memory_limit = '1GB'; SET threads = 2; SET preserve_insertion_order = false; SET temp_directory = '${spill.replace(/'/g, "''")}'; SET max_temp_directory_size = '${DUCKDB_SPILL_MAX_GB}GB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
    );
    return await run(duck);
  } finally {
    await duck.close();
    await fs.rm(spill, { recursive: true, force: true });
  }
}

/**
 * Writes a band's tables from its scratch files, then derives its lookups
 * from those tables, and returns the lookups' descriptions.
 */
async function writeParquet(
  bandDir: string,
  staging: string,
  scratch: Map<string, ScratchTable>,
): Promise<Record<string, LookupDescription>> {
  return withBandWriter(staging, async (duck) => {
    for (const file of scratch.values()) {
      const spec = file.spec;
      const columns = spec.columns
        .map((c) => `'${c.name}': 'VARCHAR'`)
        .join(', ');
      const source = `read_csv('${file.file.replace(/'/g, "''")}', header = false, delim = ',', auto_detect = false, nullstr = '\\N', columns = {${columns}})`;
      const select = spec.columns
        .map((c) => decodeColumn(c.name, c.type))
        .join(', ');
      const target = path.join(bandDir, spec.file).replace(/'/g, "''");
      await duck.exec(
        `COPY (SELECT ${select} FROM ${source} ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}) TO '${target}' (FORMAT PARQUET, COMPRESSION 'zstd')`,
      );
    }
    return writeBandLookups(duck, bandDir, bandDir);
  });
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await fs.readdir(dir)) {
    total += (await fs.stat(path.join(dir, name))).size;
  }
  return total;
}
