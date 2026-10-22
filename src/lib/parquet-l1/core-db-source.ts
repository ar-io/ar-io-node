/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Reading a gateway's `core.db` for an L1 verification (`source.ts`).
 *
 * Read-only, and every query is bounded by height through an index
 * (`stable_blocks` by its primary key, `stable_transactions` by
 * `(height, block_transaction_index)`, links through the block hash, tags
 * through `transaction_id`), so it is safe beside a running gateway. One
 * thing is not checked here: whether every tag row belongs to a
 * transaction. The tags table has no height index, so finding a tag row
 * with no transaction means reading all of it; such a row is unreachable
 * by every reader (each finds tags through their transaction), and the run
 * says it skipped the check.
 */
import crypto from 'node:crypto';
import Sqlite from 'better-sqlite3';

import { BLOCK_ROW_COLUMNS, type L1BlockRow } from './anchor.js';
import type { JudgeBlockRow, L1Judge } from './judge.js';
import { L1_SPAN, l1RangeOf } from './layout.js';
import type { IndexedTx } from './tx-signature.js';
import { drawByKey } from '../index-band/draw.js';
import {
  groupWindow,
  type DrawnTx,
  type L1Source,
  type L1Stratum,
  type WindowRows,
} from './source.js';

const BLOB_COLUMNS = [
  'indep_hash',
  'previous_block',
  'nonce',
  'hash',
  'reward_addr',
  'hash_list_merkle',
  'wallet_list',
  'tx_root',
] as const;

/**
 * A block row with its binaries as `Buffer`s: `core.db` holds a pre-2.0 or
 * empty block's `tx_root` as the text `''`, which is the empty binary.
 */
export function blockRow<T extends L1BlockRow>(row: T): T {
  const out: Record<string, unknown> = { ...(row as object) };
  for (const column of BLOB_COLUMNS) {
    const value = out[column];
    if (typeof value === 'string') out[column] = Buffer.from(value, 'utf8');
  }
  return out as T;
}

/** Owners whose wallet row was checked, kept so each is hashed once per run. */
const CHECKED_WALLETS_KEPT = 1_000_000;

export class CoreDbSource implements L1Source {
  private readonly checkedWallets = new Set<string>();

  constructor(private readonly db: Sqlite.Database) {}

