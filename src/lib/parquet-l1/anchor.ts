/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Binding an L1 index to the real chain at one block: the anchor.
 *
 * The index's own checks (links, `hash_list_merkle`, `tx_root`, weave
 * accounting) show only that it agrees with itself; a fabricated chain
 * built by the same rules passes them. The anchor is what ties it to
 * Arweave. Done right it takes three steps, and every one is needed:
 *
 * 1. **Agreement.** At least `minSources` distinct machines (names that
 *    share any resolved address are one machine; see `ArweaveNodePool`)
 *    serve the block at the anchor height, and every one that answered
 *    gives the same identity hash.
 * 2. **Recomputation.** Each served header's identity hash is recomputed
 *    from its own fields (`block-hash.ts`). Agreement on a hash alone
 *    proves nothing about the fields beside it — a source could pair the
 *    real hash with a fabricated `weave_size` or `hash_list_merkle` — and
 *    a recomputed header cannot.
 * 3. **Comparison.** The bound header is compared with the index's row at
 *    that height, field by field, and with the index's ordered transaction
 *    ids.
 *
 * From there the index's own `hash_list_merkle` recurrence binds every
 * post-2.0 block below the anchor: each block's hash, weave size and
 * `tx_root`. What two sources agreeing means is limited by who they are:
 * two ar.io gateways that both proxy `/block/` to their operators' chosen
 * Arweave nodes agree when those choices agree, not as two independent
 * nodes would. The result names each source and the addresses it resolved
 * to, so whoever reads it can judge.
 */
import { ArweaveNodePool, type Survey } from '../onchain/arweave-nodes.js';
import { verifyHeader, type VerifiedHeader } from './block-hash.js';
import { quoteLongIntegers } from '../exact-json.js';

/** A block row as an index stores it (`stable_blocks`, or a band's `blocks`). */
export interface L1BlockRow {
  height: number;
  indep_hash: Buffer | null;
  previous_block: Buffer | null;
  nonce: Buffer | null;
  hash: Buffer | null;
  block_timestamp: number | bigint | string | null;
  diff: string | number | bigint | null;
  cumulative_diff: string | number | bigint | null;
  last_retarget: number | bigint | string | null;
  reward_addr: Buffer | null;
  reward_pool: string | number | bigint | null;
  block_size: number | bigint | string | null;
  weave_size: number | bigint | string | null;
  usd_to_ar_rate_dividend: number | bigint | string | null;
  usd_to_ar_rate_divisor: number | bigint | string | null;
  scheduled_usd_to_ar_rate_dividend: number | bigint | string | null;
  scheduled_usd_to_ar_rate_divisor: number | bigint | string | null;
  hash_list_merkle: Buffer | null;
  wallet_list: Buffer | null;
  tx_root: Buffer | null;
}

/** The columns of {@link L1BlockRow}, as both readers select them. */
export const BLOCK_ROW_COLUMNS = [
  'height',
  'indep_hash',
  'previous_block',
  'nonce',
  'hash',
  'block_timestamp',
  'diff',
  'cumulative_diff',
  'last_retarget',
  'reward_addr',
  'reward_pool',
  'block_size',
  'weave_size',
  'usd_to_ar_rate_dividend',
  'usd_to_ar_rate_divisor',
  'scheduled_usd_to_ar_rate_dividend',
  'scheduled_usd_to_ar_rate_divisor',
  'hash_list_merkle',
  'wallet_list',
  'tx_root',
] as const;

/** A field of the index that differs from the chain's header. */
export interface HeaderMismatch {
  field: string;
  index: string;
  chain: string;
}

/** A stored whole number as decimal text, with `core.db`'s `"28.0"` form read as 28. */
function decimal(value: number | bigint | string | null): string | null {
  if (value === null) return null;
  const text = String(value);
  const m = /^(\d+)(\.0+)?$/.exec(text);
  return m === null ? text : BigInt(m[1]).toString();
}

const b64 = (value: Buffer | null) =>
  value === null ? 'null' : value.toString('base64url');

/**
 * Every stored field of a block that disagrees with its verified header,
 * and the ordered transaction ids, from the links (`block_transactions`)
 * and from the transactions table, each by `block_transaction_index`.
 * Empty when the index holds exactly the chain's block.
 */
