/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Sampled binding of what nothing else in an L1 index binds.
 *
 * Above the 2.0 fork the anchor and the `hash_list_merkle` recurrence bind
 * every block's hash, weave size and `tx_root`. They do not bind the
 * transaction ids (`tx_root` drops them; only their sort order reaches
 * it), the order of `block_transaction_index`, any other block field, or
 * any transaction field. Checking all of them means fetching every header
 * (about 800 GB) or every signature (about 16 days at the measured
 * 57 transactions a second), so this draws a keyed uniform sample instead:
 *
 * - **Blocks.** Each drawn block's header is fetched by the index's own
 *   `indep_hash` (`/block/hash/H`) from one source, its hash recomputed
 *   (`block-hash.ts`) — so the header is the chain's whoever served it —
 *   and every stored field and the ordered transaction ids are compared.
 * - **Transactions.** Each drawn transaction's signature is fetched
 *   (`/tx/{id}`) and verified over the segment rebuilt from the index's
 *   columns (`tx-signature.ts`).
 *
 * Any mismatch fails: the item proved itself. A draw that could not be
 * read is counted, and more than {@link MAX_UNREADABLE_SHARE} of a sample
 * unreadable fails it, as in `index-l2-verify --onchain`. What a passing
 * sample says is in `detects`: a forgery confined to fewer rows than the
 * sample resolves can pass, and the result says so.
 */
import { ArweaveNodePool, NotOnNodesError } from '../onchain/arweave-nodes.js';
import { detectableFraction, drawByKey, drawSeed } from '../index-band/draw.js';
import { compareHeaderWithBlock } from './anchor.js';
import { FORK_2_0, verifyHeader } from './block-hash.js';
import { addFailure, type VerifyCheck } from './checks.js';
import type { L1Source } from './source.js';
import { parseFetchedTx, verifyIndexedTx } from './tx-signature.js';

/** Unreadable draws past this share of a sample fail it. */
export const MAX_UNREADABLE_SHARE = 0.2;

export interface SampleOptions {
  /** Seeds the draws, so a run can be repeated; reported. */
  seed: number;
  /** Blocks whose headers are fetched, over the whole range. */
  blocks: number;
  /** Transactions whose signatures are fetched, per stratum (band). */
  txsPerStratum: number;
  /** Bytes of format-1 data a stratum may fetch to verify signatures over it. */
  v1BytesPerStratum: number;
  /** Fetches in flight at once. */
  concurrency: number;
}

export interface SampleSummary {
  seed: number;
  blocksDrawn: number;
  blocksChecked: number;
  blocksUnreadable: number;
  txsDrawn: number;
  txsChecked: number;
  txsUnreadable: number;
  /** Format-1 transactions with data left unchecked for the byte budget. */
  txsOverBudget: number;
  /** What a pass detects, in words. */
  detects: string[];
}

async function inPool<T>(
  items: T[],
  concurrency: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      async () => {
        while (next < items.length) {
          const item = items[next];
          next += 1;
          await each(item);
        }
      },
    ),
  );
}

const share = (n: number) => `${Math.ceil(detectableFraction(n) * 1000) / 10}%`;

/**
 * Draws and checks the samples over `[from, to]` (post-2.0 heights only:
 * below the fork no header recomputes), and returns the `sample` check
 * and its summary.
 */
