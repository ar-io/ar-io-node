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
 *
 * **Witnesses** (`l1-4`, {@link JudgeBlock.witness}). A block holding a
 * format-1 transaction with data has its `tx_root` recomputed with the
 * witnessed v1 data roots: equal, and the block is bound; unequal, and
 * `tx_root` fails — never a fall back to unbound. Below the 2.0 fork each
 * block's transition `tx_root` is recomputed and must equal its witness,
 * and the 2.0 seed fold is carried block to block
 * ({@link foldBlockIndexEntry}): it starts from empty at height 0 or from a
 * pinned fold ({@link FORK_2_0_FOLD_PINS}), each witnessed fold must equal
 * the one recomputed, and a run of pre-2.0 blocks is bound only once its
 * fold reaches a value the chain fixes — a pin, or block 422,250's
 * `hash_list_merkle`. A missing witness leaves its block (and the run of
 * blocks waiting on the fold through it) in its unbound class.
 */
import {
  ChainBlock,
  checkTxRoot,
  ChainTransaction,
  computeTxRoot,
  expectedHashListMerkle,
  foldBlockIndexEntry,
  foldH2,
  foldSeed,
  FORK_1_6,
  FORK_2_0,
  FORK_2_0_PINS,
  FORK_2_5,
  type Fork20Pins,
  PREDECESSOR_HAS_NO_MERKLE,
} from './chain.js';
import { hash20Of10Block } from './block-hash.js';
import { addFailure, VerifyCheck } from './checks.js';
import { FORK_1_8, FORK_2_9_6 } from './tx-signature.js';
import type { L1BlockRow } from './anchor.js';
import { type BandTag, firstTagValue } from './layout.js';

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
  tags: {
    n: number;
    min: number | null;
    max: number | null;
    distinct: number;
    /** Rows under its id at another height or position (a reader by id serves them). */
    misplaced?: number;
  };
  /** Whether a wallet row holds the owner's key. */
  ownerKnown: boolean;
  /**
   * Bands only: the columns a band derives (`content_type`,
   * `content_encoding` from the tags, `offset` from the weave), and the
   * tags they derive from (those whose name could be `Content-Type` or
   * `Content-Encoding`: 12 or 16 bytes), for the `canonical` check.
   */
  derived?: {
    contentType: string | null;
    contentEncoding: string | null;
    offset: bigint | null;
    tags: BandTag[];
  };
}

/** What an `l1-4` band witnesses about one block. */
export interface JudgeWitness {
  /** The v1 data roots its band holds for this block's transactions, by base64url id. */
  v1Roots: ReadonlyMap<string, Buffer>;
  /**
   * Below the 2.0 fork: the block's transition `tx_root` and the 2.0 seed
   * fold after it, or null when its band holds no row for it. Undefined at
   * and above the fork, and for a band that carries no `fork_2_0` witness.
   */
  fork20?: { txRoot: Buffer; fold: Buffer; h2: Buffer } | null;
}

