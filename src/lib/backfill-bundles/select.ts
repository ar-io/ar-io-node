/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Which L1 bundles `backfill-bundles` queues: those the gateway once skipped
 * and never fully indexed, that its unbundle filter matches now.
 *
 * Read-only on core.db (heights, sizes, tags) and bundles.db (bundle state).
 * State lives in bundles.db, so a rerun of the same range resumes: a bundle
 * that has been fully indexed since is no longer selected.
 */
import * as crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { toB64Url } from '../encoding.js';
import type { ItemFilter, MatchableTxLike } from '../../types.js';

/** Heights per bucket: one is queued whole before the next starts. */
export const BUCKET_BLOCKS = 10_000;

const sha1 = (value: string) =>
  crypto.createHash('sha1').update(value).digest();

/** core.db's tag hashes for `Bundle-Format: binary`, the L1 bundle marker. */
export const BUNDLE_FORMAT_NAME_HASH = sha1('Bundle-Format');
export const BUNDLE_FORMAT_BINARY_HASH = sha1('binary');

/** Why a bundle in the range is or isn't queued. */
export type BackfillVerdict =
  | 'selected'
  /** Fully indexed already. */
  | 'indexed'
  /** No `bundles` row: never seen by this gateway's bundle pipeline. */
  | 'unrecorded'
  /** Never skipped: queued live, so the repair worker owns it. */
  | 'not-skipped'
  /** The unbundle filter does not match it. */
  | 'filtered-out'
  /** Failed `maxRetries` times; not queued again. */
  | 'retries-exhausted'
  /** Queued again since it was skipped, within the cooldown. */
  | 'recently-queued';

export interface BackfillCandidate {
  id: string;
  height: number;
  dataSize: number;
  /** Its `Bundler-App-Name` tag, if any, for the dry-run breakdown. */
  bundlerAppName: string | undefined;
  verdict: BackfillVerdict;
}

export interface BundleState {
  last_queued_at: number | null;
  last_skipped_at: number | null;
  last_fully_indexed_at: number | null;
  retry_attempt_count: number | null;
}

/** Decides one bundle from its `bundles` row; the filter is applied after. */
export function judgeBundleState(
  state: BundleState | undefined,
  {
    maxRetries,
    cooldownSeconds,
    nowSeconds,
  }: { maxRetries: number; cooldownSeconds: number; nowSeconds: number },
): BackfillVerdict | undefined {
  if (state === undefined) return 'unrecorded';
  if (state.last_fully_indexed_at !== null) return 'indexed';
  if (state.last_skipped_at === null) return 'not-skipped';
  if ((state.retry_attempt_count ?? 0) >= maxRetries) {
    return 'retries-exhausted';
  }
  if (
    state.last_queued_at !== null &&
    state.last_queued_at > state.last_skipped_at &&
    state.last_queued_at > nowSeconds - cooldownSeconds
  ) {
    return 'recently-queued';
  }
  return undefined;
}

export interface SelectOptions {
  core: Database;
  bundles: Database;
  filter: ItemFilter;
  /** First and last height of the bucket, inclusive. */
  from: number;
  to: number;
  maxRetries: number;
  cooldownSeconds: number;
  nowSeconds: number;
}

/**
 * Every L1 bundle (stable, tagged `Bundle-Format: binary`) in `from`..`to`,
 * in height order, each with its verdict. The filter sees the transaction
 * as the gateway's own import does: base64url id, tags, owner address and
 * target, and its height.
 */
export function selectBucket(options: SelectOptions): BackfillCandidate[] {
  const { core, bundles, filter } = options;
  const txs = core
    .prepare(
      `SELECT st.id, st.height, st.data_size, st.owner_address, st.target,
              st.quantity
       FROM stable_transaction_tags stt
       JOIN stable_transactions st ON st.id = stt.transaction_id
       WHERE stt.tag_name_hash = @name AND stt.tag_value_hash = @value
         AND stt.height BETWEEN @from AND @to
       ORDER BY stt.height, stt.block_transaction_index`,
    )
    .all({
      name: BUNDLE_FORMAT_NAME_HASH,
      value: BUNDLE_FORMAT_BINARY_HASH,
      from: options.from,
      to: options.to,
    }) as {
    id: Buffer;
    height: number;
    data_size: number | null;
    owner_address: Buffer;
    target: Buffer | null;
    quantity: string | null;
  }[];
  const tagsOf = core.prepare(
    `SELECT tn.name, tv.value
     FROM stable_transaction_tags stt
     JOIN tag_names tn ON tn.hash = stt.tag_name_hash
     JOIN tag_values tv ON tv.hash = stt.tag_value_hash
     WHERE stt.transaction_id = ?
     ORDER BY stt.transaction_tag_index`,
  );
  const stateOf = bundles.prepare(
    `SELECT last_queued_at, last_skipped_at, last_fully_indexed_at,
            retry_attempt_count
     FROM bundles WHERE id = ?`,
  );

  const out: BackfillCandidate[] = [];
  // The join returns a transaction once per matching tag row, so one tagged
  // `Bundle-Format: binary` twice would be counted twice. Rows of one
  // transaction are adjacent (ordered by height and position).
  let previousId: Buffer | undefined;
  for (const tx of txs) {
    if (previousId !== undefined && previousId.equals(tx.id)) continue;
    previousId = tx.id;
    const tags = tagsOf.all(tx.id) as { name: Buffer; value: Buffer }[];
    const appTag = tags.find((t) => t.name.toString() === 'Bundler-App-Name');
    let verdict = judgeBundleState(
      stateOf.get(tx.id) as BundleState | undefined,
      options,
    );
    if (verdict === undefined) {
      const item: MatchableTxLike = {
        id: toB64Url(tx.id),
        height: tx.height,
        owner_address: toB64Url(tx.owner_address),
        target: tx.target !== null ? toB64Url(tx.target) : '',
        quantity: tx.quantity ?? '0',
        tags: tags.map((t) => ({
          name: toB64Url(t.name),
          value: toB64Url(t.value),
        })),
      };
      verdict = filter.match(item) ? 'selected' : 'filtered-out';
    }
    out.push({
      id: toB64Url(tx.id),
      height: tx.height,
      dataSize: tx.data_size ?? 0,
      bundlerAppName: appTag?.value.toString(),
      verdict,
    });
  }
  return out;
}

/** The buckets covering `from`..`to`, aligned to {@link BUCKET_BLOCKS}. */
export function buckets(
  from: number,
  to: number,
  size = BUCKET_BLOCKS,
): [number, number][] {
  const out: [number, number][] = [];
  for (let start = Math.floor(from / size) * size; start <= to; start += size) {
    out.push([Math.max(start, from), Math.min(start + size - 1, to)]);
  }
  return out;
}
