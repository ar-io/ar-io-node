/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Auditing the blocks whose `tx_root` an index cannot check on its own.
 *
 * Above the 2.0 fork a block's `tx_root` recomputes from its transactions,
 * which proves the exact set the block carried. One case escapes it: a
 * format-1 transaction's leaf is the root of *its data*, and an index does
 * not store that (`data_root` is a format-2 field). So any post-fork block
 * holding a v1 transaction with data cannot be checked from the index
 * alone. On the live chain that is 208,812 blocks of 1,592,566 — 13% of
 * everything above the fork (measured 2026-10-05).
 *
 * The gap closes by fetching those transactions' data, deriving each
 * `data_root`, and recomputing `tx_root` with them. This samples rather
 * than sweeps: the full set is about 912,729 transactions and 111 GB,
 * where a sample of a few hundred blocks costs a few hundred requests and
 * bounds the error rate.
 *
 * **The data source does not have to be trusted.** The check is the
 * comparison against `tx_root`, which the block's own identity hash
 * commits to. Data that is wrong, truncated or someone else's produces a
 * mismatch, never a false pass — forging a pass would mean finding data
 * whose merkle root reproduces a committed root. So a bad source can cry
 * wolf and cannot hide a real fault.
 *
 * It must still be the transaction's *own* data. The data route (`/raw/`,
 * `/{id}`) resolves content and will happily return something else: a
 * 1,614-byte transaction came back as an 8,847-byte SVG with a 200. The
 * transaction's `data` field is the authority, and the length is checked
 * against `data_size` before the bytes are used.
 */
import Sqlite from 'better-sqlite3';

import {
  ChainTransaction,
  checkTxRoot,
  FORK_2_0,
  v1DataRoot,
} from './chain.js';

/** How many sampled blocks are audited at once. Politeness, not throughput. */
export const AUDIT_CONCURRENCY = 3;

/** Blocks sampled when none is asked for. */
export const DEFAULT_SAMPLE = 100;

/**
 * Matching blocks listed in the result. Every block that did *not* match
 * is always listed, however many there are; the ones that did are the
 * noise, and a thousand of them is 65 KB of JSON nobody reads.
 */
export const MAX_MATCHES_LISTED = 20;

export class AuditRefused extends Error {}

export interface AuditedBlock {
  height: number;
  result: 'match' | 'mismatch' | 'unavailable';
  /** Why it could not be checked, for `unavailable`. */
  reason?: string;
  transactions: number;
  /** Format-1 transactions with data whose roots had to be derived. */
  derived: number;
  bytesFetched: number;
}

export interface AuditSummary {
  /** Post-fork blocks in range that the index cannot check alone. */
  population: number;
  sampled: number;
  matched: number;
  mismatched: number;
  unavailable: number;
  bytesFetched: number;
  /**
   * With no mismatch seen, the 95% upper bound on the share of the
   * population that is wrong — the rule of three, `3/n`. Absent once a
   * mismatch is found, because then the rate is measured, not bounded.
   */
  errorRateUpperBound95?: number;
  mismatchRate?: number;
}

/**
 * The heights an index cannot check on its own: at or above the 2.0 fork,
 * and holding at least one format-1 transaction with data.
 *
 * Read with the `(height, block_transaction_index)` index, so it is a
 * range scan rather than a table sweep.
 */
export function unverifiableBlocks(
  db: Sqlite.Database,
  { from, to }: { from: number; to: number },
): number[] {
  const low = Math.max(from, FORK_2_0);
  if (to < low) return [];
  return db
    .prepare(
      `SELECT DISTINCT height FROM stable_transactions
       WHERE height BETWEEN ? AND ? AND format = 1 AND data_size > 0
       ORDER BY height`,
    )
    .pluck()
    .all(low, to) as number[];
}

/**
 * `count` of `heights`, chosen without replacement.
 *
 * Random by default so a publisher cannot know in advance which blocks
 * will be looked at; `random` is injectable to make a run reproducible.
 */
export function pickSample(
  heights: readonly number[],
  count: number,
  random: () => number = Math.random,
): number[] {
  if (count >= heights.length) return [...heights];
  const pool = [...heights];
  const picked: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.floor(random() * pool.length);
    picked.push(pool[at]);
    pool[at] = pool[pool.length - 1];
    pool.pop();
  }
  return picked.sort((a, b) => a - b);
}

interface TxRow {
  id: Buffer;
  format: number;
  data_size: number | null;
  data_root: Buffer | null;
}

/** Fetches one transaction's own data, by base64url id. */
export type FetchTxData = (id: string) => Promise<Buffer>;

/**
 * Audits one block: derives a `data_root` for each format-1 transaction
 * carrying data, then recomputes `tx_root` and compares it with what the
 * block holds.
 */
