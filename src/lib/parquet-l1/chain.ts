/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checks of L1 rows against the chain's own consensus fields, from the rows
 * alone: the rules the judge (`judge.ts`) applies for every reader — the
 * verifier, the importer before it writes, and the exporter before it
 * publishes. On their own they show only that rows agree with each other;
 * an anchor (`anchor.ts`) is what ties them to the chain.
 *
 * - **Block links:** each block's `previous_block` is its predecessor's
 *   `indep_hash`.
 * - **`hash_list_merkle`**, in the form each era uses (Arweave's
 *   `ar_block` and `ar_unbalanced_merkle`): empty below the 1.6 fork
 *   (95,000); at 95,000, the SHA-384 fold of `indep_hash` over heights 0 to
 *   94,998; then `SHA-384(prev ‖ indep_hash[h-1])` to 422,249; at 422,250 a
 *   seed from the 2.0 transition (not rebuildable from stored fields, so not
 *   checked); from 422,251, `SHA-384(prev ‖ deepHash([indep_hash[h-1],
 *   weave_size[h-1], tx_root[h-1]]))`. With the top block anchored — its
 *   header recomputed (`block-hash.ts`) and equal to the row — this binds
 *   every post-2.0 block's hash, weave size and transaction root beneath
 *   it. Below the fork it binds no weave size, and the hashes it links
 *   cannot be recomputed, so pre-2.0 blocks are reported unbound.
 * - **`tx_root`:** recomputed from a block's transactions (format, id, data
 *   size and data root), sorted as Arweave sorts them, with the 2.5 fork's
 *   padding. A block with a format-1 transaction carrying data cannot be
 *   recomputed ({@link computeTxRoot} returns undefined without a supplied
 *   data root): its data root comes from data the index doesn't store, and
 *   the judge reports the block unbound, never as passing.
 *
 * All verified against Arweave mainnet rows (2026-09-30 and 2026-10-02).
 */
import crypto from 'node:crypto';
import {
  buildLayers,
  computeRootHash,
  generateLeaves,
} from 'arweave/node/lib/merkle.js';

import {
  deepHash,
  foldBlockIndexEntry,
  FORK_1_6,
  FORK_2_0,
  FORK_2_5,
} from './block-hash.js';

export { FORK_1_6, FORK_2_0, FORK_2_5, foldBlockIndexEntry };
const CHUNK = 256 * 1024;

/**
 * The 2.0 seed fold — `ar_unbalanced_merkle:block_index_to_merkle_root`
 * over the block-index entries `[indep_hash, weave_size, transition
 * tx_root]` of heights 0 to `h`, genesis first, from empty
 * ({@link foldBlockIndexEntry}) — at fixed heights below the 2.0 fork.
 *
 * The fold at 422,249 is block 422,250's `hash_list_merkle` (the 2.0 seed;
 * `ar_block.erl` at 28df6bd5), so it binds every pre-2.0 block's hash,
 * weave size and transition `tx_root`. A band set that holds block 422,250
 * reaches that binding through the block itself; these pins give it to a
 * band set that does not — any `l1-4` band below the fork, alone — by
 * checking its fold where it crosses one, so a band whose fold reaches a
 * pin is bound to the chain as much as one reaching block 422,250.
 *
 * Computed 2026-10-23 from Arweave's own per-height entries: the 2.0
 * checkpoint it committed (`d43ba2b9^:apps/arweave/priv/fork_2_0_checkpoint`,
 * heights 0 to 399,999, SHA-256 {@link FORK_2_0_CHECKPOINT_SHA256}) and
 * nodes' `GET /block_index/{from}/{to}` (`X-Block-Format: 3`) for 400,000
 * to 422,249. The fold at 422,249 equals block 422,250's
 * `hash_list_merkle` as two gateways served it, so every entry, and every
 * pin below, is the chain's. `fork-2-0-pins.test.ts` recomputes the first
 * four from the checkpoint whenever an Arweave checkout is at hand.
 */
