/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checking a gateway's L1 index against what the chain itself commits to.
 *
 * Above the 2.0 fork a block's `tx_root` recomputes from its transactions,
 * so the transaction set of every block is provable on its own. Below the
 * fork `tx_root` is empty, and a pre-2.0 block's identity hash cannot be
 * recomputed from a header at all: it commits to the full wallet list at
 * that height, to the recall block's whole binary, and to every
 * transaction's bytes including its data and signature. Nobody can redo
 * that from an index, and modern Arweave nodes do not try — they take
 * everything below the fork from a hardcoded block index.
 *
 * What is left is an accounting identity, and it turns out to be exact.
 * A pre-2.0 block adds its transactions' `data_size` to the weave, so for
 * every height
 *
 *     weave_size(h) - weave_size(h-1) = block_size(h) = sum of data_size
 *
 * and those differences telescope: the whole pre-2.0 range collapses to
 * `weave_size` at the top. The block at {@link FORK_2_0_HEIGHT} is the
 * first post-2.0 block, and a post-2.0 block commits its own `weave_size`
 * in the segment its identity hash is taken over. So one trusted block
 * hash pins the total size of every transaction beneath it.
 *
 * **What this proves.** Given the identity hash of the anchor block, no
 * transaction below the fork can be invented, dropped, or have its size
 * changed. The index is also checked to be contiguous and correctly
 * linked.
 *
 * **What it does not prove.** Membership of a particular pre-2.0 block.
 * The intermediate `weave_size` values are not committed individually, so
 * transactions could in principle be moved between pre-2.0 blocks with
 * those values adjusted to match. Closing that needs agreement between
 * independent gateways, which is corroboration rather than proof.
 *
 * Above the weave offset where Arweave began padding each transaction to
 * a chunk boundary (`STRICT_DATA_SPLIT_THRESHOLD`, which the weave passed
 * around height 800,000) the weave grows by the padded size rather than
 * `data_size`, so the identity stops holding — which is why the default
 * range stops at the fork, well below it, and why nothing is lost by
 * stopping there: above the fork `tx_root` is the stronger check anyway.
 */
import Sqlite from 'better-sqlite3';

/** The first post-2.0 block. Its segment commits its own `weave_size`. */
export const FORK_2_0_HEIGHT = 422_250;

/**
 * The weave offset past which Arweave pads each transaction's data to a
 * chunk boundary before adding it to the weave (`STRICT_DATA_SPLIT_THRESHOLD`
 * in `ar_consensus.hrl`). Below it the weave grows by `data_size` exactly;
 * above it the accounting identity no longer holds, so blocks above it are
 * counted as skipped rather than reported as wrong. It is an offset, not a
 * height, and every block carries its `weave_size`, so each block decides
 * for itself which side it is on.
 */
export const STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830;

/** Failing heights kept per check, so a broken index reports rather than floods. */
export const MAX_FAILURES_REPORTED = 20;

export interface VerifyFailure {
  height: number;
  found: string;
  expected: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  failures?: VerifyFailure[];
  /** Failing heights beyond the ones listed. */
  more?: number;
}

export interface VerifyResult {
  heightRange: [number, number];
  blocks: number;
  /**
   * Whether the top of the range is a block that commits its own
   * `weave_size`, which is what turns the accounting identity into a
   * check against the chain rather than against itself.
   */
  anchored: boolean;
  anchorHeight?: number;
  /** The weave size the anchor commits to, and what the index accounts for. */
  weaveSize?: string;
  accountedFor?: string;
  /** Blocks whose growth was checked against their transactions, and those past the padding threshold. */
  accountingChecked: number;
  accountingSkipped: number;
  checks: VerifyCheck[];
  ok: boolean;
  seconds: number;
}

export class VerifyRefused extends Error {}

interface BlockRow {
  height: number;
  indep_hash: Buffer | null;
  previous_block: Buffer | null;
  block_size: number;
  weave_size: number;
}

/** The heights a `core.db` holds, or `undefined` when it holds none. */
export function stableHeightRange(
  db: Sqlite.Database,
): [number, number] | undefined {
  const row = db
    .prepare('SELECT MIN(height) AS lo, MAX(height) AS hi FROM stable_blocks')
    .get() as { lo: number | null; hi: number | null };
  if (row.lo === null || row.hi === null) return undefined;
  return [row.lo, row.hi];
}