export function compareHeaderWithBlock(
  header: VerifiedHeader,
  row: L1BlockRow,
  ids: { links: Buffer[]; txs: Buffer[] },
): HeaderMismatch[] {
  const out: HeaderMismatch[] = [];
  const blob = (field: string, index: Buffer | null, chain: Buffer) => {
    const mine = index ?? Buffer.alloc(0);
    if (!mine.equals(chain)) {
      out.push({ field, index: b64(index), chain: b64(chain) });
    }
  };
  const whole = (
    field: string,
    index: number | bigint | string | null,
    chain: bigint | undefined,
  ) => {
    const mine = decimal(index);
    const theirs = chain === undefined ? null : chain.toString();
    if (mine !== theirs) {
      out.push({ field, index: String(mine), chain: String(theirs) });
    }
  };
  // A header fetched by hash can be another height's: the row claims this one.
  if (header.height !== row.height) {
    out.push({
      field: 'height',
      index: String(row.height),
      chain: String(header.height),
    });
  }
  blob('indep_hash', row.indep_hash, header.indepHash);
  blob('previous_block', row.previous_block, header.previousBlock);
  blob('nonce', row.nonce, header.nonce);
  blob('hash', row.hash, header.hash);
  whole('block_timestamp', row.block_timestamp, header.timestamp);
  whole('diff', row.diff, header.diff);
  whole('cumulative_diff', row.cumulative_diff, header.cumulativeDiff);
  whole('last_retarget', row.last_retarget, header.lastRetarget);
  // `unclaimed` is stored as no address.
  if (header.rewardAddr === null) {
    if (row.reward_addr !== null && row.reward_addr.length > 0) {
      out.push({
        field: 'reward_addr',
        index: b64(row.reward_addr),
        chain: 'unclaimed',
      });
    }
  } else {
    blob('reward_addr', row.reward_addr, header.rewardAddr);
  }
  whole('reward_pool', row.reward_pool, header.rewardPool);
  whole('block_size', row.block_size, header.blockSize);
  whole('weave_size', row.weave_size, header.weaveSize);
  whole(
    'usd_to_ar_rate_dividend',
    row.usd_to_ar_rate_dividend,
    header.usdToArRate?.[0],
  );
  whole(
    'usd_to_ar_rate_divisor',
    row.usd_to_ar_rate_divisor,
    header.usdToArRate?.[1],
  );
  whole(
    'scheduled_usd_to_ar_rate_dividend',
    row.scheduled_usd_to_ar_rate_dividend,
    header.scheduledUsdToArRate?.[0],
  );
  whole(
    'scheduled_usd_to_ar_rate_divisor',
    row.scheduled_usd_to_ar_rate_divisor,
    header.scheduledUsdToArRate?.[1],
  );
  blob('hash_list_merkle', row.hash_list_merkle, header.hashListMerkle);
  blob('wallet_list', row.wallet_list, header.walletList);
  blob('tx_root', row.tx_root, header.txRoot);
  const list = (field: string, mine: Buffer[]) => {
    const same =
      mine.length === header.txs.length &&
      mine.every((id, i) => id.equals(header.txs[i]));
    if (!same) {
      const at = mine.findIndex(
        (id, i) => i >= header.txs.length || !id.equals(header.txs[i]),
      );
      out.push({
        field,
        index: `${mine.length} ids${at >= 0 ? `, first differing at index ${at}: ${b64(mine[at])}` : ''}`,
        chain: `${header.txs.length} ids in block order`,
      });
    }
  };
  list('block_transactions', ids.links);
  list('transactions', ids.txs);
  return out;
}

/** What one source said for the anchor height. */
export interface AnchorSource {
  url: string;
  /** The address its name resolved to that the pool counts it as. */
  machine: string;
  /** The identity hash it served, recomputed from its header. */
  indepHash?: string;
  /** Why it gave no usable header: absent, busy, or a header that does not recompute. */
  error?: string;
}