export const FORK_2_0_FOLD_PINS: ReadonlyMap<number, Buffer> = new Map(
  (
    [
      [
        99_999,
        '3uxEfY2W3pKx5lqRvvksHCVczmZy0mtU6vY-aDELGlzgP6JAdLeztd3ib6bk-ddq',
      ],
      [
        199_999,
        'MTYJHNVyj5NO5Vgwm7kPrmE1hMD4lQge_LE9WG3nUmlPRStx39oF5uibHBD4mF3d',
      ],
      [
        299_999,
        '5fyunSDM_5oMnjyt9M0ZB5XKpW5ZjmrvJu7rrC5Yn1nUzfJ1xeN8x8-Y_I_mVB-i',
      ],
      [
        399_999,
        '1s-ckibn5_evNgrs82K8d_J4byo8xc3GKV0rQK4uw_Iwp0Oia-Xstp5yAfXYH7Nk',
      ],
      [
        FORK_2_0 - 1,
        'akSjDrBKPuepJMOhO_S9C-iFp5zn9Glv57HGdN_WPqEToWC0Ukb37Gzs4PDA7oLU',
      ],
    ] as Array<[number, string]>
  ).map(([height, fold]) => [height, Buffer.from(fold, 'base64url')]),
);

/**
 * The fold of Arweave's "2.0 hashes" of the pre-2.0 blocks
 * (`genesis_data/hash_list_1_0`, {@link HASH_LIST_1_0_SHA256}): from empty,
 * `SHA-384(fold ‖ H2(h))` for heights 0 to `h`, where `H2(h)` is the
 * entry for height `h` (at index `422250 - h - 1`), at the same heights as
 * {@link FORK_2_0_FOLD_PINS}.
 *
 * `H2` is `hash20Of10Block`: the 2.0–2.4 `indep_hash` rule applied to the
 * 1.0 header with its transition `tx_root` and sorted transaction ids,
 * covering every header field (`ar_header_sync:download_block`,
 * `ar_node:get_2_0_hash_of_1_0_block`). Arweave checks every pre-2.0
 * header a node syncs against this list, which it ships; it is
 * Arweave's checkpoint, not something the chain's own hashes reach. With
 * these pins, a pre-2.0 band whose blocks' `H2`s fold to them has every
 * header field, and its transaction ids, bound to that checkpoint.
 *
 * Computed 2026-10-23 from `genesis_data/hash_list_1_0` (SHA-256 checked);
 * `fork-2-0-pins.test.ts` recomputes them whenever an Arweave checkout is
 * at hand. Every pre-2.0 block of the published bands but the genesis
 * block recomputed its entry from its own columns; the genesis block does
 * once its empty `reward_addr` is read as `unclaimed`, as the chain has it.
 */
export const FORK_2_0_H2_PINS: ReadonlyMap<number, Buffer> = new Map(
  (
    [
      [
        99_999,
        'tP4Ss_y8j-c6EPNQDFd-STooBLOy4B-dxTmWwdK-wzgQ04RhmVbVWw7fu_Bk2ip-',
      ],
      [
        199_999,
        'iNz57dW3y_JZUB3kvSFLCfLUunVnLM76LJixac82_83jD2kBWQTS7DbljA59ebQU',
      ],
      [
        299_999,
        '4HRV8yVq8rxRfqaS6g6ml6TZFxCBu0Y77V-pLGEqTlJ8WaJ4ZNP3p-wzJUeukUvi',
      ],
      [
        399_999,
        'GuZEzEU_BOTJa44c88OMw8lJvDoFELyzxLY4ljverSJBZVprRd06lDdd8K8UOJDM',
      ],
      [
        FORK_2_0 - 1,
        'Fznt4jqwgcOvFiFxtt05_vT7p9A3aE9FJPalyfkIfjBjOv3vC9Ay8AdbQZuJAH2r',
      ],
    ] as Array<[number, string]>
  ).map(([height, fold]) => [height, Buffer.from(fold, 'base64url')]),
);

/** SHA-256 of `genesis_data/hash_list_1_0`, Arweave's list of the 422,250 pre-2.0 "2.0 hashes". */
export const HASH_LIST_1_0_SHA256 =
  'd161502a13e64fa49bcb2425420bcdcd6a4407e488aca3e14ba254f16418ca6f';

/** One step of the {@link FORK_2_0_H2_PINS} fold. */
export function foldH2(previous: Buffer, h2: Buffer): Buffer {
  return sha384(previous, h2);
}

