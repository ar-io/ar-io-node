/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The per-block judgement of an L1 index, once, for every reader that
 * drives it: a gateway's `core.db`, a directory of bands, the importer
 * (before it writes a row) and the exporter (before it publishes one).
 *
 * Reading rows out of SQLite and out of Parquet is different work;
 * deciding whether a block is right is not, and writing that decision
 * twice is how a publisher and its consumers quietly stop agreeing. So
 * the readers only select rows — a block, its transactions each joined to
 * the link at its position, a summary of each transaction's tags, and
 * whether its owner has a wallet row — and every predicate lives here. The
 * chain rules themselves (eras, seeds, padding, `tx_root`) stay in
 * `chain.ts`.
 *
 * **Fails closed.** A NULL where the chain has a value is a failure, never
 * read as zero. A block this cannot check is never passed: what is left
 * unchecked is returned as {@link JudgeUnbound} — counted, with its first
 * heights and the reason — for the caller to refuse or accept explicitly.
 */
import {
  ChainBlock,
  checkTxRoot,
  ChainTransaction,
  expectedHashListMerkle,
  foldSeed,
  FORK_1_6,
  FORK_2_0,
  PREDECESSOR_HAS_NO_MERKLE,
} from './chain.js';
import { addFailure, VerifyCheck } from './checks.js';
import type { L1BlockRow } from './anchor.js';

/**
 * The weave offset past which Arweave pads each transaction's data to a
 * chunk boundary before adding it to the weave (`STRICT_DATA_SPLIT_THRESHOLD`
 * in `ar_consensus.hrl`). Below it the weave grows by `data_size` exactly;
 * above it the weave-accounting identity no longer holds (the padded size
 * is committed through `tx_root` instead), so those blocks are counted as
 * outside it rather than reported as wrong.
 */
export const STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830n;

/** Heights listed per unbound class; the rest are counted. */
export const MAX_UNBOUND_HEIGHTS = 20;

/** A block row with the transaction count the index holds for it. */
export interface JudgeBlockRow extends L1BlockRow {
  tx_count: number | bigint | null;
}

/** A transaction at its position in a block, as a reader joined it. */
export interface JudgeTx {
  block_transaction_index: number;
  id: Buffer | null;
  format: number | null;
  data_size: bigint | number | string | null;
  data_root: Buffer | null;
  owner_address: Buffer | null;
  tag_count: number | null;
  /** NULL in quantity, reward or anchor (`last_tx`): each is set on every transaction. */
  nullAmounts: boolean;
  /** The link (`block_transactions`) at this transaction's height and index, or null. */
  link: Buffer | null;
  /** The transaction's tag rows: how many, and their `tag_index` range and distinct count. */
  tags: { n: number; min: number | null; max: number | null; distinct: number };
  /** Whether a wallet row holds the owner's key. */
  ownerKnown: boolean;
}

/** A block, its transactions in `block_transaction_index` order, and links with no transaction. */
export interface JudgeBlock {
  row: JudgeBlockRow;
  txs: JudgeTx[];
  /** Links at positions no transaction row holds: missing transactions. */
  strayLinks: Array<{ block_transaction_index: number; id: Buffer | null }>;
}

/** Something left unchecked: how many blocks, the first heights, and why. */
export interface UnboundClass {
  blocks: number;
  heights: number[];
  reason: string;
}

/**
 * What the run could not bind, by class. PR-stable contract: a layout that
 * carries the missing witnesses makes a class absent, nothing else.
 */
export interface JudgeUnbound {
  /** Blocks below the 2.0 fork: no recomputable hash, so nothing binds their fields. */
  pre20?: UnboundClass;
  /** Post-2.0 blocks holding a format-1 transaction with data: `tx_root` needs its data root. */
  txRootFormat1?: UnboundClass;
  /**
   * Blocks the index holds only part of: a link whose transaction it lacks
   * (so `tx_root` and the weave accounting cannot be checked), or a
   * transaction whose owner's key it lacks (so its signature cannot be).
   * An exporter publishes a tip band like this, counting what it lacks.
   */
  incomplete?: UnboundClass;
}