export async function runSample(
  source: L1Source,
  pool: ArweaveNodePool,
  { from, to }: { from: number; to: number },
  options: SampleOptions,
): Promise<{ check: VerifyCheck; summary: SampleSummary }> {
  const check: VerifyCheck = { name: 'sample', ok: true, detail: '' };
  const summary: SampleSummary = {
    seed: options.seed,
    blocksDrawn: 0,
    blocksChecked: 0,
    blocksUnreadable: 0,
    txsDrawn: 0,
    txsChecked: 0,
    txsUnreadable: 0,
    txsOverBudget: 0,
    detects: [],
  };
  const low = Math.max(from, FORK_2_0);
  const unreadable: string[] = [];

  // Blocks: a keyed uniform draw of heights, each header fetched by the
  // index's own hash.
  if (options.blocks > 0 && to >= low) {
    const heights = (function* () {
      for (let h = low; h <= to; h += 1) yield h;
    })();
    const drawn = drawByKey(
      heights,
      options.blocks,
      drawSeed(options.seed, 'blocks', 0),
      (h) => String(h),
    );
    summary.blocksDrawn = drawn.length;
    await inPool(drawn, options.concurrency, async (height) => {
      const row = await source.blockAt(height);
      if (row === undefined || row.indep_hash === null) {
        // The judge has failed this already; the draw cannot be read.
        summary.blocksUnreadable += 1;
        unreadable.push(`block ${height}: no indep_hash in the index`);
        return;
      }
      const hash = row.indep_hash.toString('base64url');
      let header;
      try {
        header = await pool.ask(`/block/hash/${hash}`, (body) => {
          const verified = verifyHeader(body);
          if (!verified.indepHash.equals(row.indep_hash as Buffer)) {
            throw new Error('served another block');
          }
          return verified;
        });
      } catch (error) {
        summary.blocksUnreadable += 1;
        unreadable.push(
          `block ${height}: ${error instanceof NotOnNodesError ? 'no source has a block with the index hash' : (error as Error).message}`,
        );
        return;
      }
      summary.blocksChecked += 1;
      const mismatches = compareHeaderWithBlock(
        header,
        row,
        await source.idsAt(height),
      );
      if (mismatches.length > 0) {
        addFailure(check, {
          height,
          found: `the index differs from the chain's block in ${mismatches
            .map((m) => `${m.field} (index ${m.index}, chain ${m.chain})`)
            .join('; ')}`,
          expected: "the chain's header, recomputed from its own fields",
        });
      }
    });
    const k = summary.blocksUnreadable;
    if (summary.blocksDrawn > 0) {
      summary.detects.push(
        `blocks: ${summary.blocksDrawn} drawn uniformly from ${low}-${to}, ${summary.blocksChecked} checked; a range in which ${share(summary.blocksChecked)} or more of the blocks carry a forged field or transaction list would have been caught with 95% probability (unreadable draws counted as possibly forged: ${k})`,
      );
    }
  }

  // Transactions: a keyed uniform draw per stratum, each signature fetched.
  if (options.txsPerStratum > 0 && to >= low) {
    let fewest = Number.MAX_SAFE_INTEGER;
    for (const stratum of source.strata(low, to)) {
      const drawn = await source.drawTxs(
        stratum,
        drawSeed(options.seed, stratum.id, 1),
        options.txsPerStratum,
        low,
        to,
      );
      if (drawn.length === 0) continue;
      fewest = Math.min(fewest, drawn.length);
      summary.txsDrawn += drawn.length;
      let budget = options.v1BytesPerStratum;
      await inPool(drawn, options.concurrency, async (item) => {
        if (!('tx' in item)) {
          // The index lacks part of it (its owner's key): listed in
          // unbound.incomplete, and unreadable here, never a pass.
          summary.txsUnreadable += 1;
          unreadable.push(
            `transaction ${item.id.toString('base64url')}: ${item.problem}`,
          );
          return;
        }
        const tx = item.tx;
        const id = tx.id.toString('base64url');
        if (tx.format === 1 && BigInt(tx.data_size) > 0n) {
          const size = Number(tx.data_size);
          if (size > budget) {
            summary.txsOverBudget += 1;
            summary.txsUnreadable += 1;
            unreadable.push(
              `transaction ${id}: format 1 with ${size} bytes of data, past the stratum's byte budget`,
            );
            return;
          }
          budget -= size;
        }
        let fetched;
        try {
          fetched = await pool.ask(`/tx/${id}`, parseFetchedTx);
        } catch (error) {
          summary.txsUnreadable += 1;
          unreadable.push(`transaction ${id}: ${(error as Error).message}`);
          return;
        }
        const verdict = verifyIndexedTx(tx, fetched);
        if (verdict.ok) {
          summary.txsChecked += 1;
        } else if (verdict.kind === 'unreadable') {
          summary.txsUnreadable += 1;
          unreadable.push(`transaction ${id}: ${verdict.reason}`);
        } else {
          summary.txsChecked += 1;
          addFailure(check, {
            height: tx.height,
            found: `transaction ${id}: ${verdict.reason}`,
            expected: 'a signature over the fields the index holds',
          });
        }
      });
    }
    if (summary.txsDrawn > 0) {
      summary.detects.push(
        `transactions: ${options.txsPerStratum} drawn uniformly per band (${fewest === Number.MAX_SAFE_INTEGER ? 0 : fewest} in the band with fewest), ${summary.txsChecked} checked against their signatures; a band in which ${share(Math.min(fewest, options.txsPerStratum))} or more of the transactions are forged would have been caught with 95% probability; a forgery confined to fewer rows than that may pass`,
      );
    }
  }

  for (const [what, drawn, bad] of [
    ['blocks', summary.blocksDrawn, summary.blocksUnreadable],
    ['transactions', summary.txsDrawn, summary.txsUnreadable],
  ] as const) {
    if (drawn > 0 && bad / drawn > MAX_UNREADABLE_SHARE) {
      addFailure(check, {
        height: to,
        found: `${bad} of ${drawn} drawn ${what} could not be read (first: ${unreadable.slice(0, 3).join('; ')})`,
        expected: `at most ${Math.round(MAX_UNREADABLE_SHARE * 100)}% unreadable`,
      });
    }
  }
  check.detail =
    `seed ${options.seed}: ${summary.blocksChecked} of ${summary.blocksDrawn} drawn blocks' headers recomputed and compared field by field; ` +
    `${summary.txsChecked} of ${summary.txsDrawn} drawn transactions' signatures verified over the index's fields` +
    (unreadable.length > 0
      ? `; unreadable: ${unreadable.slice(0, 3).join('; ')}${unreadable.length > 3 ? ` and ${unreadable.length - 3} more` : ''}`
      : '');
  return { check, summary };
}
