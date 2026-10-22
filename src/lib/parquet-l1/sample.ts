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
 * a source's word — answers that do not verify, or fields that differ —
 * needs `confirm` distinct machines (never fewer than two) saying so; one
 * lying source makes a draw unreadable, never a failure. Absence refutes
 * only when every source in the pool was heard, none of them answered,
 * and `confirm` machines said 404 (L2's rule: one busy node may hold what
 * the others lack). A 404 never refutes a format-1 transaction: since
 * Arweave be18c1be (2026-08-31) nodes deliberately hide some real format-1
 * transactions without a denomination from `GET /tx`
 * (`is_hidden_v1_denomination0_tx`); its block is asked instead whether
 * it lists the id at all.
 *
 * More than {@link MAX_UNREADABLE_SHARE} of any one kind of draw in any
 * one band unreadable fails the sample as unreadable — not as refuted, so a caller
 * can tell an outage from a forgery ({@link SampleResult.refuted}). What a
 * pass detects is in `detects`, with the unreadable draws counted as
 * possibly forged (L2's rule): a forgery confined to fewer rows than that
 * may pass.
 */
import crypto from 'node:crypto';

import { ArweaveNodePool, type Survey } from '../onchain/arweave-nodes.js';
import { detectableFraction, drawByKey, drawSeed } from '../index-band/draw.js';
import { compareHeaderWithBlock } from './anchor.js';
import { FORK_2_0, verifyHeader, type VerifiedHeader } from './block-hash.js';
import { addFailure, type VerifyCheck } from './checks.js';
import type { DrawnTx, L1Source } from './source.js';
import {
  consensusProblem,
  type FetchedTx,
  fetchedOwnerAddress,
  type IndexedTx,
  indexedFields,
  needsAttestation,
  parseFetchedTx,
  sameFields,
  verifyIndexedTx,
} from './tx-signature.js';

/** Unreadable draws past this share of a sample fail it. */
export const MAX_UNREADABLE_SHARE = 0.2;

/** The fewest distinct machines whose word refutes an index or attests a field. */
export const MIN_CONFIRM = 2;

export interface SampleOptions {
  /** Seeds the draws, so a run can be repeated; reported. */
  seed: number;
  /** Blocks whose headers are fetched, over the whole range (post-2.0 heights: below, no header recomputes). */
  blocks: number;
  /** Transactions whose signatures are fetched, per stratum (band), over the whole range. */
  txsPerStratum: number;
  /**
   * Format-1 transactions drawn per stratum from blocks whose `tx_root`
   * cannot be recomputed (default: as `txsPerStratum`).
   */
  format1PerStratum?: number;
  /**
   * Bytes a stratum may fetch to verify format-1 signatures over their
   * data, counting every machine's copy, shared by both transaction draws.
   */
  v1BytesPerStratum: number;
  /** Fetches in flight at once. */
  concurrency: number;
  /**
   * Distinct machines that must say the same before a source's word
   * refutes the index or attests a field (`--anchor-min`; never below
   * {@link MIN_CONFIRM}).
   */
  confirm?: number;
}

export interface SampleSummary {
  seed: number;
  /** Distinct machines the sources resolve to, and the confirmations required. */
  machines: number;
  confirm: number;
  blocksDrawn: number;
  blocksChecked: number;
  blocksUnreadable: number;
  txsDrawn: number;
  /** Proven by a signature over the index's fields. */
  txsChecked: number;
  /** Checked against the same fields from `confirm` machines: their word, not a proof. */
  txsAttested: number;
  /** Shown wrong (said by `confirm` machines, or proven): never counted as checked. */
  txsRefuted: number;
  txsUnreadable: number;
  /** Format-1 transactions of the uniform draw left unverified for the byte budget (counted unreadable too). */
  txsOverBudget: number;
  /** The format-1 stratum: drawn, checked (proven or attested) and unreadable. */
  format1Drawn: number;
  format1Checked: number;
  format1Refuted: number;
  format1Unreadable: number;
  /** Format-1 draws left unverified for the byte budget (counted unreadable too). */
  format1OverBudget: number;
  /**
   * Parts of the sample asked for that drew nothing though the range
   * holds rows of their kind (`sample_blocks`: every block below the 2.0
   * fork, where no header recomputes).
   */
  empty: string[];
  /** Why the sample may settle less than it was asked to. */
  warnings: string[];
  /** What a pass detects, in words. */
  detects: string[];
}

export interface SampleResult {
  check: VerifyCheck;
  summary: SampleSummary;
  /**
   * Whether the sample shows the index wrong. A failing check that is not
   * refuted failed only because too much of it could not be read.
   */
  refuted: boolean;
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

/** Whether every source of a survey was heard, and none answered or failed: absence can be judged. */
const heardOnlyAbsence = <T>(survey: Survey<T>) =>
  survey.unheard.length === 0 &&
  survey.busy.length === 0 &&
  survey.faults.length === 0 &&
  survey.answers.length === 0;

type TxVerdictKind = 'proven' | 'attested' | 'mismatch' | 'unreadable';

/**
 * What a transaction's block says about it: it lists it, it does not, the
 * index's block is not the chain's at all, or none of that could be had.
 */
export type MembershipVerdict = 'absent' | 'listed' | 'wrongBlock' | 'unknown';

export interface TxVerdict {
  kind: TxVerdictKind;
  reason: string;
  /** Answers received: each a copy of the transaction (and a format-1 one's data). */
  answers: number;
}

/**
 * One drawn transaction, fetched from every source until it is settled:
 * proven (a verifying signature, and, where needed, fields attested by
 * `confirm` machines), a mismatch (said by `confirm` machines), or
 * unreadable.
 *
 * A draw the index holds only part of (no key for its owner) is asked
 * about all the same: a signature that hashes to its id shows the id is
 * real, and its fields, and the owner address the index holds, must then
 * be attested.
 *
 * A format-1 transaction every source says it lacks may be one nodes hide
 * on purpose, so absence alone never refutes it: `membership` is asked
 * whether its block, as the chain serves it, lists it at all.
 */
export async function judgeTx(
  pool: ArweaveNodePool,
  item: DrawnTx,
  confirm: number,
  {
    membership,
  }: {
    membership?: (
      height: number,
      id: Buffer,
    ) => Promise<{ verdict: MembershipVerdict; reason: string }>;
  } = {},
): Promise<TxVerdict> {
  const need = Math.max(MIN_CONFIRM, confirm);
  const complete = 'tx' in item;
  const tx: IndexedTx | undefined = complete ? item.tx : item.partial;
  if (tx === undefined) {
    return {
      kind: 'unreadable',
      reason: 'the index holds too little of it to compare',
      answers: 0,
    };
  }
  const id = tx.id.toString('base64url');
  if (!complete) {
    const broken = consensusProblem(tx);
    if (broken !== undefined) {
      return {
        kind: 'mismatch',
        reason: `breaks consensus: ${broken}`,
        answers: 0,
      };
    }
  }
  const index = indexedFields(tx);
  const ownerAddress = 'tx' in item ? undefined : item.ownerAddress;
  /** For a partial draw: the owner address this answer gives, hex, or ''. */
  const ownerOf = (fetched: FetchedTx) =>
    complete ? '' : (fetchedOwnerAddress(tx, fetched)?.toString('hex') ?? '');
  const ownerMatches = (fetched: FetchedTx) =>
    complete ||
    (ownerAddress !== undefined &&
      ownerAddress !== null &&
      ownerOf(fetched) === ownerAddress.toString('hex'));
  const verdictOf = (fetched: FetchedTx) => {
    if (complete) return verifyIndexedTx(tx, fetched);
    // No owner key: the signature cannot be checked over the fields, but
    // hashing to the id shows the id is the chain's.
    return crypto
      .createHash('sha256')
      .update(fetched.signature)
      .digest()
      .equals(tx.id)
      ? ({ ok: true } as const)
      : ({
          ok: false,
          kind: 'unreadable',
          reason: "the source's signature does not hash to the id",
        } as const);
  };
  const verdicts = (answers: Survey<FetchedTx>['answers']) =>
    answers.map((a) => ({ ...a, verdict: verdictOf(a.value) }));
  const mustAttest = (fetched: FetchedTx) =>
    !complete || needsAttestation(tx, fetched);
  const settled = (survey: Survey<FetchedTx>) => {
    const judged = verdicts(survey.answers);
    const good = judged.filter((a) => a.verdict.ok);
    if (good.length === 0) return false;
    if (!mustAttest(good[0].value)) return true;
    // Only answers whose signature checked out count toward agreement.
    const agreeing = judged.filter(
      (a) =>
        a.verdict.ok &&
        a.value.fields !== undefined &&
        sameFields(a.value.fields, index) &&
        ownerMatches(a.value),
    );
    return machinesOf(agreeing) >= need;
  };
  let survey: Survey<FetchedTx>;
  try {
    survey = await pool.survey(`/tx/${id}`, parseFetchedTx, {
      enough: settled,
    });
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message, answers: 0 };
  }
  const answers = survey.answers.length;
  const judged = verdicts(survey.answers);
  const good = judged.filter((a) => a.verdict.ok);
  if (good.length > 0) {
    if (!mustAttest(good[0].value)) {
      return { kind: 'proven', reason: '', answers };
    }
    const stated = judged.filter(
      (a) => a.verdict.ok && a.value.fields !== undefined,
    );
    const agreeing = stated.filter(
      (a) =>
        sameFields(a.value.fields as NonNullable<FetchedTx['fields']>, index) &&
        ownerMatches(a.value),
    );
    if (machinesOf(agreeing) >= need) {
      return { kind: 'attested', reason: '', answers };
    }
    // Machines agreeing on other fields (or, for a partial draw, another
    // owner) than the index's refute it.
    const others = new Map<string, Set<string>>();
    for (const a of stated) {
      if (agreeing.includes(a)) continue;
      const key = JSON.stringify([a.value.fields, ownerOf(a.value)]);
      others.set(key, (others.get(key) ?? new Set()).add(a.machine));
    }
    for (const [key, machines] of others) {
      if (machines.size >= need) {
        const [fields] = JSON.parse(key) as [FetchedTx['fields'], string];
        const fieldsDiffer = fields === undefined || !sameFields(fields, index);
        return {
          kind: 'mismatch',
          reason: fieldsDiffer
            ? `${machines.size} machines state other fields than the index's (format, target, quantity, reward, anchor, tags, data_size or data_root), which ${complete ? 'its signature does not bind' : 'the index cannot check by signature (it lacks the owner key)'}`
            : `${machines.size} machines give it an owner whose address is not the ${ownerAddress === undefined || ownerAddress === null ? 'missing' : ownerAddress.toString('base64url')} the index holds`,
          answers,
        };
      }
    }
    return {
      kind: 'unreadable',
      reason: `${complete ? 'its signature does not bind its fields' : 'the index lacks its owner key'}, and fewer than ${need} machines attest them`,
      answers,
    };
  }
  // No answer verifies: a refutation only on `need` machines' word.
  const genuine = judged.filter(
    (a) => !a.verdict.ok && a.verdict.kind === 'mismatch',
  );
  if (machinesOf(genuine) >= need) {
    const first = genuine[0].verdict;
    return { kind: 'mismatch', reason: first.ok ? '' : first.reason, answers };
  }
  if (heardOnlyAbsence(survey) && machinesOf(survey.absent) >= need) {
    if (tx.format === 1) {
      // Nodes hide some real format-1 transactions: ask whether its block
      // lists it at all.
      const member =
        membership === undefined
          ? { verdict: 'unknown' as const, reason: 'no block to ask' }
          : await membership(tx.height, tx.id);
      if (member.verdict === 'wrongBlock') {
        return { kind: 'mismatch', reason: member.reason, answers };
      }
      if (member.verdict === 'absent') {
        return {
          kind: 'mismatch',
          reason: `every source was heard, ${machinesOf(survey.absent)} machines have no transaction with this id, and ${member.reason}`,
          answers,
        };
      }
      return {
        kind: 'unreadable',
        reason: `${machinesOf(survey.absent)} machines answer 404, which alone does not refute a format-1 transaction (nodes hide some real ones, is_hidden_v1_denomination0_tx); ${member.reason}`,
        answers,
      };
    }
    return {
      kind: 'mismatch',
      reason: `every source was heard, and ${machinesOf(survey.absent)} machines have no transaction with this id`,
      answers,
    };
  }
  const why = judged.find((a) => !a.verdict.ok)?.verdict;
  return {
    kind: 'unreadable',
    reason:
      why !== undefined && !why.ok
        ? `${why.reason} (said by fewer than ${need} machines)`
        : survey.absent.length > 0
          ? `absent from ${machinesOf(survey.absent)} machines, with ${survey.unheard.length + survey.busy.length + survey.faults.length} sources unheard or failing`
          : 'no source answered',
    answers,
  };
}

/**
 * A format-1 draw past the byte budget: its signature cannot be checked
 * without its data, but its format and data size can, from the field
 * endpoints (`/tx/{id}/format`, `/tx/{id}/data_size`). Machines stating
 * other values refute the index. When every source was heard and `need`
 * machines have no such transaction, its block is asked, as in
 * {@link judgeTx}: a 404 alone never refutes a format-1 transaction.
 * Otherwise the draw stays unreadable.
 */
async function judgeTxHeader(
  pool: ArweaveNodePool,
  tx: IndexedTx,
  need: number,
  membership?: (
    height: number,
    id: Buffer,
  ) => Promise<{ verdict: MembershipVerdict; reason: string }>,
): Promise<{ kind: 'mismatch' | 'unreadable'; reason: string }> {
  const id = tx.id.toString('base64url');
  const compared: string[] = [];
  let absentFrom = 0;
  for (const [field, expected] of [
    ['format', String(tx.format)],
    ['data_size', tx.data_size],
  ] as const) {
    let survey: Survey<string>;
    try {
      survey = await pool.survey(
        `/tx/${id}/${field}`,
        (body) => {
          if (typeof body !== 'number' && typeof body !== 'string') {
            throw new Error(`no ${field}`);
          }
          return String(body);
        },
        {
          enough: (s) =>
            machinesOf(s.answers.filter((a) => a.value === expected)) >= need,
        },
      );
    } catch {
      continue;
    }
    // Compared only where `need` machines answered it at all (ar.io
    // gateways answer /tx/{id}/format with a 500).
    if (machinesOf(survey.answers) >= need) compared.push(field);
    if (heardOnlyAbsence(survey) && machinesOf(survey.absent) >= need) {
      absentFrom = Math.max(absentFrom, machinesOf(survey.absent));
    }
    const byValue = new Map<string, Set<string>>();
    for (const a of survey.answers) {
      if (a.value === expected) continue;
      byValue.set(a.value, (byValue.get(a.value) ?? new Set()).add(a.machine));
    }
    for (const [value, machines] of byValue) {
      if (machines.size >= need) {
        return {
          kind: 'mismatch',
          reason: `${machines.size} machines state ${field} ${value}, the index ${expected}`,
        };
      }
    }
  }
  let asked = '';
  if (absentFrom > 0) {
    const member =
      membership === undefined
        ? { verdict: 'unknown' as const, reason: 'no block to ask' }
        : await membership(tx.height, tx.id);
    if (member.verdict === 'absent' || member.verdict === 'wrongBlock') {
      return {
        kind: 'mismatch',
        reason: `every source was heard, ${absentFrom} machines have no transaction with this id, and ${member.reason}`,
      };
    }
    asked = `; ${absentFrom} machines answer 404, which alone does not refute a format-1 transaction, and ${member.reason}`;
  }
  return {
    kind: 'unreadable',
    reason: `format 1 with ${tx.data_size} bytes of data, past the band's byte budget: its signature not checked; ${compared.length > 0 ? `its ${compared.join(' and ')} compared` : 'neither its format nor its size could be compared'}${asked}`,
  };
}

/**
 * Draws and checks the samples over `[from, to]`: block headers over its
 * post-2.0 heights (below the fork no header recomputes), transactions
 * over all of it, and the format-1 stratum over its post-2.0 heights.
 */
export async function runSample(
  source: L1Source,
  pool: ArweaveNodePool,
  { from, to }: { from: number; to: number },
  options: SampleOptions,
): Promise<SampleResult> {
  const check: VerifyCheck = { name: 'sample', ok: true, detail: '' };
  const confirm = Math.max(MIN_CONFIRM, options.confirm ?? MIN_CONFIRM);
  await pool.ready();
  const machines = new Set(pool.urls.map((u) => pool.addressOf(u))).size;
  const summary: SampleSummary = {
    seed: options.seed,
    machines,
    confirm,
    blocksDrawn: 0,
    blocksChecked: 0,
    blocksUnreadable: 0,
    txsDrawn: 0,
    txsChecked: 0,
    txsAttested: 0,
    txsRefuted: 0,
    txsUnreadable: 0,
    txsOverBudget: 0,
    format1Drawn: 0,
    format1Checked: 0,
    format1Refuted: 0,
    format1Unreadable: 0,
    format1OverBudget: 0,
    empty: [],
    warnings: [],
    detects: [],
  };
  if (machines < confirm) {
    summary.warnings.push(
      `the sources resolve to ${machines} distinct machine${machines === 1 ? '' : 's'}, fewer than the ${confirm} whose word a refutation or an attestation needs: no draw can be refuted on a source's word, and draws whose signature does not bind their fields stay unreadable`,
    );
  }
  let refuted = false;
  const fail = (failure: Parameters<typeof addFailure>[1]) => {
    refuted = true;
    addFailure(check, failure);
  };
  const low = Math.max(from, FORK_2_0);
  const unreadable = {
    blocks: [] as string[],
    txs: [] as string[],
    format1: [] as string[],
  };

  // Unreadable draws are capped per kind and per band: a band whose draws
  // mostly went unanswered is not vouched for by the rest of the range.
  const bands = source.strata(from, to);
  const bandOf = (height: number) =>
    bands.find((b) => b.from <= height && height <= b.to)?.id ?? 'range';
  const tallies = new Map<
    string,
    { what: string; band: string; drawn: number; bad: number; list: string[] }
  >();
  const tally = (what: string, band: string) => {
    const key = `${what}\u0000${band}`;
    let t = tallies.get(key);
    if (t === undefined) {
      t = { what, band, drawn: 0, bad: 0, list: [] };
      tallies.set(key, t);
    }
    return t;
  };

  /**
   * Whether the block at `height`, as the chain serves it, lists `id`: a
   * header recomputed to the index's hash (from the 2.0 fork), or, below
   * it, the same transaction list from `confirm` machines. When no source
   * has a block with the index's hash and `confirm` machines agree on the
   * block at that height, the index's block is not the chain's
   * (`wrongBlock`).
   */
  const membership = async (
    height: number,
    id: Buffer,
  ): Promise<{ verdict: MembershipVerdict; reason: string }> => {
    const row = await source.blockAt(height);
    if (row === undefined || row.indep_hash === null) {
      return {
        verdict: 'unknown',
        reason: 'the index holds no hash for its block',
      };
    }
    const indep = row.indep_hash;
    const hash = indep.toString('base64url');
    const recomputed = height >= FORK_2_0;
    /** A header's hash and transaction list: recomputed from the 2.0 fork, as stated below it. */
    const parse = (body: unknown): { hash: string; txs: string[] } => {
      if (recomputed) {
        const verified = verifyHeader(body);
        if (verified.height !== height) {
          throw new Error(`served the block at ${verified.height}`);
        }
        return {
          hash: verified.indepHash.toString('base64url'),
          txs: verified.txs.map((t) => t.toString('base64url')),
        };
      }
      const json = (body ?? {}) as Record<string, unknown>;
      if (typeof json.indep_hash !== 'string') throw new Error('no indep_hash');
      if (!Array.isArray(json.txs)) throw new Error('no txs');
      return {
        hash: json.indep_hash,
        txs: (json.txs as unknown[]).map(String),
      };
    };
    /** The header `need` machines agree on (one, for a recomputed one of the index's hash). */
    const agreed = (
      survey: Survey<{ hash: string; txs: string[] }>,
      need: number,
    ) => {
      const groups = new Map<string, Set<string>>();
      for (const a of survey.answers) {
        const key = JSON.stringify(a.value);
        groups.set(key, (groups.get(key) ?? new Set()).add(a.machine));
      }
      for (const [key, machines] of groups) {
        if (machines.size >= need) {
          return JSON.parse(key) as { hash: string; txs: string[] };
        }
      }
      return undefined;
    };
    const listing = (txs: string[], how: string) =>
      txs.includes(id.toString('base64url'))
        ? {
            verdict: 'listed' as const,
            reason: `its block at ${height} lists it (${how})`,
          }
        : {
            verdict: 'absent' as const,
            reason: `its block at ${height} does not list it (${how})`,
          };
    // By the index's own hash.
    let byHash: Survey<{ hash: string; txs: string[] }> | undefined;
    try {
      byHash = await pool.survey(
        `/block/hash/${hash}`,
        (body) => {
          const header = parse(body);
          if (header.hash !== hash) throw new Error('served another block');
          return header;
        },
        {
          enough: (s) => agreed(s, recomputed ? 1 : confirm) !== undefined,
        },
      );
    } catch {
      byHash = undefined;
    }
    const mine =
      byHash === undefined
        ? undefined
        : agreed(byHash, recomputed ? 1 : confirm);
    if (mine !== undefined) {
      return listing(
        mine.txs,
        recomputed
          ? 'its header recomputed to the index hash'
          : `the same list from ${confirm} machines`,
      );
    }
    // By height: the chain's block there, agreed by `confirm` machines.
    let byHeight: Survey<{ hash: string; txs: string[] }> | undefined;
    try {
      byHeight = await pool.survey(`/block/height/${height}`, parse, {
        enough: (s) => agreed(s, confirm) !== undefined,
      });
    } catch {
      byHeight = undefined;
    }
    const chain =
      byHeight === undefined ? undefined : agreed(byHeight, confirm);
    if (chain !== undefined) {
      const how = `the block at ${height} from ${confirm} machines${recomputed ? ', its header recomputed' : ''}`;
      if (chain.hash === hash) return listing(chain.txs, how);
      // No source has the index's block, and the chain's at that height
      // is another: the index's block is not the chain's.
      if (
        byHash !== undefined &&
        heardOnlyAbsence(byHash) &&
        machinesOf(byHash.absent) >= confirm
      ) {
        return {
          verdict: 'wrongBlock',
          reason: `the index's block at ${height} is not the chain's: every source was heard, none has a block with its hash ${hash}, and ${how} is ${chain.hash}`,
        };
      }
    }
    return {
      verdict: 'unknown',
      reason: `the transaction list of its block at ${height} could not be had${recomputed ? '' : ` from ${confirm} agreeing machines`}`,
    };
  };

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
    for (const height of drawn) tally('blocks', bandOf(height)).drawn += 1;
    const lostBlock = (height: number, why: string) => {
      summary.blocksUnreadable += 1;
      unreadable.blocks.push(why);
      const t = tally('blocks', bandOf(height));
      t.bad += 1;
      t.list.push(why);
    };
    await inPool(drawn, options.concurrency, async (height) => {
      const row = await source.blockAt(height);
      if (row === undefined || row.indep_hash === null) {
        // The judge has failed this already; the draw cannot be read.
        lostBlock(height, `block ${height}: no indep_hash in the index`);
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
        lostBlock(height, `block ${height}: ${(error as Error).message}`);
        return;
      }
      const header = survey.answers[0]?.value;
      if (header === undefined) {
        if (heardOnlyAbsence(survey) && machinesOf(survey.absent) >= confirm) {
          summary.blocksChecked += 1;
          fail({
            height,
            found: `every source was heard, and ${machinesOf(survey.absent)} machines have no block with the index's hash ${hash}`,
            expected: 'a block of the chain',
          });
          return;
        }
        lostBlock(
          height,
          `block ${height}: ${survey.faults[0]?.reason ?? `no header, ${survey.unheard.length + survey.busy.length} sources unheard`}`,
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
        fail({
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
  } else if (options.blocks > 0 && to >= from) {
    summary.empty.push('sample_blocks');
  }

  // Transactions: a keyed uniform draw per stratum over the whole range,
  // and a draw from the format-1 transactions of post-2.0 blocks tx_root
  // does not cover. One byte budget per stratum, for both.
  const budgets = new Map<string, number>();
  const draws: Array<{
    kind: 'all' | 'format1';
    perStratum: number;
    lo: number;
  }> = [
    { kind: 'all', perStratum: options.txsPerStratum, lo: from },
    {
      kind: 'format1',
      perStratum: options.format1PerStratum ?? options.txsPerStratum,
      lo: low,
    },
  ];
  const worst = { all: 0, format1: 0 };
  for (const { kind, perStratum, lo } of draws) {
    if (perStratum <= 0 || to < lo) continue;
    for (const stratum of source.strata(lo, to)) {
      const drawn = await source.drawTxs(
        stratum,
        drawSeed(options.seed, stratum.id, kind === 'all' ? 1 : 2),
        perStratum,
        lo,
        to,
        kind === 'format1' ? { format1Unbound: true } : {},
      );
      if (drawn.length === 0) continue;
      let lost = 0;
      if (kind === 'all') summary.txsDrawn += drawn.length;
      else summary.format1Drawn += drawn.length;
      const band = tally(
        kind === 'all' ? 'transactions' : 'format-1 transactions',
        stratum.id,
      );
      band.drawn += drawn.length;
      const miss = (why: string) => {
        lost += 1;
        if (kind === 'all') summary.txsUnreadable += 1;
        else summary.format1Unreadable += 1;
        unreadable[kind === 'all' ? 'txs' : 'format1'].push(why);
        band.bad += 1;
        band.list.push(why);
      };
      const settle = (height: number, id: string, verdict: TxVerdict) => {
        if (verdict.kind === 'unreadable') {
          miss(`transaction ${id}: ${verdict.reason}`);
          return;
        }
        if (verdict.kind === 'mismatch') {
          if (kind === 'all') summary.txsRefuted += 1;
          else summary.format1Refuted += 1;
        } else if (kind === 'all') {
          if (verdict.kind === 'attested') summary.txsAttested += 1;
          else summary.txsChecked += 1;
        } else {
          summary.format1Checked += 1;
        }
        if (verdict.kind === 'mismatch') {
          fail({
            height,
            found: `transaction ${id}: ${verdict.reason}`,
            expected: 'a transaction of the chain, as the index holds it',
          });
        }
      };
      await inPool(drawn, options.concurrency, async (item) => {
        const tx = 'tx' in item ? item.tx : item.partial;
        const id = ('tx' in item ? item.tx.id : item.id).toString('base64url');
        const height = 'tx' in item ? item.tx.height : item.height;
        // A format-1 transaction with data is signed over its data, which
        // every machine asked sends in full: the budget counts each copy.
        let reserved = 0;
        if (tx !== undefined && tx.format === 1 && BigInt(tx.data_size) > 0n) {
          const broken = consensusProblem(tx);
          if (broken !== undefined) {
            settle(height, id, {
              kind: 'mismatch',
              reason: `breaks consensus: ${broken}`,
              answers: 0,
            });
            return;
          }
          const size = Number(tx.data_size);
          const left = budgets.get(stratum.id) ?? options.v1BytesPerStratum;
          if (size * confirm > left) {
            if (kind === 'all') summary.txsOverBudget += 1;
            else summary.format1OverBudget += 1;
            const header = await judgeTxHeader(pool, tx, confirm, membership);
            settle(height, id, { ...header, answers: 0 });
            return;
          }
          reserved = size * confirm;
          budgets.set(stratum.id, left - reserved);
        }
        const verdict = await judgeTx(pool, item, confirm, { membership });
        if (reserved > 0 && tx !== undefined) {
          const spent = Number(tx.data_size) * verdict.answers;
          budgets.set(
            stratum.id,
            (budgets.get(stratum.id) ?? 0) + reserved - spent,
          );
        }
        settle(height, id, verdict);
      });
      const p = detectableFraction(drawn.length, 0.95, lost);
      worst[kind] = Math.max(worst[kind], p);
    }
  }
  if (summary.txsDrawn > 0) {
    summary.detects.push(
      `transactions: up to ${options.txsPerStratum} drawn uniformly per band (${summary.txsDrawn} in all): ${summary.txsChecked} proven by their signatures, ${summary.txsAttested} source-attested (an ECDSA owner, format 1 without a denomination, or an owner key the index lacks: the fields from ${confirm} machines, which the signature does not bind), ${summary.txsUnreadable} unreadable (counted as possibly forged); in the weakest band, a share of ${Math.ceil(worst.all * 1000) / 10}% or more of forged transactions would have been caught with 95% probability; a forgery confined to fewer rows than that may pass`,
    );
  }
  if (summary.format1Drawn > 0) {
    summary.detects.push(
      `format-1 transactions of blocks whose tx_root is not recomputed: ${summary.format1Drawn} drawn, ${summary.format1Checked} checked, ${summary.format1Unreadable} unreadable; in the weakest band, ${Math.ceil(worst.format1 * 1000) / 10}% or more of them relabelled or forged would have been caught with 95% probability. Every other field of those blocks' transactions is bound only by the uniform draw above; closing them needs the v1 data roots (a later layout)`,
    );
  }

  for (const { what, band, drawn, bad, list } of tallies.values()) {
    if (drawn > 0 && bad / drawn > MAX_UNREADABLE_SHARE) {
      const at = bands.find((b) => b.id === band);
      addFailure(check, {
        height: at?.to ?? to,
        found: `${bad} of ${drawn} drawn ${what} of ${band} could not be read (first: ${list.slice(0, 3).join('; ')})`,
        expected: `at most ${Math.round(MAX_UNREADABLE_SHARE * 100)}% unreadable in any band`,
      });
    }
  }
  const all = [...unreadable.blocks, ...unreadable.txs, ...unreadable.format1];
  check.detail =
    `seed ${options.seed}, ${machines} machines, ${confirm} to confirm: ${summary.blocksChecked} of ${summary.blocksDrawn} drawn blocks' headers recomputed and compared field by field; ` +
    `${summary.txsChecked} of ${summary.txsDrawn} drawn transactions proven by their signatures, ${summary.txsAttested} source-attested and ${summary.txsRefuted} refuted; ${summary.format1Checked} of ${summary.format1Drawn} format-1 draws checked and ${summary.format1Refuted} refuted` +
    (summary.warnings.length > 0 ? `; ${summary.warnings.join('; ')}` : '') +
    (all.length > 0
      ? `; unreadable: ${all.slice(0, 3).join('; ')}${all.length > 3 ? ` and ${all.length - 3} more` : ''}`
      : '');
  return { check, summary, refuted };
}