  async judge(
    judge: L1Judge,
    from: number,
    to: number,
    window: number,
  ): Promise<void> {
    const blocks = this.db.prepare(
      `SELECT ${BLOCK_ROW_COLUMNS.join(', ')}, tx_count FROM stable_blocks
       WHERE height BETWEEN ? AND ? ORDER BY height`,
    );
    const txs = this.db.prepare(
      `SELECT t.height, t.block_transaction_index, t.id, t.format, t.data_size,
              t.data_root, t.owner_address, t.tag_count,
              (t.quantity IS NULL OR t.reward IS NULL OR t.last_tx IS NULL) AS null_amounts,
              g.n, g.mn, g.mx, g.d,
              (g.n IS NOT NULL AND (g.lh <> t.height OR g.hh <> t.height
                OR g.lb <> t.block_transaction_index
                OR g.hb <> t.block_transaction_index)) AS misplaced,
              (w.address IS NOT NULL AND w.public_modulus IS NOT NULL) AS owner_known,
              w.public_modulus AS modulus
       FROM stable_transactions t
       LEFT JOIN (
         SELECT transaction_id,
                COUNT(*) AS n, MIN(transaction_tag_index) AS mn,
                MAX(transaction_tag_index) AS mx,
                COUNT(DISTINCT transaction_tag_index) AS d,
                MIN(height) AS lh, MAX(height) AS hh,
                MIN(block_transaction_index) AS lb,
                MAX(block_transaction_index) AS hb
         FROM stable_transaction_tags
         WHERE transaction_id IN
           (SELECT id FROM stable_transactions WHERE height BETWEEN ? AND ?)
         GROUP BY transaction_id
       ) g ON g.transaction_id = t.id
       LEFT JOIN wallets w ON w.address = t.owner_address
       WHERE t.height BETWEEN ? AND ?
       ORDER BY t.height, t.block_transaction_index`,
    );
    const links = this.db.prepare(
      `SELECT b.height, l.block_transaction_index, l.transaction_id
       FROM stable_blocks b
       JOIN stable_block_transactions l ON l.block_indep_hash = b.indep_hash
       WHERE b.height BETWEEN ? AND ?
       ORDER BY b.height, l.block_transaction_index`,
    );
    for (let at = from; at <= to; at += window) {
      const end = Math.min(to, at + window - 1);
      const rows: WindowRows = {
        blocks: (blocks.all(at, end) as JudgeBlockRow[]).map(blockRow),
        txs: (txs.all(at, end, at, end) as Array<Record<string, any>>).map(
          (r) => {
            const owner = r.owner_address as Buffer | null;
            if (owner !== null && r.modulus !== null) {
              this.checkWallet(judge, r.height, owner, r.modulus);
            }
            return {
              height: r.height,
              block_transaction_index: r.block_transaction_index,
              id: r.id,
              format: r.format,
              data_size: r.data_size,
              data_root: r.data_root,
              owner_address: owner,
              tag_count: r.tag_count,
              nullAmounts: r.null_amounts === 1,
              link: null,
              tags: {
                n: r.n ?? 0,
                min: r.mn ?? null,
                max: r.mx ?? null,
                distinct: r.d ?? 0,
                // Read by id alone, as GraphQL reads them: a tag row under
                // this id at another height or position is served with it.
                misplaced: r.misplaced === 1 ? 1 : 0,
              },
              ownerKnown: r.owner_known === 1,
            };
          },
        ),
        links: links.all(at, end) as WindowRows['links'],
      };
      for (const block of groupWindow(rows, judge)) await judge.step(block);
    }
    // Transactions above or below every block the database holds: read
    // through the height index, from each end.
    const span = this.db
      .prepare('SELECT MIN(height) AS lo, MAX(height) AS hi FROM stable_blocks')
      .get() as { lo: number | null; hi: number | null };
    if (span.lo !== null && span.hi !== null) {
      const outside = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM stable_transactions WHERE height < ?)
                + (SELECT COUNT(*) FROM stable_transactions WHERE height > ?) AS n`,
        )
        .get(span.lo, span.hi) as { n: number };
      if (outside.n > 0) {
        judge.fail(
          'rows',
          span.hi,
          `${outside.n} transaction(s) outside heights ${span.lo}-${span.hi}, where core.db holds no block`,
          'transactions only at heights with a block',
        );
      }
    }
  }

  private checkWallet(
    judge: L1Judge,
    height: number,
    address: Buffer,
    modulus: Buffer,
  ): void {
    const key = address.toString('hex');
    if (this.checkedWallets.has(key)) return;
    if (this.checkedWallets.size >= CHECKED_WALLETS_KEPT) {
      this.checkedWallets.clear();
    }
    this.checkedWallets.add(key);
    if (!crypto.createHash('sha256').update(modulus).digest().equals(address)) {
      judge.fail(
        'wallets',
        height,
        `wallet ${address.toString('base64url')} holds a key that hashes elsewhere`,
        'address = SHA-256(key)',
      );
    }
  }

  async blockAt(height: number): Promise<L1BlockRow | undefined> {
    const row = this.db
      .prepare(
        `SELECT ${BLOCK_ROW_COLUMNS.join(', ')} FROM stable_blocks WHERE height = ?`,
      )
      .get(height) as L1BlockRow | undefined;
    return row === undefined ? undefined : blockRow(row);
  }

  async idsAt(height: number): Promise<{ links: Buffer[]; txs: Buffer[] }> {
    const links = this.db
      .prepare(
        `SELECT l.transaction_id FROM stable_blocks b
         JOIN stable_block_transactions l ON l.block_indep_hash = b.indep_hash
         WHERE b.height = ? ORDER BY l.block_transaction_index`,
      )
      .pluck()
      .all(height) as Buffer[];
    const txs = this.db
      .prepare(
        'SELECT id FROM stable_transactions WHERE height = ? ORDER BY block_transaction_index',
      )
      .pluck()
      .all(height) as Buffer[];
    return { links, txs };
  }

  strata(from: number, to: number): L1Stratum[] {
    const out: L1Stratum[] = [];
    for (let at = l1RangeOf(from)[0]; at <= to; at += L1_SPAN) {
      const [lo, hi] = l1RangeOf(at);
      out.push({
        id: `h${lo}-${hi}`,
        from: Math.max(lo, from),
        to: Math.min(hi, to),
      });
    }
    return out;
  }

  async drawTxs(
    stratum: L1Stratum,
    key: string,
    n: number,
    from: number,
    to: number,
    filter: { format1Unbound?: boolean } = {},
  ): Promise<DrawnTx[]> {
    const lo = Math.max(stratum.from, from);
    const hi = Math.min(stratum.to, to);
    if (hi < lo || n <= 0) return [];
    // Every position of the stratum, through the height index; the draw
    // keeps only the smallest ranks as it goes.
    const positions = this.db
      .prepare(
        `SELECT height, block_transaction_index FROM stable_transactions
         WHERE height BETWEEN ? AND ?${filter.format1Unbound === true ? ' AND format = 1 AND data_size > 0' : ''}
         ORDER BY height, block_transaction_index`,
      )
      .raw()
      .iterate(lo, hi) as IterableIterator<[number, number]>;
    const drawn = drawByKey(positions, n, key, ([h, i]) => `${h}:${i}`);
    const row = this.db.prepare(
      `SELECT t.id, t.height, t.format, t.target, t.quantity, t.reward,
              t.last_tx, t.data_size, t.data_root, w.public_modulus
       FROM stable_transactions t LEFT JOIN wallets w ON w.address = t.owner_address
       WHERE t.height = ? AND t.block_transaction_index = ?`,
    );
    const tags = this.db.prepare(
      `SELECT n.name, v.value FROM stable_transaction_tags g
       JOIN tag_names n ON n.hash = g.tag_name_hash
       JOIN tag_values v ON v.hash = g.tag_value_hash
       WHERE g.transaction_id = ? ORDER BY g.transaction_tag_index`,
    );
    return drawn.map(([h, i]) => {
      const r = row.get(h, i) as Record<string, any>;
      const missing =
        r.public_modulus === null || r.public_modulus === undefined;
      const tx: IndexedTx = {
        id: r.id,
        height: r.height,
        format: r.format,
        owner: missing ? Buffer.alloc(0) : r.public_modulus,
        target: r.target,
        quantity: String(r.quantity),
        reward: String(r.reward),
        anchor: r.last_tx,
        tags: (tags.all(r.id) as Array<{ name: Buffer; value: Buffer }>).map(
          (t) => [t.name, t.value] as [Buffer, Buffer],
        ),
        data_size: String(r.data_size ?? ''),
        data_root: r.data_root,
      };
      return missing
        ? {
            id: r.id,
            height: h,
            problem: 'no wallet row for its owner',
            partial: tx,
          }
        : { tx };
    });
  }
}