/** The pinned values a pre-2.0 run is bound by: both folds, at the same heights. */
export interface Fork20Pins {
  /** The 2.0 seed fold ({@link FORK_2_0_FOLD_PINS}). */
  fold: ReadonlyMap<number, Buffer>;
  /** The fold of the blocks' 2.0 hashes ({@link FORK_2_0_H2_PINS}). */
  h2: ReadonlyMap<number, Buffer>;
}

/** Mainnet's pins. A test chain gives its own; nothing else does. */
export const FORK_2_0_PINS: Fork20Pins = {
  fold: FORK_2_0_FOLD_PINS,
  h2: FORK_2_0_H2_PINS,
};

/**
 * SHA-256 of Arweave's 2.0 checkpoint file (`apps/arweave/priv/
 * fork_2_0_checkpoint` at `d43ba2b9^`, git blob b1de1ed6): a JSON list,
 * newest first, of `{tx_root, weave_size, hash}` for heights 399,999 down
 * to 0. The exporter reads transition `tx_root`s from it; what it reads is
 * checked against the band and the pins all the same.
 */
export const FORK_2_0_CHECKPOINT_SHA256 =
  '714be0bc10087e12f16a92124436f886e4d3afce7b8c9c81cba284798db044d4';

/** The heights {@link FORK_2_0_CHECKPOINT_SHA256}'s file covers: 0 to this. */
export const FORK_2_0_CHECKPOINT_TOP = 399_999;

export interface ChainBlock {
  height: number;
  indep_hash: Buffer;
  previous_block: Buffer | null;
  weave_size: bigint | number | string;
  tx_root: Buffer | null;
  hash_list_merkle: Buffer | null;
}

export interface ChainTransaction {
  id: Buffer;
  format: number;
  data_size: bigint | number | string;
  data_root: Buffer | null;
}

export interface ChainFailure {
  height: number;
  check:
    | 'contiguous'
    | 'previous_block'
    | 'hash_list_merkle'
    | 'tx_root'
    /** The block above the band doesn't build on its last. */
    | 'anchor'
    /** A listed transaction is indexed at another height or position. */
    | 'position'
    /** A transaction's id isn't the SHA-256 of its signature. */
    | 'signature';
  detail?: string;
}

export interface ChainReport {
  failures: ChainFailure[];
  /** Blocks whose `hash_list_merkle` was checked. */
  hashListChecked: number;
  /** Blocks whose `hash_list_merkle` couldn't be (the 2.0 seed; the 1.6 seed without heights from 0). */
  hashListSkipped: number;
}