/**
 * The heights to check, given what the database holds and what the
 * caller asked for.
 *
 * An index reaching below the fork is capped at the fork and no further:
 * that block commits its own weave size, which anchors everything
 * beneath it, and above it `tx_root` proves each block's transactions
 * outright — so reading on costs tens of millions of rows and proves
 * nothing this check can add. An index starting above the fork has no
 * such boundary, so it is read whole.
 *
 * @throws {VerifyRefused} when the request does not name two heights the
 * database holds.
 */
export function chooseRange(
  held: [number, number],
  { from, to }: { from?: number; to?: number } = {},
  forkHeight = FORK_2_0_HEIGHT,
): [number, number] {
  const low = from ?? held[0];
  const high =
    to ?? (low < forkHeight ? Math.min(held[1], forkHeight) : held[1]);
  if (low < held[0] || high > held[1]) {
    throw new VerifyRefused(
      `The index holds heights ${held[0]}-${held[1]}, which does not cover ${low}-${high}`,
    );
  }
  if (high <= low) {
    throw new VerifyRefused(
      `Nothing to check between ${low} and ${high}: this compares each block with the one below it, so it needs at least two heights`,
    );
  }
  return [low, high];
}

const add = (check: VerifyCheck, failure: VerifyFailure): void => {
  check.ok = false;
  check.failures ??= [];
  if (check.failures.length < MAX_FAILURES_REPORTED) {
    check.failures.push(failure);
  } else {
    check.more = (check.more ?? 0) + 1;
  }
};

/**
 * Walks a height range once, checking every block against the one below
 * it and against the transactions the index gives it.
 *
 * `from` is the base of the telescoping sum rather than a checked height:
 * its own transactions are not counted, because `weave_size(from)` is
 * where the accounting starts. Running from 0 is what makes that correct
 * for a whole chain — and it is also why the genesis block's 314
 * transactions, which Arweave never counted into the weave, do not have
 * to be special-cased here.
 */
