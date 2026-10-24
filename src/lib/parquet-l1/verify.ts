/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checking a gateway's L1 index (`core.db`) against the chain.
 *
 * **What binds what.** An index agreeing with itself proves nothing: a
 * fabricated chain built by Arweave's rules passes every self-check. What
 * ties it to the real chain is an anchor (`anchor.ts`): the block at the
 * top of the range, served by at least two distinct machines, its identity
 * hash recomputed from its own fields (`block-hash.ts`), and equal to the
 * index's row field by field. From the 2.0 fork every block's
 * `hash_list_merkle` folds the hash, weave size and `tx_root` of every block
 * below it, so an anchored top binds each of those for every post-2.0 block
 * in the range; the links bind each `previous_block`, the weave each
 * `block_size`, and a recomputed `tx_root` the data sizes and data roots of
 * each block's transactions.
 *
 * **What it does not bind** without the sample (`sample.ts`): transaction
 * ids (`tx_root` drops them), their order, any other transaction field, and
 * any block field beyond those above. The sample fetches a keyed uniform
 * draw of headers and signatures and checks them; the result says what
 * fraction of forged rows it would catch.
 *
 * **What it cannot bind at all from `core.db`.** Below the 2.0 fork a
 * block's hash covers the full wallet list (from the 1.6 fork a deep hash
 * over the header fields and the list; below it a SHA-384 over the header
 * as JSON with the full hash list too), which no header carries, so it
 * cannot be recomputed; those blocks are bound only through the 2.0 seed
 * fold, which needs each block's transition `tx_root`. A block holding a
 * format-1 transaction with data has a `tx_root` built from that data's
 * root. `core.db` stores neither (an `l1-4` band's witnesses do, and
 * `--bands-dir` binds both), so both are reported as `unbound`, by class,
 * and fail the run unless accepted (`--allow-unbound`,
 * `--allow-unverified-format1`). Block 422,250's `hash_list_merkle` is
 * still checked against the pinned fold through 422,249.
 */
import Sqlite from 'better-sqlite3';

import { FORK_2_0 } from './chain.js';
import { VerifyRefused } from './checks.js';
import { CoreDbSource } from './core-db-source.js';
import {
  runL1Verify,
  type L1RunOptions,
  type L1VerifyReport,
} from './verify-run.js';

export {
  addFailure,
  MAX_FAILURES_REPORTED,
  VerifyRefused,
  type VerifyCheck,
  type VerifyFailure,
} from './checks.js';
export { STRICT_DATA_SPLIT_THRESHOLD } from './judge.js';

/** The first post-2.0 block: the lowest height whose header can be recomputed. */
export const FORK_2_0_HEIGHT = FORK_2_0;

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
 * The heights to check, given what the database holds and what the caller
 * asked for: the whole held range by default.
 *
 * @throws {VerifyRefused} when the request does not name two heights the
 * database holds.
 */
export function chooseRange(
  held: [number, number],
  { from, to }: { from?: number; to?: number } = {},
): [number, number] {
  const low = from ?? held[0];
  const high = to ?? held[1];
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

/**
 * Verifies `[from, to]` of a `core.db` (see the module comment for what
 * binds what). Read-only: every query is bounded by height through an
 * index.
 */
export async function verifyCoreDb(
  db: Sqlite.Database,
  options: L1RunOptions,
): Promise<L1VerifyReport> {
  const { from, to } = options;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) {
    throw new VerifyRefused('--from and --to must be whole heights, from >= 0');
  }
  if (to <= from) {
    throw new VerifyRefused(
      `--to (${to}) must be above --from (${from}): the check compares each block with the one below it`,
    );
  }
  return runL1Verify(new CoreDbSource(db), {
    ...options,
    skipped: [...(options.skipped ?? []), 'tag_orphans', 'publication'],
    assurance: [
      ...(options.assurance ?? []),
      "core.db: tag rows are read through their transaction; one whose transaction is missing is unreachable by every reader and not looked for (tags have no height index) — 'tag_orphans' skipped",
    ],
  });
}