export const PRE20_REASON =
  "a pre-2.0 block's hash commits to the full wallet list, so it cannot be recomputed; its fields are bound only through the 2.0 hash list or the 2.0 seed fold, which need each block's transition tx_root, a witness this layout does not carry";
export const FORMAT1_REASON =
  'format-1 transaction with data and no v1_data_root: its data root comes from data the index does not hold, so the block tx_root cannot be recomputed';
export const INCOMPLETE_REASON =
  "the index lacks a transaction a link names (so tx_root and the weave accounting cannot be checked) or an owner's key (so its signature cannot be)";

export interface JudgeTotals {
  blocks: number;
  merkleChecked: number;
  merkleSkipped: number;
  accountingChecked: number;
  accountingSkipped: number;
  txRootChecked: number;
  /** The weave size at the first and last block judged. */
  weaveBase?: bigint;
  weaveTop?: bigint;
  /** What the range's transactions account for, past the first block. */
  accountedFor: bigint;
}

const big = (v: bigint | number | string | null): bigint | null => {
  if (v === null) return null;
  if (typeof v === 'bigint') return v;
  const text = String(v);
  return /^\d+$/.test(text) ? BigInt(text) : null;
};

const b64 = (v: Buffer | null) =>
  v === null ? 'null' : v.toString('base64url');

/**
 * Walks a range of blocks in ascending height order, judging each against
 * the one below it and against its own transactions, links, tags and
 * owners.
 *
 * `from` is the base rather than a fully checked height: the block below it
 * is not read, so its link and `hash_list_merkle` cannot be checked, and
 * its transactions are not counted into the weave accounting, which starts
 * at `weave_size(from)`. Running from 0 makes that correct for a whole
 * chain; it is also why Arweave's genesis block, whose transactions the
 * weave never counted, needs no special case.
 */
