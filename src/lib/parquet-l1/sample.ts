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
 *   `indep_hash` (`/block/hash/H`), its hash recomputed (`block-hash.ts`) —
 *   so the header is the chain's whoever served it — and every stored
 *   field, the height and the ordered transaction ids are compared.
 * - **Transactions.** Each drawn transaction is fetched (`/tx/{id}`) and
 *   checked against its signature over the index's columns
 *   (`tx-signature.ts`). Where the signature does not bind the fields (an
 *   ECDSA owner; format 1 with no denomination), the fields must also be
 *   the same from at least `confirm` distinct machines: those draws are
 *   counted as `source-attested`, not proven.
 * - **Format 1.** Separately, transactions drawn from the format-1
 *   transactions of blocks whose `tx_root` cannot be recomputed, so a
 *   format-2 transaction relabelled format 1 to escape `tx_root` is caught
 *   at the same rate as any other forgery.
 *
 * **Verdicts.** A header that recomputes to the index's hash proves itself,
 * so one source suffices for a match or a mismatch. A transaction answer
 * that verifies proves itself too. Anything that would refute the index on
 * a source's word — every source saying it has no such block or
 * transaction, or answers that do not verify — needs `confirm` distinct
 * machines saying so; one lying source makes a draw unreadable, never a
 * failure. More than {@link MAX_UNREADABLE_SHARE} of a sample unreadable
 * fails it. What a pass detects is in `detects`, with the unreadable draws
 * counted as possibly forged (L2's rule): a forgery confined to fewer rows
 * than that may pass.
 */
import { ArweaveNodePool, type Survey } from '../onchain/arweave-nodes.js';
import { detectableFraction, drawByKey, drawSeed } from '../index-band/draw.js';
import { compareHeaderWithBlock } from './anchor.js';
import { FORK_2_0, verifyHeader, type VerifiedHeader } from './block-hash.js';
import { addFailure, type VerifyCheck } from './checks.js';
import type { DrawnTx, L1Source } from './source.js';
import {
  type FetchedTx,
  indexedFields,
  needsAttestation,
  parseFetchedTx,
  sameFields,
  verifyIndexedTx,
} from './tx-signature.js';

/** Unreadable draws past this share of a sample fail it. */
export const MAX_UNREADABLE_SHARE = 0.2;

export interface SampleOptions {
  /** Seeds the draws, so a run can be repeated; reported. */
  seed: number;
  /** Blocks whose headers are fetched, over the whole range. */
  blocks: number;
  /** Transactions whose signatures are fetched, per stratum (band). */
  txsPerStratum: number;
  /**
   * Format-1 transactions drawn per stratum from blocks whose `tx_root`
   * cannot be recomputed (default: as `txsPerStratum`).
   */
  format1PerStratum?: number;
  /** Bytes of format-1 data a stratum may fetch to verify signatures over it. */
  v1BytesPerStratum: number;
  /** Fetches in flight at once. */
  concurrency: number;
  /**
   * Distinct machines that must say the same before a source's word
   * refutes the index or attests a field (default 2).
   */
  confirm?: number;
}

export interface SampleSummary {
  seed: number;
  blocksDrawn: number;
  blocksChecked: number;
  blocksUnreadable: number;
  txsDrawn: number;
  /** Proven by a signature over the index's fields. */
  txsChecked: number;
  /** Checked against the same fields from `confirm` machines: their word, not a proof. */
  txsAttested: number;
  txsUnreadable: number;
  /** Format-1 transactions with data left unchecked for the byte budget (counted unreadable too). */
  txsOverBudget: number;
  /** The format-1 stratum: drawn, checked (proven or attested) and unreadable. */
  format1Drawn: number;
  format1Checked: number;
  format1Unreadable: number;
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

/** The share a pass rules out at 95%, counting `k` unreadable draws as possibly forged. */
const share = (n: number, k: number) =>
  `${Math.ceil(detectableFraction(n, 0.95, k) * 1000) / 10}%`;

const machinesOf = <T>(list: Array<{ machine: string; value?: T }>) =>
  new Set(list.map((a) => a.machine)).size;

type TxVerdictKind = 'proven' | 'attested' | 'mismatch' | 'unreadable';

/**
 * One drawn transaction, fetched from every source until it is settled:
 * proven (a verifying signature, and, where needed, fields attested by
 * `confirm` machines), a mismatch (said by `confirm` machines), or
 * unreadable.
 */
export async function judgeTx(
  pool: ArweaveNodePool,
  item: Extract<DrawnTx, { tx: unknown }>,
  confirm: number,
): Promise<{ kind: TxVerdictKind; reason: string }> {
  const tx = item.tx;
  const id = tx.id.toString('base64url');
  const index = indexedFields(tx);
  const verdicts = (answers: Survey<FetchedTx>['answers']) =>
    answers.map((a) => ({ ...a, verdict: verifyIndexedTx(tx, a.value) }));
  const settled = (survey: Survey<FetchedTx>) => {
    const judged = verdicts(survey.answers);
    const good = judged.filter((a) => a.verdict.ok);
    if (good.length === 0) return false;
    if (!needsAttestation(tx, good[0].value)) return true;
    const agreeing = judged.filter(
      (a) => a.value.fields !== undefined && sameFields(a.value.fields, index),
    );
    return machinesOf(agreeing) >= confirm;
  };
  let survey: Survey<FetchedTx>;
  try {
    survey = await pool.survey(`/tx/${id}`, parseFetchedTx, {
      enough: settled,
    });
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message };
  }
  const judged = verdicts(survey.answers);
  const good = judged.filter((a) => a.verdict.ok);
  if (good.length > 0) {
    if (!needsAttestation(tx, good[0].value)) {
      return { kind: 'proven', reason: '' };
    }
    const stated = judged.filter((a) => a.value.fields !== undefined);
    const agreeing = stated.filter((a) =>
      sameFields(a.value.fields as NonNullable<FetchedTx['fields']>, index),
    );
    if (machinesOf(agreeing) >= confirm) {
      return { kind: 'attested', reason: '' };
    }
    // Machines agreeing on other fields than the index's refute it.
    const others = new Map<string, Set<string>>();
    for (const a of stated) {
      if (agreeing.includes(a)) continue;
      const key = JSON.stringify(a.value.fields);
      others.set(key, (others.get(key) ?? new Set()).add(a.machine));
    }
    for (const [, machines] of others) {
      if (machines.size >= confirm) {
        return {
          kind: 'mismatch',
          reason: `${machines.size} machines state other fields than the index's (target, quantity, reward, anchor, tags, data_size or data_root), which its signature does not bind`,
        };
      }
    }
    return {
      kind: 'unreadable',
      reason: `its signature does not bind its fields, and fewer than ${confirm} machines attest them`,
    };
  }
  // No answer verifies: a refutation only on `confirm` machines' word.
  const genuine = judged.filter(
    (a) => !a.verdict.ok && a.verdict.kind === 'mismatch',
  );
  if (machinesOf(genuine) >= confirm) {
    const first = genuine[0].verdict;
    return {
      kind: 'mismatch',
      reason: first.ok ? '' : first.reason,
    };
  }
  if (judged.length === 0 && machinesOf(survey.absent) >= confirm) {
    return {
      kind: 'mismatch',
      reason: `${machinesOf(survey.absent)} machines have no transaction with this id`,
    };
  }
  const why = judged.find((a) => !a.verdict.ok)?.verdict;
  return {
    kind: 'unreadable',
    reason:
      why !== undefined && !why.ok
        ? `${why.reason} (said by fewer than ${confirm} machines)`
        : survey.absent.length > 0
          ? `absent from fewer than ${confirm} machines, unheard from the rest`
          : 'no source answered',
  };
}

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
  const confirm = options.confirm ?? 2;
  const summary: SampleSummary = {
    seed: options.seed,
    blocksDrawn: 0,
    blocksChecked: 0,
    blocksUnreadable: 0,
    txsDrawn: 0,
    txsChecked: 0,
    txsAttested: 0,
    txsUnreadable: 0,
    txsOverBudget: 0,
    format1Drawn: 0,
    format1Checked: 0,
    format1Unreadable: 0,
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
      let survey: Survey<VerifiedHeader>;
      try {
        survey = await pool.survey(
          `/block/hash/${hash}`,
          (body) => {
            const verified = verifyHeader(body);
            if (!verified.indepHash.equals(row.indep_hash as Buffer)) {
              throw new Error('served another block');
            }
            return verified;
          },
          { enough: (s) => s.answers.length > 0 },
        );
      } catch (error) {
        summary.blocksUnreadable += 1;
        unreadable.push(`block ${height}: ${(error as Error).message}`);
        return;
      }
      const header = survey.answers[0]?.value;
      if (header === undefined) {
        if (machinesOf(survey.absent) >= confirm) {
          summary.blocksChecked += 1;
          addFailure(check, {
            height,
            found: `${machinesOf(survey.absent)} machines have no block with the index's hash ${hash}`,
            expected: 'a block of the chain',
          });
          return;
        }
        summary.blocksUnreadable += 1;
        unreadable.push(
          `block ${height}: ${survey.faults[0]?.reason ?? `no header from ${confirm} machines`}`,
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
    summary.detects.push(
      `blocks: ${summary.blocksDrawn} drawn uniformly from ${low}-${to}, ${summary.blocksChecked} checked, ${summary.blocksUnreadable} unreadable (counted as possibly forged); a range in which ${share(summary.blocksDrawn, summary.blocksUnreadable)} or more of the blocks carry a forged field or transaction list would have been caught with 95% probability`,
    );
  }

  // Transactions: a keyed uniform draw per stratum, and a draw from the
  // format-1 transactions of blocks tx_root does not cover.
  const draws: Array<{
    stratum: 'all' | 'format1';
    perStratum: number;
  }> = [
    { stratum: 'all', perStratum: options.txsPerStratum },
    {
      stratum: 'format1',
      perStratum: options.format1PerStratum ?? options.txsPerStratum,
    },
  ];
  let worst = { all: 0, format1: 0 };
  for (const { stratum: kind, perStratum } of draws) {
    if (perStratum <= 0 || to < low) continue;
    for (const stratum of source.strata(low, to)) {
      const drawn = await source.drawTxs(
        stratum,
        drawSeed(options.seed, stratum.id, kind === 'all' ? 1 : 2),
        perStratum,
        low,
        to,
        kind === 'format1' ? { format1Unbound: true } : {},
      );
      if (drawn.length === 0) continue;
      let budget = options.v1BytesPerStratum;
      let lost = 0;
      if (kind === 'all') summary.txsDrawn += drawn.length;
      else summary.format1Drawn += drawn.length;
      const miss = (why: string) => {
        lost += 1;
        if (kind === 'all') summary.txsUnreadable += 1;
        else summary.format1Unreadable += 1;
        unreadable.push(why);
      };
      await inPool(drawn, options.concurrency, async (item) => {
        if (!('tx' in item)) {
          // The index lacks part of it (its owner's key): listed in
          // unbound.incomplete, and unreadable here, never a pass.
          miss(`transaction ${item.id.toString('base64url')}: ${item.problem}`);
          return;
        }
        const tx = item.tx;
        const id = tx.id.toString('base64url');
        if (tx.format === 1 && BigInt(tx.data_size) > 0n) {
          const size = Number(tx.data_size);
          if (size > budget) {
            summary.txsOverBudget += 1;
            miss(
              `transaction ${id}: format 1 with ${size} bytes of data, past the stratum's byte budget`,
            );
            return;
          }
          budget -= size;
        }
        const verdict = await judgeTx(pool, item, confirm);
        if (verdict.kind === 'unreadable') {
          miss(`transaction ${id}: ${verdict.reason}`);
          return;
        }
        if (kind === 'all') {
          if (verdict.kind === 'attested') summary.txsAttested += 1;
          else summary.txsChecked += 1;
        } else {
          summary.format1Checked += 1;
        }
        if (verdict.kind === 'mismatch') {
          addFailure(check, {
            height: tx.height,
            found: `transaction ${id}: ${verdict.reason}`,
            expected: 'a transaction of the chain, as the index holds it',
          });
        }
      });
      const p = detectableFraction(drawn.length, 0.95, lost);
      worst = { ...worst, [kind]: Math.max(worst[kind], p) };
    }
  }
  if (summary.txsDrawn > 0) {
    summary.detects.push(
      `transactions: up to ${options.txsPerStratum} drawn uniformly per band (${summary.txsDrawn} in all): ${summary.txsChecked} proven by their signatures, ${summary.txsAttested} source-attested (an ECDSA owner, or format 1 without a denomination: the fields from ${confirm} machines, which the signature does not bind), ${summary.txsUnreadable} unreadable (counted as possibly forged); in the weakest band, a share of ${Math.ceil(worst.all * 1000) / 10}% or more of forged transactions would have been caught with 95% probability; a forgery confined to fewer rows than that may pass`,
    );
  }
  if (summary.format1Drawn > 0) {
    summary.detects.push(
      `format-1 transactions of blocks whose tx_root is not recomputed: ${summary.format1Drawn} drawn, ${summary.format1Checked} checked, ${summary.format1Unreadable} unreadable; in the weakest band, ${Math.ceil(worst.format1 * 1000) / 10}% or more of them relabelled or forged would have been caught with 95% probability. Every other field of those blocks' transactions is bound only by the uniform draw above; closing them needs the v1 data roots (a later layout)`,
    );
  }

  for (const [what, drawn, bad] of [
    ['blocks', summary.blocksDrawn, summary.blocksUnreadable],
    ['transactions', summary.txsDrawn, summary.txsUnreadable],
    ['format-1 transactions', summary.format1Drawn, summary.format1Unreadable],
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
    `${summary.txsChecked} of ${summary.txsDrawn} drawn transactions proven by their signatures and ${summary.txsAttested} source-attested; ${summary.format1Checked} of ${summary.format1Drawn} format-1 draws checked` +
    (unreadable.length > 0
      ? `; unreadable: ${unreadable.slice(0, 3).join('; ')}${unreadable.length > 3 ? ` and ${unreadable.length - 3} more` : ''}`
      : '');
  return { check, summary };
}