export function verifyRange(
  db: Sqlite.Database,
  {
    from,
    to,
    forkHeight = FORK_2_0_HEIGHT,
  }: {
    from: number;
    to: number;
    /**
     * The first height whose block commits its own `weave_size`. Only
     * moved for a chain whose forks are elsewhere — Arweave's own
     * `FORKS_RESET` build puts them all at 0 — and by tests, which
     * cannot build a fixture 422,250 blocks long.
     */
    forkHeight?: number;
  },
): VerifyResult {
  const started = Date.now();
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) {
    throw new VerifyRefused('--from and --to must be whole heights, from >= 0');
  }
  if (to <= from) {
    throw new VerifyRefused(
      `--to (${to}) must be above --from (${from}): the check compares each block with the one below it`,
    );
  }

  const contiguous: VerifyCheck = {
    name: 'contiguous',
    ok: true,
    detail: 'every height in the range is present, exactly once',
  };
  const linked: VerifyCheck = {
    name: 'linked',
    ok: true,
    detail: "each block's previous_block is the hash of the block below it",
  };
  const sizes: VerifyCheck = {
    name: 'block_size',
    ok: true,
    detail: "each block's block_size is how much it grew the weave",
  };
  const accounting: VerifyCheck = {
    name: 'weave_accounting',
    ok: true,
    detail: '',
  };

  // height is `INTEGER PRIMARY KEY`, so this is a rowid range scan, and
  // the transaction sums come off (height, block_transaction_index). Both
  // arrive in height order, so they merge in one pass and nothing larger
  // than a row is held.
  const blocks = db
    .prepare(
      `SELECT height, indep_hash, previous_block, block_size, weave_size
       FROM stable_blocks WHERE height BETWEEN ? AND ? ORDER BY height`,
    )
    .iterate(from, to) as IterableIterator<BlockRow>;
  const sums = db
    .prepare(
      `SELECT height, SUM(data_size) AS total FROM stable_transactions
       WHERE height BETWEEN ? AND ? GROUP BY height ORDER BY height`,
    )
    // `from + 1` only saves reading a row: the merge skips anything
    // below the first block it compares anyway, and the first block of
    // the range is never compared.
    .iterate(from + 1, to) as IterableIterator<{
    height: number;
    total: number | null;
  }>;

  let pending = sums.next();
  /** The transactions' data_size at a height, 0 where it holds none. */
  const txBytesAt = (height: number): number => {
    while (!pending.done && pending.value.height < height) {
      pending = sums.next();
    }
    if (pending.done || pending.value.height !== height) return 0;
    const total = pending.value.total ?? 0;
    pending = sums.next();
    return total;
  };

  let previous: BlockRow | undefined;
  let seen = 0;
  let accounted = 0;
  let checked = 0;
  let skipped = 0;
  let base: number | undefined;
  for (const block of blocks) {
    seen += 1;
    if (previous === undefined) {
      if (block.height !== from) {
        add(contiguous, {
          height: from,
          found: `the range starts at ${block.height}`,
          expected: `${from}`,
        });
      }
      base = block.weave_size;
      previous = block;
      continue;
    }
    if (block.height !== previous.height + 1) {
      add(contiguous, {
        height: previous.height + 1,
        found: `the next block is ${block.height}`,
        expected: `${previous.height + 1}`,
      });
      // Nothing below can be judged across a hole: the weave difference
      // would span the missing blocks and read as a mismatch everywhere
      // after it, burying the gap that caused it.
      previous = block;
      continue;
    }
    if (
      previous.indep_hash === null ||
      block.previous_block === null ||
      !block.previous_block.equals(previous.indep_hash)
    ) {
      add(linked, {
        height: block.height,
        found: block.previous_block?.toString('base64url') ?? 'null',
        expected: previous.indep_hash?.toString('base64url') ?? 'null',
      });
    }
    const grew = block.weave_size - previous.weave_size;
    if (grew !== block.block_size) {
      add(sizes, {
        height: block.height,
        found: `block_size ${block.block_size}`,
        expected: `weave grew by ${grew}`,
      });
    }
    const txBytes = txBytesAt(block.height);
    if (block.weave_size <= STRICT_DATA_SPLIT_THRESHOLD) {
      checked += 1;
      accounted += txBytes;
      if (grew !== txBytes) {
        add(accounting, {
          height: block.height,
          found: `transactions total ${txBytes}`,
          expected: `weave grew by ${grew}`,
        });
      }
    } else {
      skipped += 1;
    }
    previous = block;
  }

  const expected = to - from + 1;
  if (seen !== expected) {
    add(contiguous, {
      height: to,
      found: `${seen} blocks`,
      expected: `${expected}`,
    });
  }

  accounting.detail =
    skipped === 0
      ? "each block grew the weave by exactly its transactions' data_size"
      : `${checked} blocks grew the weave by exactly their transactions' data_size; ${skipped} are past the padding threshold, where that no longer holds`;

  const checks = [contiguous, linked, sizes, accounting];
  const result: VerifyResult = {
    heightRange: [from, to],
    blocks: seen,
    // Anchored only when the top commits its own weave size AND nothing
    // in between was skipped: a gap in the accounting breaks the chain
    // of differences the anchor is supposed to pin.
    anchored: to >= forkHeight && skipped === 0,
    accountingChecked: checked,
    accountingSkipped: skipped,
    checks,
    ok: checks.every((c) => c.ok),
    seconds: 0,
  };
  if (previous !== undefined && base !== undefined && skipped === 0) {
    const total: VerifyCheck = {
      name: 'anchor',
      ok: true,
      detail:
        to >= forkHeight
          ? `weave_size at ${to} is committed by that block, and the range accounts for all of it`
          : `weave_size at ${to} is not committed by a post-2.0 block, so this only shows the range is self-consistent`,
    };
    const weave = previous.weave_size - base;
    result.weaveSize = String(weave);
    result.accountedFor = String(accounted);
    if (weave !== accounted) {
      add(total, {
        height: to,
        found: `transactions account for ${accounted} bytes`,
        expected: `the weave grew by ${weave}`,
      });
    }
    if (result.anchored) result.anchorHeight = to;
    checks.push(total);
    result.ok = checks.every((c) => c.ok);
  }
  result.seconds = (Date.now() - started) / 1000;
  return result;
}
