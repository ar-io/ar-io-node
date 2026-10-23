/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * One L1 verification run, whatever holds the index, and the one result
 * shape every mode reports (`index-l1-verify --core-db`, `--bands-dir`,
 * and the importer's check before it writes).
 *
 * **What `ok` means.** Every check that ran passed, and nothing the run
 * could not establish was left unaccepted: an index not anchored to the
 * chain (`--allow-unanchored`), blocks left unbound (`--allow-unbound`,
 * `--allow-unverified-format1`). An accepted gap is echoed in `accepted`,
 * so a pass that rests on one says so. Checks that did not run are listed
 * in `skipped`; what binds what is said in `assurance`.
 */
import type { ArweaveNodePool } from '../onchain/arweave-nodes.js';
import { anchorBlock, type AnchorResult } from './anchor.js';
import { FORK_2_0 } from './block-hash.js';
import type { Fork20Pins } from './chain.js';
import { bindingsAssurance } from './column-bindings.js';
import { addFailure, type VerifyCheck } from './checks.js';
import { L1Judge, type JudgeBlockRow, type JudgeUnbound } from './judge.js';
import { runSample, type SampleOptions, type SampleSummary } from './sample.js';
import type { L1Source } from './source.js';

/** Heights read per query, so one window's rows are never all held at once. */
export const WINDOW = 10_000;

/** The gaps a caller may accept, each by its own flag. */
export interface L1Allowances {
  /** `--allow-unanchored`: no anchor, or one that could not be bound. */
  unanchored?: boolean;
  /** `--allow-unbound`: pre-2.0 blocks. */
  unbound?: boolean;
  /** `--allow-incomplete`: blocks whose transactions or owners' keys the index lacks. */
  incomplete?: boolean;
  /** `--allow-unverified-format1`: blocks whose tx_root needs a v1 data root. */
  unverifiedFormat1?: boolean;
  /**
   * `--allow-unsampled`: with a sample asked for, `--sample-format1 0` over
   * a range holding format-1 transactions with data from the 2.0 fork,
   * whose format nothing else checks.
   */
  unsampled?: boolean;
}

export interface L1RunOptions {
  from: number;
  to: number;
  /** Recompute `tx_root` (default true). */
  txRoot?: boolean;
  window?: number;
  /** Where anchors and samples are fetched from; none, and both are skipped. */
  pool?: ArweaveNodePool;
  /** Distinct machines that must agree on the anchor (default 2). */
  anchorMin?: number;
  /** The samples; skipped when absent or with no pool. */
  sample?: SampleOptions;
  allow?: L1Allowances;
  /** Checks the caller ran itself (files, identity, publication, lookups), first in the result. */
  checks?: VerifyCheck[];
  /** Checks the caller did not run, with the run's own. */
  skipped?: string[];
  /** What the caller's own checks establish, with the run's own. */
  assurance?: string[];
  /** Flags the caller accepted something with. */
  accepted?: string[];
  /**
   * The chain's 2.0 seed folds, for a test chain; mainnet's
   * (`FORK_2_0_FOLD_PINS`) otherwise. Never from a command line.
   */
  foldPins?: Fork20Pins;
  /** Report the judge's `witnesses` check: the source reads `l1-4` bands. */
  witnesses?: boolean;
  /** Failures the caller found in rows the judge does not walk (wallets, stray tags), under the judge's check names. */
  judgeFailures?: Array<{
    check: Parameters<L1Judge['fail']>[0];
    height: number;
    found: string;
    expected: string;
  }>;
}

/** The verdict of an L1 verification, in every mode. */
export interface L1VerifyReport {
  ok: boolean;
  heightRange: [number, number];
  blocks: number;
  /** Bound to the chain at `anchor.height`: recomputed, agreed, and equal to the index. */
  anchored: boolean;
  anchor?: {
    height: number;
    indepHash?: string;
    /** Each header served was recomputed from its own fields. */
    recomputed: true;
    machines: number;
    sources: AnchorResult['sources'];
    mismatches: AnchorResult['mismatches'];
    problems: string[];
  };
  /** What could not be bound, by class; each fails unless accepted. */
  unbound: JudgeUnbound;
  sample?: SampleSummary;
  skipped: string[];
  accepted: string[];
  assurance: string[];
  /** The absolute weave size at the top of the range, its growth over the range, and what transactions account for. */
  weaveSize?: string;
  weaveGrowth?: string;
  accountedFor?: string;
  merkleChecked: number;
  merkleSkipped: number;
  accountingChecked: number;
  accountingSkipped: number;
  txRootChecked: number;
  /** Pre-2.0 blocks a witnessed 2.0 seed fold binds to the chain (`l1-4`). */
  foldBound: number;
  /** Format-1 transactions with data from the 2.0 fork, which only the format-1 draw checks are format 1. */
  format1Txs: number;
  checks: VerifyCheck[];
  seconds: number;
}

/**
 * The block an index ending at `to` can be anchored at, or why it cannot:
 * the top of the range from the 2.0 fork on; for a range ending just below
 * it, the fork block, whose recomputed header binds `previous_block`.
 */
async function anchorHeightFor(
  source: L1Source,
  to: number,
): Promise<{ height: number } | { reason: string }> {
  if (to >= FORK_2_0) return { height: to };
  if (to === FORK_2_0 - 1 && (await source.blockAt(FORK_2_0)) !== undefined) {
    return { height: FORK_2_0 };
  }
  return {
    reason: `the range ends at ${to}, below the 2.0 fork: no header there can be recomputed, and the 1.6-2.0 recurrence carries no weave size or tx_root, so nothing above reaches it without the 2.0 hash list or seed fold`,
  };
}

/** Runs the judge, the anchor and the samples over a source, and assembles the report. */
export async function runL1Verify(
  source: L1Source,
  options: L1RunOptions,
): Promise<L1VerifyReport> {
  const started = Date.now();
  const { from, to } = options;
  const allow = options.allow ?? {};
  // The block below the range, when the index holds it, so the first block
  // is judged (its link, merkle, size and accounting) like the rest.
  let prior: Awaited<ReturnType<L1Source['blockAt']>>;
  try {
    prior = from > 0 ? await source.blockAt(from - 1) : undefined;
  } catch {
    prior = undefined;
  }
  const judge = new L1Judge(from, to, {
    txRoot: options.txRoot !== false,
    ...(options.foldPins !== undefined ? { foldPins: options.foldPins } : {}),
    ...(options.witnesses === true ? { witnesses: true } : {}),
    ...(prior !== undefined
      ? { prior: { ...prior, tx_count: null } as JudgeBlockRow }
      : {}),
  });
  await source.judge(judge, from, to, options.window ?? WINDOW);
  for (const f of options.judgeFailures ?? []) {
    judge.fail(f.check, f.height, f.found, f.expected);
  }
  const judged = judge.finish();
  const t0 = judged.totals;
  const checks: VerifyCheck[] = [...(options.checks ?? []), ...judged.checks];
  const skipped = [...(options.skipped ?? [])];
  // Without the block below, the first block's link and size are the base
  // of the walk, bound by nothing.
  const firstUnbound = from > 0 && prior === undefined;
  if (firstUnbound) skipped.push('first_block_link');
  const accepted = [...(options.accepted ?? [])];
  const assurance = [...(options.assurance ?? [])];
  if (options.txRoot === false) {
    skipped.push('tx_root');
    accepted.push('--skip-tx-root');
  }

  // The anchor.
  let anchored = false;
  // The anchor showed the index wrong (its row differs from the chain's,
  // is missing, or does not build on the range): never accepted away.
  let refuted = false;
  let anchorReport: L1VerifyReport['anchor'];
  const anchorCheck: VerifyCheck = { name: 'anchor', ok: true, detail: '' };
  if (options.pool === undefined) {
    skipped.push('anchor');
    anchorCheck.detail =
      'not anchored: no source was given (--anchor-from), so nothing outside this index vouches for it';
  } else {
    const at = await anchorHeightFor(source, to);
    if ('reason' in at) {
      anchorCheck.detail = `not anchored: ${at.reason}`;
      addFailure(anchorCheck, {
        height: to,
        found: at.reason,
        expected: 'a range reaching the 2.0 fork',
      });
    } else {
      let row: Awaited<ReturnType<L1Source['blockAt']>>;
      let ids: Awaited<ReturnType<L1Source['idsAt']>>;
      try {
        row = await source.blockAt(at.height);
        ids = await source.idsAt(at.height);
      } catch (error) {
        // The index's own row cannot be read: nothing to bind.
        row = undefined;
        ids = { links: [], txs: [] };
        anchorCheck.detail = `the index's block at ${at.height} could not be read: ${(error as Error).message}`;
      }
      const result = await anchorBlock(
        options.pool,
        at.height,
        row,
        ids,
        options.anchorMin ?? 2,
      );
      if (at.height !== to) {
        // The fork block anchors a range ending just below it through its
        // previous_block, which its recomputed hash binds.
        const top = await source.blockAt(to);
        if (
          top?.indep_hash === null ||
          top === undefined ||
          row?.previous_block === null ||
          row === undefined ||
          !row.previous_block.equals(top.indep_hash)
        ) {
          result.ok = false;
          refuted = true;
          result.problems.push(
            `the block at ${at.height} does not build on the index's block at ${to}`,
          );
        }
      }
      anchored = result.ok;
      if (
        result.mismatches.length > 0 ||
        row === undefined ||
        row.indep_hash === null
      ) {
        refuted = true;
      }
      anchorReport = {
        height: at.height,
        ...(result.indepHash !== undefined
          ? { indepHash: result.indepHash }
          : {}),
        recomputed: true,
        machines: result.machines,
        sources: result.sources,
        mismatches: result.mismatches,
        problems: result.problems,
      };
      if (result.ok) {
        anchorCheck.detail = `the block at ${at.height} is bound to the chain: ${result.machines} distinct machines served it, every header recomputed to ${result.indepHash ?? ''}, and the index's row and transaction ids equal it`;
      } else {
        anchorCheck.detail = `not anchored at ${at.height}: ${result.problems.join('; ')}`;
        addFailure(anchorCheck, {
          height: at.height,
          found: result.problems.join('; '),
          expected: `at least ${options.anchorMin ?? 2} distinct machines agreeing on a header that recomputes and equals the index`,
        });
      }
    }
  }
  if (anchored) {
    checks.push(anchorCheck);
    assurance.push(
      `anchored at ${anchorReport?.height ?? to}: ${anchorReport?.machines ?? 0} distinct machines agreed on a header whose hash was recomputed from its fields, and the index equals it. Agreement means the sources' upstream nodes agree: two gateways proxying /block/ to their operators' chosen Arweave nodes are not two independent nodes.`,
      `every block from the 2.0 fork up to the anchor has its indep_hash, weave_size and tx_root bound to the chain through the hash_list_merkle recurrence, and its previous_block and block_size through the links and the weave${firstUnbound ? ` (except the first, ${from}: the block below it is not in the index, so its previous_block and block_size are bound by nothing — 'first_block_link' skipped)` : ''}; its other fields, its transaction ids and their order, and every transaction field are bound only by the sample`,
    );
  } else if (allow.unanchored === true && !refuted) {
    if (!skipped.includes('anchor')) skipped.push('anchor');
    accepted.push('--allow-unanchored');
    checks.push({
      ...anchorCheck,
      ok: true,
      failures: undefined,
      more: undefined,
    });
    assurance.push(
      'not anchored, accepted (--allow-unanchored): the checks show only that the index agrees with itself; a fabricated chain built by the same rules passes them',
    );
  } else {
    checks.push(anchorCheck);
    if (anchorCheck.ok) {
      addFailure(anchorCheck, {
        height: to,
        found: anchorCheck.detail,
        expected: 'an anchor (--anchor-from), or --allow-unanchored',
      });
    }
  }

  // Bands: what no check binds, by column (column-bindings.ts).
  if (options.witnesses === true) assurance.push(...bindingsAssurance());
  if (t0.foldBound > 0) {
    assurance.push(
      `${t0.foldBound} pre-2.0 blocks: indep_hash, weave_size and transition tx_root bound to the chain through the witnessed 2.0 seed fold, which reaches the folds pinned in this build (the last equal to block 422,250's hash_list_merkle); every other header field and the block's transaction ids bound to Arweave's checkpoint of them (genesis_data/hash_list_1_0, whose fold of 2.0 hashes is pinned in this build), Arweave-checkpointed rather than chain-bound; their transactions' data sizes and data roots through the transition tx_root, recomputed`,
    );
  }

  // The samples.
  let sample: SampleSummary | undefined;
  if (options.sample !== undefined) {
    // A half-skipped sample is a skipped one, for the half.
    if (options.sample.blocks <= 0) {
      skipped.push('sample_blocks');
      accepted.push('--sample-blocks 0');
    }
    if (options.sample.txsPerStratum <= 0) {
      skipped.push('sample_txs');
      accepted.push('--sample-txs 0');
    }
    if (
      (options.sample.format1PerStratum ?? options.sample.txsPerStratum) <= 0
    ) {
      skipped.push('sample_format1');
      accepted.push('--sample-format1 0');
    }
  }
  if (options.pool !== undefined && options.sample !== undefined) {
    try {
      const out = await runSample(
        source,
        options.pool,
        { from, to },
        options.sample,
      );
      checks.push(out.check);
      sample = out.summary;
      // Asked for, but nothing of the range could be drawn (every block
      // below the 2.0 fork, where no header recomputes).
      skipped.push(...out.summary.empty);
      assurance.push(...out.summary.warnings, ...out.summary.detects);
    } catch (error) {
      checks.push({
        name: 'sample',
        ok: false,
        detail: 'the sample could not be drawn',
        failures: [
          {
            height: to,
            found: `the index could not be read for the sample: ${(error as Error).message}`,
            expected: 'a readable index',
          },
        ],
      });
    }
  } else {
    skipped.push('sample');
    assurance.push(
      'no sample: transaction ids, their order and every transaction field are unchecked against the chain',
    );
  }

  // Format 1 is checked only by the format-1 draw: a witnessed root binds
  // a transaction's size and root, never that it is format 1, so a draw
  // of none over a range that holds some leaves a relabel unchecked.
  if (
    options.sample !== undefined &&
    (options.sample.format1PerStratum ?? options.sample.txsPerStratum) <= 0 &&
    judged.totals.format1Txs > 0
  ) {
    const unsampled: VerifyCheck = {
      name: 'sample_format1',
      ok: true,
      detail: `${judged.totals.format1Txs} format-1 transactions with data from the 2.0 fork, none drawn (--sample-format1 0)`,
    };
    if (allow.unsampled === true) {
      accepted.push('--allow-unsampled');
      assurance.push(
        `--sample-format1 0, accepted (--allow-unsampled): ${judged.totals.format1Txs} format-1 transactions with data are checked to be format 1 by nothing; a format-2 transaction relabelled format 1 would pass`,
      );
    } else {
      addFailure(unsampled, {
        height: to,
        found: unsampled.detail,
        expected:
          'the format-1 draw over them (--sample-format1), or --allow-unsampled',
      });
    }
    checks.push(unsampled);
  }

  // What was left unbound, and whether it was accepted.
  const unbound = judged.unbound;
  const unboundCheck: VerifyCheck = {
    name: 'unbound',
    ok: true,
    detail: 'every block in the range is bound',
  };
  const classes: Array<[keyof JudgeUnbound, boolean, string]> = [
    ['pre20', allow.unbound === true, '--allow-unbound'],
    ['incomplete', allow.incomplete === true, '--allow-incomplete'],
    [
      'txRootFormat1',
      allow.unverifiedFormat1 === true,
      '--allow-unverified-format1',
    ],
  ];
  const parts: string[] = [];
  for (const [key, allowed, flag] of classes) {
    const cls = unbound[key];
    if (cls === undefined) continue;
    parts.push(
      `${key}: ${cls.blocks} blocks${allowed ? ` (accepted, ${flag})` : ''}`,
    );
    if (allowed) {
      if (!accepted.includes(flag)) accepted.push(flag);
    } else {
      addFailure(unboundCheck, {
        height: cls.heights[0] ?? to,
        found: `${cls.blocks} blocks unbound (${key}): ${cls.reason}`,
        expected: `every block bound, or ${flag}`,
      });
    }
  }
  if (parts.length > 0) unboundCheck.detail = parts.join('; ');
  checks.push(unboundCheck);

  const t = judged.totals;
  const report: L1VerifyReport = {
    ok: checks.every((c) => c.ok),
    heightRange: [from, to],
    blocks: t.blocks,
    anchored,
    ...(anchorReport !== undefined ? { anchor: anchorReport } : {}),
    unbound,
    ...(sample !== undefined ? { sample } : {}),
    skipped: [...new Set(skipped)],
    accepted: [...new Set(accepted)],
    assurance,
    ...(t.weaveTop !== undefined
      ? {
          weaveSize: t.weaveTop.toString(),
          weaveGrowth: (t.weaveTop - (t.weaveBase ?? t.weaveTop)).toString(),
          accountedFor: t.accountedFor.toString(),
        }
      : {}),
    merkleChecked: t.merkleChecked,
    merkleSkipped: t.merkleSkipped,
    accountingChecked: t.accountingChecked,
    accountingSkipped: t.accountingSkipped,
    txRootChecked: t.txRootChecked,
    foldBound: t.foldBound,
    format1Txs: t.format1Txs,
    checks,
    seconds: (Date.now() - started) / 1000,
  };
  return report;
}