/** The anchor's verdict. */
export interface AnchorResult {
  height: number;
  /** Bound: enough machines agreed, each header recomputed, and the index matches. */
  ok: boolean;
  /** The hash the sources agreed on, when they did. */
  indepHash?: string;
  sources: AnchorSource[];
  /** Distinct machines that answered with a header that recomputes. */
  machines: number;
  /** Fields of the index's row that differ from the bound header. */
  mismatches: HeaderMismatch[];
  /** Why it is not bound, in words. */
  problems: string[];
}

/**
 * Binds the index's block at `height` to the chain: the block from at
 * least `minSources` distinct machines, every header recomputed, all
 * agreeing, and equal to the index's row and transaction ids.
 *
 * `row` is the index's block at `height`, or undefined when it holds none:
 * a missing row or a missing `indep_hash` is a failure, never "nothing to
 * compare".
 */
export async function anchorBlock(
  pool: ArweaveNodePool,
  height: number,
  row: L1BlockRow | undefined,
  ids: { links: Buffer[]; txs: Buffer[] },
  minSources: number,
): Promise<AnchorResult> {
  const survey: Survey<VerifiedHeader> = await pool.survey(
    `/block/height/${height}`,
    (body) => {
      const verified = verifyHeader(body);
      if (verified.height !== height) {
        throw new Error(`served the block at ${verified.height}`);
      }
      return verified;
    },
  );
  const sources: AnchorSource[] = [
    ...survey.answers.map((a) => ({
      url: a.node,
      machine: a.machine,
      indepHash: a.value.indepHash.toString('base64url'),
    })),
    ...survey.faults.map((f) => ({
      url: f.node,
      machine: f.machine,
      error: `served a header that does not verify: ${f.reason}`,
    })),
    ...survey.absent.map((a) => ({
      url: a.node,
      machine: a.machine,
      error: 'does not have it (404)',
    })),
    ...survey.unheard.map((node) => ({
      url: node,
      machine: pool.addressOf(node),
      error: 'did not answer (busy, timed out or unreachable)',
    })),
  ].sort((a, b) => a.url.localeCompare(b.url));
  const problems: string[] = [];
  const hashes = new Set(sources.flatMap((s) => s.indepHash ?? []));
  const machines = new Set(survey.answers.map((a) => a.machine)).size;
  if (survey.faults.length > 0) {
    problems.push(
      `${survey.faults.length} source(s) served a header that does not verify`,
    );
  }
  if (hashes.size > 1) {
    problems.push(`the sources disagree: ${[...hashes].join(' vs ')}`);
  }
  if (machines < minSources) {
    problems.push(
      `${machines} distinct machine(s) answered with a header that recomputes; at least ${minSources} are required`,
    );
  }
  let mismatches: HeaderMismatch[] = [];
  const agreed = hashes.size === 1 ? survey.answers[0]?.value : undefined;
  if (row === undefined) {
    problems.push(`the index holds no block at ${height}`);
  } else if (row.indep_hash === null || row.indep_hash.length === 0) {
    problems.push(`the index's block at ${height} has no indep_hash`);
  }
  if (agreed !== undefined && row !== undefined) {
    mismatches = compareHeaderWithBlock(agreed, row, ids);
    if (mismatches.length > 0) {
      problems.push(
        `the index's block at ${height} differs from the chain's in ${mismatches.map((m) => m.field).join(', ')}`,
      );
    }
  }
  return {
    height,
    ok: problems.length === 0 && agreed !== undefined,
    ...(agreed !== undefined
      ? { indepHash: agreed.indepHash.toString('base64url') }
      : {}),
    sources,
    machines,
    mismatches,
    problems,
  };
}

/**
 * A `fetch` for {@link ArweaveNodePool} whose `json()` keeps long integers
 * exact ({@link quoteLongIntegers}): what anchors and samples fetch with.
 *
 * Redirects are refused (a failed request, so the source is unheard): the
 * pool counts machines by the address of each source's own name, and a
 * redirect would let one machine answer for two.
 */
export const exactJsonFetch = (async (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => {
  const response = await fetch(url, { ...init, redirect: 'error' });
  return {
    status: response.status,
    ok: response.ok,
    json: async () => JSON.parse(quoteLongIntegers(await response.text())),
  };
}) as import('../onchain/arweave-nodes.js').FetchLike;