/** A block, its transactions in `block_transaction_index` order, and links with no transaction. */
export interface JudgeBlock {
  row: JudgeBlockRow;
  txs: JudgeTx[];
  /** Links at positions no transaction row holds: missing transactions. */
  strayLinks: Array<{ block_transaction_index: number; id: Buffer | null }>;
  /** What its band witnesses (`l1-4`); absent for a band or index that carries none. */
  witness?: JudgeWitness;
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
  /**
   * Blocks below the 2.0 fork that no 2.0 seed fold binds: no recomputable
   * hash, and no witnessed fold reaching a value the chain fixes.
   */
  pre20?: UnboundClass;
  /**
   * Blocks holding a format-1 transaction with data whose v1 data root no
   * witness gives: `tx_root` cannot be recomputed. Post-2.0 blocks, and
   * pre-2.0 blocks whose header the fold binds (a pre-2.0 block without a
   * witness is `pre20` alone).
   */
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
  "a pre-2.0 block's hash commits to the full wallet list, so it cannot be recomputed; its fields are bound only through an l1-4 band's witness_fork_2_0: the 2.0 seed fold (hash, weave size, transition tx_root) and the fold of its 2.0 hashes (every header field and its transaction ids), both reaching their pinned values, and this block has no such witness, its 2.0 hash does not recompute, or a fold through it reaches no pin";
export const FORMAT1_REASON =
  "format-1 transaction with data and no witnessed v1 data root: its data root comes from data the index does not hold, so the block tx_root cannot be recomputed, and every field of every transaction in the block (not only the format-1 ones) is bound only by the sample (a format-2 transaction relabelled format 1 moves its block here; the format-1 draw is what catches that). Closing it needs the v1 data roots, an l1-4 band's witness_v1_data_roots";
export const INCOMPLETE_REASON =
  "the index lacks a transaction a link names (so tx_root and the weave accounting cannot be checked) or an owner's key (so its signature cannot be)";

export interface JudgeTotals {
  blocks: number;
  merkleChecked: number;
  merkleSkipped: number;
  accountingChecked: number;
  accountingSkipped: number;
  txRootChecked: number;
  /** Pre-2.0 blocks whose fields a witnessed 2.0 seed fold binds to the chain. */
  foldBound: number;
  /**
   * The last height at which both folds reached their pins with no block
   * below it left waiting: the pre-2.0 run up to it is bound to the chain
   * there (the pins fold on to block 422,250's `hash_list_merkle`).
   */
  pinnedAt?: number;
  /**
   * Format-1 transactions with data at or above the 2.0 fork: what only the
   * format-1 draw checks is format 1 (a witnessed root binds its size and
   * root, not its format).
   */
  format1Txs: number;
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
    | 'rows'
    | 'witnesses'
    | 'canonical'
    | 'hashList10',
    VerifyCheck
  >;
  private previous: JudgeBlockRow | undefined;
  private seedFold: Buffer | undefined;
  /**
   * The 2.0 seed fold through the block judged last, below the fork:
   * recomputed from a value the chain fixes (empty at 0, or a pin), or
   * taken from a witness where nothing below it was known. Undefined where
   * a block had no witness.
   */
  private fork20Fold: Buffer | undefined;
  /**
   * The fold of the pre-2.0 blocks' recomputed 2.0 hashes through the block
   * judged last: from empty at 0, or a pin. Undefined where a block's could
   * not be recomputed or taken.
   */
  private h2Fold: Buffer | undefined;
  /** Pre-2.0 blocks whose fold step was checked, waiting for the fold to reach a value the chain fixes. */
  private readonly foldPending: { blocks: number; heights: number[] } = {
    blocks: 0,
    heights: [],
  };
  private readonly totals: JudgeTotals = {
    blocks: 0,
    merkleChecked: 0,
    merkleSkipped: 0,
    accountingChecked: 0,
    accountingSkipped: 0,
    txRootChecked: 0,
    foldBound: 0,
    format1Txs: 0,
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
      /**
       * The index's block below `from`, when it holds one: the first
       * block is then judged against it like every other (its link,
       * `hash_list_merkle`, `block_size` and weave accounting) rather than
       * being the unjudged base.
       */
      prior?: JudgeBlockRow;
      /**
       * The 2.0 seed folds the chain fixes, by height: mainnet's
       * ({@link FORK_2_0_FOLD_PINS}) unless a test chain gives its own.
       * Never taken from an index or a caller's input.
       */
      foldPins?: Fork20Pins;
      /** Report the `witnesses` check (a reader of `l1-4` bands). */
      witnesses?: boolean;
    } = {},
  ) {
    this.seedFold = from === 0 ? Buffer.alloc(0) : undefined;
    this.fork20Fold =
      from === 0 ? Buffer.alloc(0) : this.foldPins.fold.get(from - 1);
    this.h2Fold = from === 0 ? Buffer.alloc(0) : this.foldPins.h2.get(from - 1);
    if (options.prior !== undefined) {
      this.previous = options.prior;
      this.totals.weaveBase = big(options.prior.weave_size) ?? undefined;
    }
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
      witnesses: check('witnesses', ''),
      canonical: check(
        'canonical',
        'every column with one value a band writes holds it: no tx_root below the 2.0 fork, no USD rates below the 2.5 fork, is_data_item false, and a signature only where its SHA-256 is the id (column-bindings.ts)',
      ),
      hashList10: check(
        'hash_list_1_0',
        "each pre-2.0 block's 2.0 hash recomputes from its own fields, sorted transaction ids and transition tx_root, and their fold reaches the fold of Arweave's genesis_data/hash_list_1_0 pinned in this build",
      ),
    };
  }

  private get forkHeight(): number {
    return this.options.forkHeight ?? FORK_2_0;
  }

  private get foldPins(): Fork20Pins {
    return this.options.foldPins ?? FORK_2_0_PINS;
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
    if (this.witnessed && kind !== 'incomplete') {
      // An l1-4 band binds every block it holds, or fails: the flags that
      // accept an unbound block (--allow-unbound,
      // --allow-unverified-format1) are for bands without witnesses, and
      // must not let a stripped l1-4 band through.
      addFailure(this.checks.witnesses, {
        height,
        found: `a block of an l1-4 band left unbound (${kind})`,
        expected:
          'every block of an l1-4 band bound by its witnesses (the --allow flags accept bands without witnesses only)',
      });
    }
  }

  /** Whether the block being judged is an l1-4 band's (it carries witnesses). */
  private witnessed = false;

  /** The blocks waiting on the fold are bound by nothing after all: `pre20`. */
  private foldUnbound(): void {
    if (this.foldPending.blocks > 0) {
      // Pending blocks all carry witnesses: an l1-4 band's.
      addFailure(this.checks.witnesses, {
        height: this.foldPending.heights[0] ?? 0,
        found: `${this.foldPending.blocks} pre-2.0 blocks of an l1-4 band whose folds reach no pinned value`,
        expected:
          'every block of an l1-4 band bound by its witnesses (the --allow flags accept bands without witnesses only)',
      });
    }
    const cls = this.unbound.pre20;
    cls.blocks += this.foldPending.blocks;
    for (const h of this.foldPending.heights) {
      if (cls.heights.length < MAX_UNBOUND_HEIGHTS) cls.heights.push(h);
    }
    cls.heights.sort((a, b) => a - b);
    this.foldPending.blocks = 0;
    this.foldPending.heights = [];
  }

  /**
   * Both folds reached their pins: the blocks waiting on them are bound.
   * Counted in `foldBound` only when their transition `tx_root`s were
   * recomputed (not under `--skip-tx-root`).
   */
  private foldConfirmed(): void {
    if (this.options.txRoot !== false) {
      this.totals.foldBound += this.foldPending.blocks;
    }
    this.foldPending.blocks = 0;
    this.foldPending.heights = [];
  }

  /**
   * A pre-2.0 block's part of the 2.0 seed fold (see the module comment):
   * its witnessed fold checked against the one recomputed from the fold
   * below, its transition `tx_root` against its transactions, and, at a
   * pinned height, the fold against the pin.
   */
  private async stepFork20(block: JudgeBlock): Promise<void> {
    const row = block.row;
    const h = row.height;
    const witness = block.witness?.fork20 ?? undefined;
    const weave = big(row.weave_size);
    const h2 =
      witness === undefined
        ? undefined
        : this.recomputeH2(block, witness.txRoot);
    if (
      witness === undefined ||
      row.indep_hash === null ||
      weave === null ||
      h2 === undefined
    ) {
      // Nothing binds this block, and the folds through it are lost: the
      // blocks waiting on them cannot reach a pin past it either.
      this.foldUnbound();
      this.note('pre20', h);
      this.fork20Fold = undefined;
      this.h2Fold = undefined;
    } else {
      if (!h2.equals(witness.h2)) {
        addFailure(this.checks.hashList10, {
          height: h,
          found: `the block's fields give the 2.0 hash ${b64(h2)}`,
          expected: `${b64(witness.h2)}, its witness_fork_2_0 h2`,
        });
      }
      this.h2Fold =
        this.h2Fold === undefined ? undefined : foldH2(this.h2Fold, h2);
      if (this.fork20Fold === undefined || this.h2Fold === undefined) {
        // Nothing below is known: the witness's fold is taken as given, so
        // the blocks above can be checked, but this block's own fields are
        // bound by nothing (the folds below it are what would bind them).
        this.foldUnbound();
        this.note('pre20', h);
        this.fork20Fold = witness.fold;
      } else {
        const next = foldBlockIndexEntry(this.fork20Fold, {
          indep_hash: row.indep_hash,
          weave_size: weave,
          tx_root: witness.txRoot,
        });
        if (!next.equals(witness.fold)) {
          addFailure(this.checks.witnesses, {
            height: h,
            found: `witness_fork_2_0 fold ${b64(witness.fold)}`,
            expected: `${b64(next)}, the fold of the block below and this block's [indep_hash, weave_size, tx_root]`,
          });
        }
        this.fork20Fold = next;
        this.foldPending.blocks += 1;
        if (this.foldPending.heights.length < MAX_UNBOUND_HEIGHTS) {
          this.foldPending.heights.push(h);
        }
      }
      await this.checkTransitionTxRoot(block, witness.txRoot);
    }
    const pin = this.foldPins.fold.get(h);
    const h2Pin = this.foldPins.h2.get(h);
    if (pin !== undefined || h2Pin !== undefined) {
      let reached = pin !== undefined && h2Pin !== undefined;
      if (pin !== undefined && this.fork20Fold !== undefined) {
        if (!this.fork20Fold.equals(pin)) {
          reached = false;
          addFailure(this.checks.merkle, {
            height: h,
            found: `the 2.0 seed fold through ${h} is ${b64(this.fork20Fold)}`,
            expected: `${b64(pin)}, the chain's (pinned)`,
          });
        }
      } else {
        reached = false;
      }
      if (h2Pin !== undefined && this.h2Fold !== undefined) {
        if (!this.h2Fold.equals(h2Pin)) {
          reached = false;
          addFailure(this.checks.hashList10, {
            height: h,
            found: `the fold of the 2.0 hashes through ${h} is ${b64(this.h2Fold)}`,
            expected: `${b64(h2Pin)}, hash_list_1_0's (pinned)`,
          });
        }
      } else {
        reached = false;
      }
      if (reached) {
        this.foldConfirmed();
        this.totals.pinnedAt = h;
      } else this.foldUnbound();
      // From here the folds are the chain's, whatever came before.
      if (pin !== undefined) this.fork20Fold = pin;
      if (h2Pin !== undefined) this.h2Fold = h2Pin;
    }
  }

  /**
   * A pre-2.0 block's 2.0 hash (`hash20Of10Block`) from its own fields, the
   * ids its links name (sorted there) and its witnessed transition
   * `tx_root`; undefined when a field it needs is missing (the `nulls`
   * check names it).
   */
  private recomputeH2(block: JudgeBlock, txRoot: Buffer): Buffer | undefined {
    const row = block.row;
    if (
      row.nonce === null ||
      row.hash === null ||
      row.block_timestamp === null ||
      row.last_retarget === null ||
      row.diff === null ||
      row.reward_pool === null ||
      big(row.block_size) === null ||
      big(row.weave_size) === null
    ) {
      return undefined;
    }
    const ids = [
      ...block.txs.map((tx) => tx.link ?? tx.id),
      ...block.strayLinks.map((l) => l.id),
    ];
    if (ids.some((id) => id === null)) return undefined;
    try {
      return hash20Of10Block(
        {
          height: row.height,
          previous_block: row.previous_block,
          nonce: row.nonce,
          hash: row.hash,
          block_timestamp: row.block_timestamp,
          last_retarget: row.last_retarget,
          diff: row.diff,
          cumulative_diff: row.cumulative_diff,
          reward_addr: row.reward_addr,
          reward_pool: row.reward_pool,
          block_size: row.block_size as number | bigint | string,
          weave_size: row.weave_size as number | bigint | string,
          wallet_list: row.wallet_list,
          hash_list_merkle: row.hash_list_merkle,
        },
        ids as Buffer[],
        txRoot,
      );
    } catch {
      // A stored number that is not whole: not this block's 2.0 hash.
      return undefined;
    }
  }

  /**
   * A pre-2.0 block's transactions against its witnessed transition
   * `tx_root`: recomputed as Arweave's 2.0 transition did (the rules of
   * {@link computeTxRoot}, with the v1 data roots witnessed).
   */
  private async checkTransitionTxRoot(
    block: JudgeBlock,
    witnessed: Buffer,
  ): Promise<void> {
    const h = block.row.height;
    if (this.options.txRoot === false) return;
    // `incomplete` already says why: a transaction the index lacks.
    if (block.strayLinks.length > 0) return;
    const root = await computeTxRoot(
      h,
      this.chainTxs(block),
      block.witness?.v1Roots,
    );
    if (root === undefined) {
      // A v1 root no witness gives: the header is bound (by the fold), the
      // transactions are not.
      this.note('txRootFormat1', h);
      return;
    }
    this.totals.txRootChecked += 1;
    if (!root.equals(witnessed)) {
      addFailure(this.checks.txRoot, {
        height: h,
        found: `${block.txs.length} transactions that recompute to ${b64(root)}`,
        expected: `${b64(witnessed)}, the transition tx_root witnessed`,
      });
    }
  }

  /**
   * Under `l1-4` a format-1 transaction's `data_root` column is NULL, the
   * one value a band writes for it: its root is the witness's, which
   * `tx_root` checks, and a column beside it would be read by an importer
   * and bound by nothing.
   */
  private checkCanonicalFormat1(block: JudgeBlock): void {
    const stray = block.txs.filter(
      (tx) => tx.format === 1 && tx.data_root !== null,
    );
    if (stray.length > 0) {
      addFailure(this.checks.witnesses, {
        height: block.row.height,
        found: `${stray.length} format-1 transaction(s) with a data_root (first ${b64(stray[0].id)}: ${b64(stray[0].data_root)})`,
        expected:
          'NULL: a format-1 data root is given only by witness_v1_data_roots, which tx_root checks',
      });
    }
  }

  /**
   * A band's block columns that have one value a band writes
   * (`column-bindings.ts`): below the 2.0 fork no `tx_root` (the protocol
   * had none; the transition root is a witness), below the 2.5 fork no USD
   * rates (no header carried them). A value there is bound by nothing.
   * Bands only: a gateway's `core.db` holds whatever its header source gave.
   */
  private checkCanonicalBlock(block: JudgeBlock): void {
    const row = block.row;
    const h = row.height;
    const stray: string[] = [];
    if (h < this.forkHeight && row.tx_root !== null) stray.push('tx_root');
    if (h < FORK_2_5) {
      for (const name of [
        'usd_to_ar_rate_dividend',
        'usd_to_ar_rate_divisor',
        'scheduled_usd_to_ar_rate_dividend',
        'scheduled_usd_to_ar_rate_divisor',
      ] as const) {
        if (row[name] !== null) stray.push(name);
      }
    }
    if (stray.length > 0) {
      addFailure(this.checks.canonical, {
        height: h,
        found: `${stray.join(', ')} set`,
        expected: 'NULL: the chain has no such value at this height',
      });
    }
    // One spelling for each value (column-bindings.ts, `representation`):
    // a number re-spelled ('001', '2.000') or an absent value spelled two
    // ways would verify as the same value and be imported as another.
    const spelt: string[] = [];
    const text = (name: string, value: unknown, form: RegExp | null) => {
      if (form === null) {
        if (value !== null)
          spelt.push(`${name} ${JSON.stringify(value)}, not NULL`);
      } else if (typeof value !== 'string' || !form.test(value)) {
        spelt.push(`${name} ${JSON.stringify(value)}, not ${form.source}`);
      }
    };
    const whole = /^(0|[1-9][0-9]*)$/;
    const real = /^(0|[1-9][0-9]*)\.0$/;
    // Below the 1.8 fork difficulty was a float, stored as N.0.
    text('diff', row.diff, h < FORK_1_8 ? real : whole);
    text(
      'cumulative_diff',
      row.cumulative_diff,
      h < FORK_1_6 ? null : h < FORK_1_8 ? real : whole,
    );
    text('reward_pool', row.reward_pool, whole);
    // `unclaimed` is empty bytes, never NULL or the word.
    if (
      row.reward_addr === null ||
      row.reward_addr.equals(Buffer.from('unclaimed'))
    ) {
      spelt.push('reward_addr NULL or "unclaimed", not empty bytes');
    }
    if (row.wallet_list === null) spelt.push('wallet_list NULL');
    if (h < FORK_1_6) {
      if (row.hash_list_merkle !== null) {
        spelt.push('hash_list_merkle set below the 1.6 fork, not NULL');
      }
    }
    if (
      h === 0 &&
      (row.previous_block === null || row.previous_block.length > 0)
    ) {
      spelt.push('genesis previous_block not empty bytes');
    }
    if (spelt.length > 0) {
      addFailure(this.checks.canonical, {
        height: h,
        found: spelt.join('; '),
        expected: 'the one spelling a band writes for each value',
      });
    }
  }

  /**
   * The columns a band derives, recomputed (`column-bindings.ts`):
   * `content_type` and `content_encoding`, the first tag of that name by
   * position, names compared without case, NULL without one
   * (`firstTagValue`, the exporter's rule); and `offset`, NULL or the
   * weave offset its data ends at: the weave below the block
   * (`weave_size - block_size`), then the block's transactions in tx_root
   * order (format, then id), each padded to a chunk from the 2.5 fork, as
   * `computeTxRoot` places them. NULL without data, and in the genesis
   * block, whose data the weave never held. A NULL offset is what a
   * gateway that never learnt one writes, and is imported as NULL.
   */
  private checkDerivedColumns(block: JudgeBlock): void {
    const h = block.row.height;
    const wrong: string[] = [];
    for (const tx of block.txs) {
      const d = tx.derived;
      if (d === undefined) continue;
      const type = firstTagValue(d.tags, 'Content-Type');
      const encoding = firstTagValue(d.tags, 'Content-Encoding');
      if (d.contentType !== type) {
        wrong.push(
          `content_type of ${b64(tx.id)}: ${JSON.stringify(d.contentType)}, its tags give ${JSON.stringify(type)}`,
        );
      }
      if (d.contentEncoding !== encoding) {
        wrong.push(
          `content_encoding of ${b64(tx.id)}: ${JSON.stringify(d.contentEncoding)}, its tags give ${JSON.stringify(encoding)}`,
        );
      }
    }
    // Offsets need every transaction of the block, in place.
    const weave = big(block.row.weave_size);
    const size = big(block.row.block_size);
    if (
      block.strayLinks.length === 0 &&
      weave !== null &&
      size !== null &&
      block.txs.every(
        (tx) =>
          tx.id !== null && tx.format !== null && big(tx.data_size) !== null,
      )
    ) {
      const sorted = [...block.txs].sort(
        (a, b) =>
          (a.format as number) - (b.format as number) ||
          Buffer.compare(a.id as Buffer, b.id as Buffer),
      );
      let position = weave - size;
      for (const tx of sorted) {
        const dataSize = big(tx.data_size) as bigint;
        const end = position + dataSize;
        const stored = tx.derived?.offset;
        if (stored !== undefined && stored !== null) {
          const want = dataSize === 0n || h === 0 ? null : end;
          if (want === null || stored !== want) {
            wrong.push(
              `offset of ${b64(tx.id)}: ${stored}, ${want === null ? 'NULL (no data in the weave)' : `its data ends at ${want}`}`,
            );
          }
        }
        position =
          h >= FORK_2_5 && dataSize > 0n
            ? position + ((dataSize + 262_143n) / 262_144n) * 262_144n
            : end;
      }
    }
    if (wrong.length > 0) {
      addFailure(this.checks.canonical, {
        height: h,
        found:
          wrong.slice(0, 3).join('; ') +
          (wrong.length > 3 ? ` and ${wrong.length - 3} more` : ''),
        expected:
          'content_type and content_encoding from the first such tag; offset NULL, or where its data ends in the weave',
      });
    }
  }

  private chainTxs(block: JudgeBlock): ChainTransaction[] {
    return block.txs.map((tx) => ({
      id: tx.id ?? Buffer.alloc(0),
      format: tx.format ?? 0,
      data_size: big(tx.data_size) ?? 0n,
      data_root: tx.data_root,
    }));
  }

  /** One block, in ascending height order. */
  async step(block: JudgeBlock): Promise<void> {
    const row = block.row;
    const h = row.height;
    this.totals.blocks += 1;
    this.witnessed = block.witness !== undefined;
    this.checkNulls(block);
    const weave = big(row.weave_size);
    const size = big(row.block_size);
    const txBytes = block.txs.reduce(
      (sum, tx) => sum + (big(tx.data_size) ?? 0n),
      0n,
    );
    this.totals.weaveTop = weave ?? this.totals.weaveTop;

    this.checkTransactions(block);
    if (block.witness !== undefined) this.checkCanonicalFormat1(block);
    if (this.options.witnesses === true) {
      this.checkCanonicalBlock(block);
      this.checkDerivedColumns(block);
    }
    if (h >= this.forkHeight) {
      this.totals.format1Txs += block.txs.filter(
        (tx) => tx.format === 1 && (big(tx.data_size) ?? 0n) > 0n,
      ).length;
    }
    const incomplete =
      block.strayLinks.length > 0 || block.txs.some((tx) => !tx.ownerKnown);
    if (incomplete) this.note('incomplete', h);
    await this.checkTxRoot(block);
    // Before the walk below, which may stop at a hole: a hole breaks the
    // fold too (the block below this one is not the one before it).
    const previous = this.previous;
    if (previous !== undefined && h !== previous.height + 1) {
      this.foldUnbound();
      this.fork20Fold = this.foldPins.fold.get(h - 1);
      this.h2Fold = this.foldPins.h2.get(h - 1);
    }
    if (h < this.forkHeight) await this.stepFork20(block);

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

    // The 2.0 seed: the fold through the block below, when it is known.
    const want =
      h === this.forkHeight && this.fork20Fold !== undefined
        ? this.fork20Fold
        : expectedHashListMerkle(
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
      // A run still waiting here reached no pin of the 2.0 hashes: it
      // stays unbound, whatever the merkle says.
      if (h === this.forkHeight) this.foldUnbound();
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
      } else if (tx.format === 1 && h >= FORK_2_9_6) {
        // `ar_tx:do_verify`: the 2.9.6 fork rejects every format-1
        // transaction from its height on.
        missing.push(`${at} format 1 at or above the 2.9.6 fork`);
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
        (tx.tags.misplaced ?? 0) === 0 &&
        (n === 0 || (min === 0 && max === n - 1 && distinct === n));
      if (!ok) {
        addFailure(this.checks.tags, {
          height: h,
          found: `transaction ${b64(tx.id)}: tag_count ${String(tx.tag_count)}, ${n} tag rows indexed ${String(min)}-${String(max)} (${distinct} distinct)${(tx.tags.misplaced ?? 0) > 0 ? `, ${String(tx.tags.misplaced)} of them at another height or position` : ''}`,
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
    const txs = this.chainTxs(block);
    // A format-1 transaction's data root is witnessed or the block is
    // unbound; a witnessed one is used, and a wrong one fails tx_root.
    const ok = await checkTxRoot(
      { height: h, tx_root: block.row.tx_root },
      txs,
      block.witness?.v1Roots,
    );
    if (ok === undefined) {
      this.note('txRootFormat1', h);
      return;
    }
    this.totals.txRootChecked += 1;
    if (!ok) {
      addFailure(this.checks.txRoot, {
        height: h,
        found: `${txs.length} transactions that do not reproduce it${block.txs.some((tx) => tx.format === 1 && (big(tx.data_size) ?? 0n) > 0n) ? ' (with the witnessed v1 data roots)' : ''}`,
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
    // A run of pre-2.0 blocks whose fold never reached a value the chain
    // fixes is bound by nothing.
    this.foldUnbound();
    const t = this.totals;
    this.checks.merkle.detail =
      (t.merkleChecked === 0
        ? 'no block in this range has a rebuildable hash_list_merkle'
        : `${t.merkleChecked} blocks' hash_list_merkle is the fold of the blocks below; ${t.merkleSkipped} are seeds (the 2.0 seed without a fold through 422,249, or the 1.6 seed without heights from 0) or the first block`) +
      (t.foldBound > 0
        ? `; ${t.foldBound} pre-2.0 blocks' witnessed 2.0 seed fold reaches the chain's (a pinned fold or block 422,250's hash_list_merkle)`
        : '');
    this.checks.witnesses.detail =
      'every witness row is for a block or transaction of its band that needs one, once, well formed and as band.json describes; each witnessed fold is the fold of the block below and the block';
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
        ...(this.options.witnesses === true ||
        (this.checks.witnesses.failures?.length ?? 0) > 0
          ? [this.checks.witnesses]
          : []),
        ...(this.options.witnesses === true ||
        (this.checks.hashList10.failures?.length ?? 0) > 0
          ? [this.checks.hashList10]
          : []),
        ...(this.options.witnesses === true ||
        (this.checks.canonical.failures?.length ?? 0) > 0
          ? [this.checks.canonical]
          : []),
      ],
      totals: this.totals,
      unbound,
    };
  }
}
