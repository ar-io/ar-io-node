/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The per-block checks, once, for every reader that drives them.
 *
 * Two things read an L1 index: a gateway's `core.db` and a directory of
 * bands. Reading rows out of SQLite and out of Parquet is genuinely
 * different work, but deciding whether a block is *right* is not, and
 * writing that decision twice is how the two quietly stop agreeing.
 *
 * So the readers stay separate and the judgement lives here. A driver
 * feeds blocks in ascending order and the totals come out at the end;
 * the chain rules themselves remain in `chain.ts`, which this calls.
 */
import {
  ChainBlock,
  expectedHashListMerkle,
  foldSeed,
  PREDECESSOR_HAS_NO_MERKLE,
} from './chain.js';
import {
  addFailure,
  STRICT_DATA_SPLIT_THRESHOLD,
  VerifyCheck,
} from './verify.js';

/** The columns every reader has to supply for a block. */
export interface CheckedBlock {
  height: number;
  indep_hash: Buffer | null;
  previous_block: Buffer | null;
  block_size: number;
  weave_size: number;
  hash_list_merkle: Buffer | null;
  tx_root: Buffer | null;
}

export interface BlockChecks {
  contiguous: VerifyCheck;
  linked: VerifyCheck;
  merkle: VerifyCheck;
  sizes: VerifyCheck;
  accounting: VerifyCheck;
}

export interface BlockTotals {
  blocks: number;
  merkleChecked: number;
  merkleSkipped: number;
  accountingChecked: number;
  accountingSkipped: number;
  /** The weave the range grew by, and what its transactions account for. */
  weaveGrew: number;
  accountedFor: number;
}

/**
 * Walks a range of blocks, judging each against the one below it.
 *
 * `from` is the base rather than a checked height: its own transactions
 * are not counted, because `weave_size(from)` is where the accounting
 * starts. That is also why Arweave's genesis block, whose transactions
 * the weave never counted, needs no special case.
 */
export class BlockWalker {
  readonly checks: BlockChecks;
  private previous: CheckedBlock | undefined;
  private seedFold: Buffer | undefined;
  private base: number | undefined;
  private totals: BlockTotals = {
    blocks: 0,
    merkleChecked: 0,
    merkleSkipped: 0,
    accountingChecked: 0,
    accountingSkipped: 0,
    weaveGrew: 0,
    accountedFor: 0,
  };

  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {
    this.seedFold = from === 0 ? Buffer.alloc(0) : undefined;
    this.checks = {
      contiguous: {
        name: 'contiguous',
        ok: true,
        detail: 'every height in the range is present, exactly once',
      },
      linked: {
        name: 'linked',
        ok: true,
        detail: "each block's previous_block is the hash of the block below it",
      },
      merkle: { name: 'hash_list_merkle', ok: true, detail: '' },
      sizes: {
        name: 'block_size',
        ok: true,
        detail: "each block's block_size is how much it grew the weave",
      },
      accounting: { name: 'weave_accounting', ok: true, detail: '' },
    };
  }

  /** One block, in ascending height order, with its transactions' total size. */
  step(block: CheckedBlock, txBytes: number): void {
    this.totals.blocks += 1;
    const previous = this.previous;
    if (previous === undefined) {
      if (block.height !== this.from) {
        addFailure(this.checks.contiguous, {
          height: this.from,
          found: `the range starts at ${block.height}`,
          expected: `${this.from}`,
        });
      }
      this.base = block.weave_size;
      this.seedFold = foldSeed(this.seedFold, block as unknown as ChainBlock);
      this.previous = block;
      return;
    }
    if (block.height !== previous.height + 1) {
      addFailure(this.checks.contiguous, {
        height: previous.height + 1,
        found: `the next block is ${block.height}`,
        expected: `${previous.height + 1}`,
      });
      // Nothing below can be judged across a hole: the weave difference
      // would span the missing blocks and read as a mismatch everywhere
      // after it, burying the gap that caused it.
      this.seedFold = foldSeed(this.seedFold, block as unknown as ChainBlock);
      this.previous = block;
      return;
    }

    if (
      previous.indep_hash === null ||
      block.previous_block === null ||
      !block.previous_block.equals(previous.indep_hash)
    ) {
      addFailure(this.checks.linked, {
        height: block.height,
        found: block.previous_block?.toString('base64url') ?? 'null',
        expected: previous.indep_hash?.toString('base64url') ?? 'null',
      });
    }

    const want = expectedHashListMerkle(
      block.height,
      previous as unknown as ChainBlock,
      this.seedFold,
    );
    if (want === PREDECESSOR_HAS_NO_MERKLE) {
      this.totals.merkleChecked += 1;
      addFailure(this.checks.merkle, {
        height: block.height,
        found: 'the block below carries no hash_list_merkle',
        expected: 'every block above the 1.6 fork has one',
      });
    } else if (want === undefined) {
      this.totals.merkleSkipped += 1;
    } else {
      this.totals.merkleChecked += 1;
      const got = block.hash_list_merkle;
      const ok =
        want === null
          ? got === null || got.length === 0
          : got !== null && want.equals(got);
      if (!ok) {
        addFailure(this.checks.merkle, {
          height: block.height,
          found: got === null ? 'null' : got.toString('base64url'),
          expected: want === null ? 'empty' : want.toString('base64url'),
        });
      }
    }

    const grew = block.weave_size - previous.weave_size;
    if (grew !== block.block_size) {
      addFailure(this.checks.sizes, {
        height: block.height,
        found: `block_size ${block.block_size}`,
        expected: `weave grew by ${grew}`,
      });
    }
    if (block.weave_size <= STRICT_DATA_SPLIT_THRESHOLD) {
      this.totals.accountingChecked += 1;
      this.totals.accountedFor += txBytes;
      if (grew !== txBytes) {
        addFailure(this.checks.accounting, {
          height: block.height,
          found: `transactions total ${txBytes}`,
          expected: `weave grew by ${grew}`,
        });
      }
    } else {
      this.totals.accountingSkipped += 1;
    }

    this.seedFold = foldSeed(this.seedFold, block as unknown as ChainBlock);
    this.previous = block;
  }

  /** Totals and the finished check wording, once every block has been stepped. */
  finish(): { checks: VerifyCheck[]; totals: BlockTotals } {
    const expected = this.to - this.from + 1;
    if (this.totals.blocks !== expected) {
      addFailure(this.checks.contiguous, {
        height: this.to,
        found: `${this.totals.blocks} blocks`,
        expected: `${expected}`,
      });
    }
    this.checks.merkle.detail =
      this.totals.merkleChecked === 0
        ? 'no block in this range has a rebuildable hash_list_merkle'
        : `${this.totals.merkleChecked} blocks commit to every block hash below them; ${this.totals.merkleSkipped} are seeds or below the 1.6 fork`;
    this.checks.accounting.detail =
      this.totals.accountingSkipped === 0
        ? "each block grew the weave by exactly its transactions' data_size"
        : `${this.totals.accountingChecked} blocks grew the weave by exactly their transactions' data_size; ${this.totals.accountingSkipped} are past the padding threshold, where that no longer holds`;
    if (this.previous !== undefined && this.base !== undefined) {
      this.totals.weaveGrew = this.previous.weave_size - this.base;
    }
    return {
      checks: [
        this.checks.contiguous,
        this.checks.linked,
        this.checks.merkle,
        this.checks.sizes,
        this.checks.accounting,
      ],
      totals: this.totals,
    };
  }
}