const sha384 = (...parts: Buffer[]) => {
  const hash = crypto.createHash('sha384');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const empty = (value: Buffer | null) => value === null || value.length === 0;

/**
 * A block's `hash_list_merkle` from its predecessor's, for heights past the
 * 1.6 seed other than the 2.0 seed (95,000 and 422,250, which this can't
 * give).
 */
export function nextHashListMerkle(previous: ChainBlock): Buffer {
  const h = previous.height + 1;
  if (h <= FORK_1_6 || h === FORK_2_0) {
    throw new Error(`hash_list_merkle at ${h} is a seed, not a link`);
  }
  if (h < FORK_2_0) {
    return sha384(
      previous.hash_list_merkle ?? Buffer.alloc(0),
      previous.indep_hash,
    );
  }
  return sha384(
    previous.hash_list_merkle ?? Buffer.alloc(0),
    deepHash([
      previous.indep_hash,
      Buffer.from(String(previous.weave_size)),
      previous.tx_root ?? Buffer.alloc(0),
    ]),
  );
}

/**
 * What a block's `hash_list_merkle` must be, given the block below it and
 * the running fold for the 1.6 seed.
 *
 * - `Buffer` — it must equal this.
 * - `null` — it must be empty (every height below the 1.6 fork).
 * - `undefined` — not checkable here: the 1.6 seed without a run that
 *   starts at height 0 to fold, the 2.0 seed (not rebuildable from stored
 *   fields), or no usable block below.
 *
 * Shared by {@link checkBlockChain} and the streaming verifier, so the two
 * cannot drift on the era rules.
 */
/**
 * The block below carries no `hash_list_merkle` where it must have one.
 * Not a seed and not unrebuildable: a defect, and treating it as a skip
 * is how a forged block escapes the chain binding — null out its merkle
 * and the block above it is never compared.
 */
export const PREDECESSOR_HAS_NO_MERKLE = 'predecessor-has-no-merkle';

export function expectedHashListMerkle(
  height: number,
  previous: ChainBlock | undefined,
  seedFold: Buffer | undefined,
): Buffer | null | undefined | typeof PREDECESSOR_HAS_NO_MERKLE {
  if (height < FORK_1_6) return null;
  if (height === FORK_1_6) return seedFold;
  if (height === FORK_2_0) return undefined;
  // Nothing below to build from; the caller has no predecessor at all.
  if (previous === undefined) return undefined;
  // Reaching here means the height is above the 1.6 fork, so a
  // contiguous predecessor is at or above it too and carries a merkle;
  // a block that does not follow the one below it is reported as
  // non-contiguous before this. An empty value is therefore a broken
  // row, never a seed, and skipping it is how a forged block would
  // escape the binding.
  if (empty(previous.hash_list_merkle)) return PREDECESSOR_HAS_NO_MERKLE;
  return nextHashListMerkle(previous);
}

/** The 1.6 seed folds heights 0 to 94,998; this accumulates one block. */
export function foldSeed(
  seedFold: Buffer | undefined,
  block: Pick<ChainBlock, 'height' | 'indep_hash'>,
): Buffer | undefined {
  if (seedFold === undefined || block.height > FORK_1_6 - 2) return seedFold;
  return sha384(seedFold, block.indep_hash);
}

/**
 * Checks block links and `hash_list_merkle` over consecutive blocks, sorted
 * by height. `prior` is the block just below the first, when there is one.
 */
export function checkBlockChain(
  blocks: ChainBlock[],
  prior?: ChainBlock,
): ChainReport {
  const report: ChainReport = {
    failures: [],
    hashListChecked: 0,
    hashListSkipped: 0,
  };
  const fail = (
    height: number,
    check: ChainFailure['check'],
    detail?: string,
  ) =>
    report.failures.push({
      height,
      check,
      ...(detail !== undefined ? { detail } : {}),
    });
  // The 1.6 seed folds every hash from height 0, so only a run that starts
  // there can check it; it is accumulated as the blocks go by.
  let seedFold: Buffer | undefined =
    blocks[0]?.height === 0 ? Buffer.alloc(0) : undefined;

  let previous = prior;
  for (const block of blocks) {
    const h = block.height;
    if (previous !== undefined && h !== previous.height + 1) {
      fail(h, 'contiguous', `follows ${previous.height}`);
      previous = block;
      seedFold = undefined;
      continue;
    }
    if (previous !== undefined) {
      if (
        block.previous_block === null ||
        !block.previous_block.equals(previous.indep_hash)
      ) {
        fail(h, 'previous_block');
      }
    }

    const expected = expectedHashListMerkle(h, previous, seedFold);
    if (expected === PREDECESSOR_HAS_NO_MERKLE) {
      report.hashListChecked += 1;
      fail(
        h,
        'hash_list_merkle',
        `the block below carries no hash_list_merkle`,
      );
    } else if (expected === undefined) {
      report.hashListSkipped += 1;
    } else {
      report.hashListChecked += 1;
      const ok =
        expected === null
          ? empty(block.hash_list_merkle)
          : block.hash_list_merkle !== null &&
            expected.equals(block.hash_list_merkle);
      if (!ok) fail(h, 'hash_list_merkle');
    }

    seedFold = foldSeed(seedFold, block);
    previous = block;
  }
  return report;
}

/**
 * The `data_root` of a format-1 transaction's data, as the chain computes
 * it.
 *
 * **Not** `arweave-js`'s `computeRootHash`. Arweave splits v1 data into
 * fixed {@link CHUNK}-sized pieces with the remainder last and no
 * rebalancing (`ar_tx:chunk_binary`), while `arweave-js`'s `chunkData`
 * rebalances the final two chunks when the last would fall under 32 KB
 * (`MIN_CHUNK_SIZE`). The two agree on data of a single chunk, and on data
 * whose remainder is 32 KB or more; they disagree otherwise, which on
 * mainnet is common enough to have shown up in 9 of 150 sampled blocks.
 *
 * Data that is an exact multiple of {@link CHUNK} ends with a zero-length
 * chunk, which both implementations include in the tree, so that case
 * needs no special handling here.
 */
export async function v1DataRoot(data: Uint8Array): Promise<Buffer> {
  const chunks: Array<{
    dataHash: Uint8Array;
    minByteRange: number;
    maxByteRange: number;
  }> = [];
  let cursor = 0;
  for (;;) {
    const size = Math.min(CHUNK, data.length - cursor);
    const piece = data.subarray(cursor, cursor + size);
    chunks.push({
      dataHash: crypto.createHash('sha256').update(piece).digest(),
      minByteRange: cursor,
      maxByteRange: cursor + size,
    });
    cursor += size;
    // `chunk_binary` recurses while the rest is at least a chunk, so the
    // last piece is the remainder, empty when the data divides exactly.
    if (size < CHUNK) break;
  }
  return Buffer.from((await buildLayers(await generateLeaves(chunks))).id);
}

let emptyRoot: Promise<Buffer> | undefined;

/**
 * Recomputes a block's `tx_root` from its transactions, or returns
 * undefined when the stored fields can't (a format-1 transaction with data).
 */
export async function computeTxRoot(
  height: number,
  txs: ChainTransaction[],
  /**
   * Data roots for format-1 transactions that carry data, keyed by the
   * base64url id. An index does not store these — a v1 transaction's root
   * comes from its data, which only whoever holds the data can derive — so
   * without them a block holding one cannot be checked at all. Supply them
   * and it can. See `index-l1-audit`.
   */
  suppliedDataRoots?: ReadonlyMap<string, Buffer>,
): Promise<Buffer | undefined> {
  if (txs.length === 0) return Buffer.alloc(0);
  const needsData = (tx: ChainTransaction) =>
    tx.format === 1 && BigInt(tx.data_size) > 0n;
  const suppliedFor = (tx: ChainTransaction) =>
    suppliedDataRoots?.get(tx.id.toString('base64url'));
  if (txs.some((tx) => needsData(tx) && suppliedFor(tx) === undefined)) {
    return undefined;
  }
  emptyRoot ??= computeRootHash(new Uint8Array(0)).then((root) =>
    Buffer.from(root),
  );
  const formatOneRoot = await emptyRoot;
  // Arweave sorts #tx records field by field: format, then id.
  const sorted = [...txs].sort(
    (a, b) => a.format - b.format || Buffer.compare(a.id, b.id),
  );
  const leaves: Array<{
    dataHash: Uint8Array;
    minByteRange: number;
    maxByteRange: number;
  }> = [];
  let position = 0;
  for (const tx of sorted) {
    const size = Number(tx.data_size);
    const end = position + size;
    leaves.push({
      // A format-1 transaction's root comes from its data: with none, the
      // root of empty data, not an empty binary.
      dataHash: needsData(tx)
        ? (suppliedFor(tx) as Buffer)
        : tx.format === 1
          ? formatOneRoot
          : (tx.data_root ?? Buffer.alloc(0)),
      minByteRange: 0,
      maxByteRange: end,
    });
    position = end;
    if (height >= FORK_2_5 && size > 0) {
      const padded = Math.ceil(size / CHUNK) * CHUNK;
      if (padded > size) {
        position = end + (padded - size);
        leaves.push({
          dataHash: Buffer.alloc(0),
          minByteRange: 0,
          maxByteRange: position,
        });
      }
    }
  }
  const nodes = await generateLeaves(leaves);
  return Buffer.from((await buildLayers(nodes)).id);
}

/**
 * Checks a block's stored `tx_root` against its transactions. Blocks below
 * the 2.0 fork store none, and are not checked; nor are blocks whose root
 * the stored fields can't rebuild.
 *
 * @returns true when it matches, false when not, undefined when not checked.
 */
export async function checkTxRoot(
  block: Pick<ChainBlock, 'height' | 'tx_root'>,
  txs: ChainTransaction[],
  suppliedDataRoots?: ReadonlyMap<string, Buffer>,
): Promise<boolean | undefined> {
  if (block.height < FORK_2_0) return undefined;
  const root = await computeTxRoot(block.height, txs, suppliedDataRoots);
  if (root === undefined) return undefined;
  if (root.length === 0) return empty(block.tx_root);
  return block.tx_root !== null && root.equals(block.tx_root);
}
