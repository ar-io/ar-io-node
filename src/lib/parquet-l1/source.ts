/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * What an L1 verification reads, whatever holds the index: a gateway's
 * `core.db` (`core-db-source.ts`) or a directory of bands
 * (`bands-source.ts`). The run (`verify-run.ts`) drives one of these and
 * judges what it returns with `judge.ts`, so the two readers cannot drift
 * on what counts as right.
 */
import type { L1BlockRow } from './anchor.js';
import type { JudgeBlock, L1Judge } from './judge.js';
import type { IndexedTx } from './tx-signature.js';

/** A part of the index a transaction sample is drawn from: a band, or a band-sized run of heights. */
export interface L1Stratum {
  /** A band's id, or `h<from>-<to>` for a run of a `core.db`. */
  id: string;
  from: number;
  to: number;
}

/** A transaction drawn for the signature sample, or why the index cannot give it whole. */
export type DrawnTx =
  | { tx: IndexedTx }
  | { id: Buffer; height: number; problem: string };

export interface L1Source {
  /** Judges every block of `[from, to]` in height order, `window` heights per read. */
  judge(
    judge: L1Judge,
    from: number,
    to: number,
    window: number,
  ): Promise<void>;
  /** The index's block at a height, or undefined when it holds none. */
  blockAt(height: number): Promise<L1BlockRow | undefined>;
  /** A block's transaction ids by `block_transaction_index`: from its links and from its transactions. */
  idsAt(height: number): Promise<{ links: Buffer[]; txs: Buffer[] }>;
  /** The parts the transaction sample is drawn from, per stratum, covering `[from, to]`. */
  strata(from: number, to: number): L1Stratum[];
  /**
   * `n` transactions of a stratum drawn uniformly by `key`
   * (`sha256("<key>:<row>")` order), within `[from, to]`, each with its
   * owner's key and its tags in order.
   */
  drawTxs(
    stratum: L1Stratum,
    key: string,
    n: number,
    from: number,
    to: number,
    /** Draw only format-1 transactions with data, of blocks at or above the 2.0 fork. */
    filter?: { format1Unbound?: boolean },
  ): Promise<DrawnTx[]>;
}

/** Rows a reader turns into {@link JudgeBlock}s: shared so both readers group alike. */
export interface WindowRows {
  blocks: JudgeBlock['row'][];
  /** Transactions in (height, block_transaction_index) order, each with its height. */
  txs: Array<JudgeBlock['txs'][number] & { height: number }>;
  /** Links in (height, block_transaction_index) order. */
  links: Array<{
    height: number;
    block_transaction_index: number;
    transaction_id: Buffer | null;
  }>;
}

/**
 * Groups a window's rows into blocks, joining each transaction to the link
 * at its position, and reports through `judge` any transaction or link at
 * a height the window holds no block for.
 */
export function groupWindow(rows: WindowRows, judge: L1Judge): JudgeBlock[] {
  const byHeight = new Map<number, JudgeBlock>();
  for (const row of rows.blocks) {
    byHeight.set(row.height, { row, txs: [], strayLinks: [] });
  }
  const linksAt = new Map<number, Map<number, Array<Buffer | null>>>();
  for (const link of rows.links) {
    if (!byHeight.has(link.height)) {
      judge.fail(
        'rows',
        link.height,
        `a block_transactions row at ${link.height}, where there is no block`,
        'links only at heights with a block',
      );
      continue;
    }
    const at = linksAt.get(link.height) ?? new Map();
    at.set(link.block_transaction_index, [
      ...(at.get(link.block_transaction_index) ?? []),
      link.transaction_id,
    ]);
    linksAt.set(link.height, at);
  }
  for (const tx of rows.txs) {
    const block = byHeight.get(tx.height);
    if (block === undefined) {
      judge.fail(
        'rows',
        tx.height,
        `a transaction ${tx.id?.toString('base64url') ?? 'null'} at ${tx.height}, where there is no block`,
        'transactions only at heights with a block',
      );
      continue;
    }
    const at = linksAt.get(tx.height);
    const named = at?.get(tx.block_transaction_index) ?? [];
    at?.delete(tx.block_transaction_index);
    const { height: _height, ...rest } = tx;
    void _height;
    // Two links at one position name two transactions for one place.
    block.txs.push({ ...rest, link: named.length === 1 ? named[0] : null });
    if (named.length > 1) {
      for (const id of named.slice(1)) {
        block.strayLinks.push({
          block_transaction_index: tx.block_transaction_index,
          id,
        });
      }
    }
  }
  for (const [height, at] of linksAt) {
    const block = byHeight.get(height) as JudgeBlock;
    for (const [index, ids] of at) {
      for (const id of ids) {
        block.strayLinks.push({ block_transaction_index: index, id });
      }
    }
  }
  return [...byHeight.values()].sort((a, b) => a.row.height - b.row.height);
}