export async function auditBlock(
  db: Sqlite.Database,
  height: number,
  fetchTxData: FetchTxData,
): Promise<AuditedBlock> {
  const block = db
    .prepare('SELECT tx_root FROM stable_blocks WHERE height = ?')
    .get(height) as { tx_root: Buffer | null } | undefined;
  if (block === undefined) {
    return {
      height,
      result: 'unavailable',
      reason: 'the index holds no block at this height',
      transactions: 0,
      derived: 0,
      bytesFetched: 0,
    };
  }
  const rows = db
    .prepare(
      `SELECT id, format, data_size, data_root FROM stable_transactions
       WHERE height = ? ORDER BY block_transaction_index`,
    )
    .all(height) as TxRow[];

  const supplied = new Map<string, Buffer>();
  let derived = 0;
  let bytesFetched = 0;
  for (const row of rows) {
    const size = Number(row.data_size ?? 0);
    if (row.format !== 1 || size <= 0) continue;
    const id = row.id.toString('base64url');
    let data: Buffer;
    try {
      data = await fetchTxData(id);
    } catch (error) {
      return {
        height,
        result: 'unavailable',
        reason: `${id}: ${(error as Error).message}`,
        transactions: rows.length,
        derived,
        bytesFetched,
      };
    }
    // The data route resolves content and can return bytes that are not
    // this transaction's. A wrong length is the cheap tell, and catching
    // it here keeps a bad source from being reported as a bad index.
    if (data.length !== size) {
      return {
        height,
        result: 'unavailable',
        reason: `${id}: got ${data.length} bytes where data_size says ${size}`,
        transactions: rows.length,
        derived,
        bytesFetched,
      };
    }
    supplied.set(id, await v1DataRoot(data));
    derived += 1;
    bytesFetched += data.length;
  }

  const txs: ChainTransaction[] = rows.map((row) => ({
    id: row.id,
    format: row.format,
    data_size: Number(row.data_size ?? 0),
    data_root: row.data_root,
  }));
  const ok = await checkTxRoot(
    { height, tx_root: block.tx_root },
    txs,
    supplied,
  );
  if (ok === undefined) {
    return {
      height,
      result: 'unavailable',
      reason: 'tx_root is not checkable at this height even with the data',
      transactions: rows.length,
      derived,
      bytesFetched,
    };
  }
  return {
    height,
    result: ok ? 'match' : 'mismatch',
    transactions: rows.length,
    derived,
    bytesFetched,
  };
}

/** Totals for a set of audited blocks, and what they bound. */
export function summarise(
  population: number,
  blocks: readonly AuditedBlock[],
): AuditSummary {
  const matched = blocks.filter((b) => b.result === 'match').length;
  const mismatched = blocks.filter((b) => b.result === 'mismatch').length;
  const unavailable = blocks.filter((b) => b.result === 'unavailable').length;
  const checked = matched + mismatched;
  const summary: AuditSummary = {
    population,
    sampled: blocks.length,
    matched,
    mismatched,
    unavailable,
    bytesFetched: blocks.reduce((sum, b) => sum + b.bytesFetched, 0),
  };
  if (checked > 0) {
    if (mismatched === 0) {
      // Rule of three: seeing none in n samples puts the 95% upper bound
      // at about 3/n. It says how little the sample rules out, which is
      // the honest reading of a clean result.
      summary.errorRateUpperBound95 = 3 / checked;
    } else {
      summary.mismatchRate = mismatched / checked;
    }
  }
  return summary;
}

/** Audits a sample of the blocks an index cannot check alone. */
export async function runAudit(
  db: Sqlite.Database,
  {
    from,
    to,
    sample = DEFAULT_SAMPLE,
    fetchTxData,
    random,
    concurrency = AUDIT_CONCURRENCY,
    onBlock,
  }: {
    from: number;
    to: number;
    sample?: number;
    fetchTxData: FetchTxData;
    random?: () => number;
    concurrency?: number;
    onBlock?: (block: AuditedBlock) => void;
  },
): Promise<{ summary: AuditSummary; blocks: AuditedBlock[] }> {
  const population = unverifiableBlocks(db, { from, to });
  if (population.length === 0) {
    throw new AuditRefused(
      `No block between ${from} and ${to} needs auditing: none above the 2.0 fork holds a format-1 transaction with data`,
    );
  }
  const heights = pickSample(population, sample, random);
  const blocks: AuditedBlock[] = [];
  for (let at = 0; at < heights.length; at += concurrency) {
    const batch = await Promise.all(
      heights
        .slice(at, at + concurrency)
        .map((height) => auditBlock(db, height, fetchTxData)),
    );
    for (const block of batch) {
      blocks.push(block);
      onBlock?.(block);
    }
  }
  return { summary: summarise(population.length, blocks), blocks };
}