export class L1Judge {
  readonly checks: Record<
    | 'contiguous'
    | 'linked'
    | 'merkle'
    | 'sizes'
    | 'accounting'
    | 'txRoot'
    | 'nulls'
    | 'position'
    | 'txCount'
    | 'tags'
    | 'owners'
    | 'wallets'
    | 'rows',
    VerifyCheck
  >;
  private previous: JudgeBlockRow | undefined;
  private seedFold: Buffer | undefined;
  private readonly totals: JudgeTotals = {
    blocks: 0,
    merkleChecked: 0,
    merkleSkipped: 0,
    accountingChecked: 0,
    accountingSkipped: 0,
    txRootChecked: 0,
    accountedFor: 0n,
  };
  private readonly unbound: Record<keyof JudgeUnbound, UnboundClass> = {
    pre20: { blocks: 0, heights: [], reason: PRE20_REASON },
    txRootFormat1: { blocks: 0, heights: [], reason: FORMAT1_REASON },
    incomplete: { blocks: 0, heights: [], reason: INCOMPLETE_REASON },
  };

  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly options: {
      /** Recompute `tx_root` (the costly check); off only on request. */
      txRoot?: boolean;
      /** Moved only by tests and chains whose forks are elsewhere. */
      forkHeight?: number;
    } = {},
  ) {
    this.seedFold = from === 0 ? Buffer.alloc(0) : undefined;
    const check = (name: string, detail: string): VerifyCheck => ({
      name,
      ok: true,
      detail,
    });
    this.checks = {
      contiguous: check(
        'contiguous',
        'every height in the range is present, exactly once',
      ),
      linked: check(
        'linked',
        "each block's previous_block is the hash of the block below it",
      ),
      merkle: check('hash_list_merkle', ''),
      sizes: check(
        'block_size',
        "each block's block_size is how much it grew the weave",
      ),
      accounting: check('weave_accounting', ''),
      txRoot: check('tx_root', ''),
      nulls: check(
        'nulls',
        'every key and commitment column is set (NULL is a failure, never zero)',
      ),
      position: check(
        'position',
        'each transaction sits at the link of its height and block_transaction_index, and the links number 0 to n-1',
      ),
      txCount: check(
        'tx_count',
        "each block's tx_count is the number of its links",
      ),
      tags: check(
        'tag_count',
        "each transaction's tag_count is its number of tag rows, indexed 0 to n-1, and every tag belongs to a transaction at its height",
      ),
      owners: check(
        'owners',
        'every transaction has an owner; one whose key the index lacks is listed in unbound.incomplete',
      ),
      wallets: check(
        'wallets',
        'every wallet row holds the key its address is the SHA-256 of',
      ),
      rows: check(
        'rows',
        'every row lies inside the heights its table is read for, at a height with a block',
      ),
    };
  }

  private get forkHeight(): number {
    return this.options.forkHeight ?? FORK_2_0;
  }

  /** Records a failure a reader found outside the per-block walk (wallets, stray rows). */
  fail(
    check: keyof L1Judge['checks'],
    height: number,
    found: string,
    expected: string,
  ): void {
    addFailure(this.checks[check], { height, found, expected });
  }

  private note(kind: keyof JudgeUnbound, height: number): void {
    const cls = this.unbound[kind];
    cls.blocks += 1;
    if (cls.heights.length < MAX_UNBOUND_HEIGHTS) cls.heights.push(height);
  }

  /** One block, in ascending height order. */
  async step(block: JudgeBlock): Promise<void> {
    const row = block.row;
    const h = row.height;
    this.totals.blocks += 1;
    this.checkNulls(block);
    if (h < this.forkHeight) this.note('pre20', h);
    const weave = big(row.weave_size);
    const size = big(row.block_size);
    const txBytes = block.txs.reduce(
      (sum, tx) => sum + (big(tx.data_size) ?? 0n),
      0n,
    );
    this.totals.weaveTop = weave ?? this.totals.weaveTop;

    this.checkTransactions(block);
    const incomplete =
      block.strayLinks.length > 0 || block.txs.some((tx) => !tx.ownerKnown);
    if (incomplete) this.note('incomplete', h);
    await this.checkTxRoot(block);

    const previous = this.previous;
    if (previous === undefined) {
      if (h !== this.from) {
        addFailure(this.checks.contiguous, {
          height: this.from,
          found: `the range starts at ${h}`,
          expected: `${this.from}`,
        });
      }
      this.totals.weaveBase = weave ?? undefined;
      this.seedFold = foldSeed(this.seedFold, row as unknown as ChainBlock);
      this.previous = row;
      return;
    }
    if (h !== previous.height + 1) {
      addFailure(this.checks.contiguous, {
        height: previous.height + 1,
        found: `the next block is ${h}`,
        expected: `${previous.height + 1}`,
      });
      // Nothing can be judged across a hole: the weave difference would
      // span the missing blocks and bury the gap that caused it.
      this.seedFold = foldSeed(this.seedFold, row as unknown as ChainBlock);
      this.previous = row;
      return;
    }

    if (
      previous.indep_hash === null ||
      row.previous_block === null ||
      !row.previous_block.equals(previous.indep_hash)
    ) {
      addFailure(this.checks.linked, {
        height: h,
        found: b64(row.previous_block),
        expected: b64(previous.indep_hash),
      });
    }

    const want = expectedHashListMerkle(
      h,
      previous as unknown as ChainBlock,
      this.seedFold,
    );
    if (want === PREDECESSOR_HAS_NO_MERKLE) {
      this.totals.merkleChecked += 1;
      addFailure(this.checks.merkle, {
        height: h,
        found: 'the block below carries no hash_list_merkle',
        expected: 'every block above the 1.6 fork has one',
      });
    } else if (want === undefined) {
      this.totals.merkleSkipped += 1;
    } else {
      this.totals.merkleChecked += 1;
      const got = row.hash_list_merkle;
      const ok =
        want === null
          ? got === null || got.length === 0
          : got !== null && want.equals(got);
      if (!ok) {
        addFailure(this.checks.merkle, {
          height: h,
          found: b64(got),
          expected: want === null ? 'empty' : b64(want),
        });
      }
    }

    const below = big(previous.weave_size);
    if (weave !== null && below !== null && size !== null) {
      const grew = weave - below;
      if (grew !== size) {
        addFailure(this.checks.sizes, {
          height: h,
          found: `block_size ${size}`,
          expected: `weave grew by ${grew}`,
        });
      }
      if (block.strayLinks.length > 0) {
        // Transactions the index lacks grew the weave too: unknowable.
        this.totals.accountingSkipped += 1;
      } else if (weave <= STRICT_DATA_SPLIT_THRESHOLD) {
        this.totals.accountingChecked += 1;
        this.totals.accountedFor += txBytes;
        if (grew !== txBytes) {
          addFailure(this.checks.accounting, {
            height: h,
            found: `transactions total ${txBytes}`,
            expected: `weave grew by ${grew}`,
          });
        }
      } else {
        this.totals.accountingSkipped += 1;
      }
    }

    this.seedFold = foldSeed(this.seedFold, row as unknown as ChainBlock);
    this.previous = row;
  }

  private checkNulls(block: JudgeBlock): void {
    const row = block.row;
    const h = row.height;
    const missing: string[] = [];
    const need = (name: string, value: unknown) => {
      if (value === null || value === undefined) missing.push(name);
    };
    need('indep_hash', row.indep_hash);
    if (row.indep_hash !== null && row.indep_hash.length !== 48) {
      missing.push('indep_hash (not 48 bytes)');
    }
    if (h > 0) need('previous_block', row.previous_block);
    need('nonce', row.nonce);
    need('hash', row.hash);
    need('block_timestamp', row.block_timestamp);
    need('diff', row.diff);
    need('last_retarget', row.last_retarget);
    need('reward_pool', row.reward_pool);
    need('tx_count', row.tx_count);
    if (big(row.block_size) === null) missing.push('block_size');
    if (big(row.weave_size) === null) missing.push('weave_size');
    if (h >= FORK_1_6) need('hash_list_merkle', row.hash_list_merkle);
    if (h >= this.forkHeight) need('tx_root', row.tx_root);
    for (const tx of block.txs) {
      const at = `transaction ${tx.block_transaction_index}`;
      if (tx.id === null || tx.id.length !== 32) missing.push(`${at} id`);
      if (tx.format !== 1 && tx.format !== 2) {
        missing.push(`${at} format (${String(tx.format)})`);
      } else if (tx.format === 2 && h < this.forkHeight) {
        missing.push(`${at} format 2 below the 2.0 fork`);
      }
      if (big(tx.data_size) === null) missing.push(`${at} data_size`);
      if (tx.owner_address === null) missing.push(`${at} owner_address`);
      if (tx.tag_count === null) missing.push(`${at} tag_count`);
      if (tx.nullAmounts) missing.push(`${at} quantity, reward or anchor`);
    }
    if (missing.length > 0) {
      addFailure(this.checks.nulls, {
        height: h,
        found: `NULL or malformed: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}`,
        expected: 'every value the chain has, set',
      });
    }
  }

  private checkTransactions(block: JudgeBlock): void {
    const h = block.row.height;
    const positions = [
      ...block.txs
        .filter((t) => t.link !== null)
        .map((t) => t.block_transaction_index),
      ...block.strayLinks.map((l) => l.block_transaction_index),
    ].sort((a, b) => a - b);
    const misplaced = block.txs.filter(
      (t) => t.link === null || t.id === null || !t.link.equals(t.id),
    );
    if (misplaced.length > 0) {
      const t = misplaced[0];
      addFailure(this.checks.position, {
        height: h,
        found: `${misplaced.length} transaction(s) without the link at their position (first at index ${t.block_transaction_index}: link ${b64(t.link)})`,
        expected:
          'the link at (height, block_transaction_index) names the transaction',
      });
    }
    if (positions.some((p, i) => p !== i)) {
      addFailure(this.checks.position, {
        height: h,
        found: `links at positions ${positions.slice(0, 8).join(', ')}${positions.length > 8 ? ', …' : ''}`,
        expected: `positions 0 to ${positions.length - 1}`,
      });
    }
    const links =
      block.txs.filter((t) => t.link !== null).length + block.strayLinks.length;
    const count = big(block.row.tx_count);
    if (count !== null && count !== BigInt(links)) {
      addFailure(this.checks.txCount, {
        height: h,
        found: `tx_count ${count}`,
        expected: `${links} links`,
      });
    }
    for (const tx of block.txs) {
      const { n, min, max, distinct } = tx.tags;
      const ok =
        tx.tag_count === n &&
        (n === 0 || (min === 0 && max === n - 1 && distinct === n));
      if (!ok) {
        addFailure(this.checks.tags, {
          height: h,
          found: `transaction ${b64(tx.id)}: tag_count ${String(tx.tag_count)}, ${n} tag rows indexed ${String(min)}-${String(max)} (${distinct} distinct)`,
          expected: 'tag_count tag rows, indexed 0 to tag_count-1',
        });
      }
      if (!tx.ownerKnown && tx.owner_address === null) {
        addFailure(this.checks.owners, {
          height: h,
          found: `transaction ${b64(tx.id)}: no owner_address`,
          expected: 'every transaction has an owner',
        });
      }
    }
  }

  private async checkTxRoot(block: JudgeBlock): Promise<void> {
    const h = block.row.height;
    if (h < this.forkHeight || this.options.txRoot === false) return;
    if (block.strayLinks.length > 0) return;
    if (
      block.txs.some((tx) => tx.format === 1 && (big(tx.data_size) ?? 0n) > 0n)
    ) {
      this.note('txRootFormat1', h);
      return;
    }
    const txs: ChainTransaction[] = block.txs.map((tx) => ({
      id: tx.id ?? Buffer.alloc(0),
      format: tx.format ?? 0,
      data_size: big(tx.data_size) ?? 0n,
      data_root: tx.data_root,
    }));
    const ok = await checkTxRoot(
      { height: h, tx_root: block.row.tx_root },
      txs,
    );
    if (ok === undefined) {
      // Unreachable: the only case computeTxRoot declines is noted above.
      this.note('txRootFormat1', h);
      return;
    }
    this.totals.txRootChecked += 1;
    if (!ok) {
      addFailure(this.checks.txRoot, {
        height: h,
        found: `${txs.length} transactions that do not reproduce it`,
        expected: b64(block.row.tx_root),
      });
    }
  }

  /** The checks, worded, the totals, and what was left unbound. */
  finish(): {
    checks: VerifyCheck[];
    totals: JudgeTotals;
    unbound: JudgeUnbound;
  } {
    const expected = this.to - this.from + 1;
    if (this.totals.blocks !== expected) {
      addFailure(this.checks.contiguous, {
        height: this.to,
        found: `${this.totals.blocks} blocks`,
        expected: `${expected}`,
      });
    }
    const t = this.totals;
    this.checks.merkle.detail =
      t.merkleChecked === 0
        ? 'no block in this range has a rebuildable hash_list_merkle'
        : `${t.merkleChecked} blocks' hash_list_merkle is the fold of the blocks below; ${t.merkleSkipped} are seeds (the 2.0 seed, or the 1.6 seed without heights from 0) or the first block`;
    this.checks.accounting.detail =
      `self-consistent, not bound to the chain by itself: ${t.accountingChecked} blocks grew the weave by exactly their transactions' data_size` +
      (t.accountingSkipped > 0
        ? `; ${t.accountingSkipped} are past the padding threshold, where tx_root commits the padded sizes instead`
        : '');
    this.checks.txRoot.detail =
      this.options.txRoot === false
        ? 'not checked (--skip-tx-root)'
        : `${t.txRootChecked} blocks' transactions reproduce the tx_root they carry` +
          (this.unbound.txRootFormat1.blocks + this.unbound.incomplete.blocks >
          0
            ? '; the rest could not be recomputed (see unbound)'
            : '');
    const unbound: JudgeUnbound = {};
    for (const key of Object.keys(this.unbound) as Array<keyof JudgeUnbound>) {
      if (this.unbound[key].blocks > 0) unbound[key] = this.unbound[key];
    }
    return {
      checks: [
        this.checks.contiguous,
        this.checks.linked,
        this.checks.merkle,
        this.checks.sizes,
        this.checks.accounting,
        ...(this.options.txRoot === false ? [] : [this.checks.txRoot]),
        this.checks.nulls,
        this.checks.position,
        this.checks.txCount,
        this.checks.tags,
        this.checks.owners,
        this.checks.wallets,
        this.checks.rows,
      ],
      totals: this.totals,
      unbound,
    };
  }
}
