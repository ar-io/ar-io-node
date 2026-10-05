/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Checks of L1 rows against the chain's own consensus fields, from the rows
 * alone: the checks an exporter runs on its own band before publishing, and
 * an importer on a band it is given.
 *
 * - **Block links:** each block's `previous_block` is its predecessor's
 *   `indep_hash`.
 * - **`hash_list_merkle`**, in the form each era uses (Arweave's
 *   `ar_block` and `ar_unbalanced_merkle`): empty below the 1.6 fork
 *   (95,000); at 95,000, the SHA-384 fold of `indep_hash` over heights 0 to
 *   94,998; then `SHA-384(prev ‖ indep_hash[h-1])` to 422,249; at 422,250 a
 *   seed from the 2.0 transition (not rebuildable from stored fields, so not
 *   checked); from 422,251, `SHA-384(prev ‖ deepHash([indep_hash[h-1],
 *   weave_size[h-1], tx_root[h-1]]))`. With the tip anchored, this binds
 *   every block hash, and from the 2.0 fork every block's weave size and
 *   transaction root.
 * - **`tx_root`:** recomputed from a block's transactions (format, id, data
 *   size and data root), sorted as Arweave sorts them, with the 2.5 fork's
 *   padding. A block with a format-1 transaction carrying data is skipped:
 *   its data root comes from data the index doesn't store.
 *
 * All verified against Arweave mainnet rows (2026-09-30 and 2026-10-02).
 */
import crypto from 'node:crypto';
import {
  buildLayers,
  computeRootHash,
  generateLeaves,
} from 'arweave/node/lib/merkle.js';

export const FORK_1_6 = 95_000;
export const FORK_2_0 = 422_250;
export const FORK_2_5 = 812_970;
const CHUNK = 256 * 1024;

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

/** Arweave's deep hash of a list of binaries. */
function deepHash(item: Buffer | Buffer[]): Buffer {
  if (Array.isArray(item)) {
    let acc = sha384(Buffer.from('list'), Buffer.from(String(item.length)));
    for (const part of item) acc = sha384(acc, deepHash(part));
    return acc;
  }
  return sha384(
    sha384(Buffer.from('blob'), Buffer.from(String(item.length))),
    sha384(item),
  );
}

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

let emptyRoot: Promise<Buffer> | undefined;

/**
 * Recomputes a block's `tx_root` from its transactions, or returns
 * undefined when the stored fields can't (a format-1 transaction with data).
 */
export async function computeTxRoot(
  height: number,
  txs: ChainTransaction[],
): Promise<Buffer | undefined> {
  if (txs.length === 0) return Buffer.alloc(0);
  if (txs.some((tx) => tx.format === 1 && BigInt(tx.data_size) > 0n)) {
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
      dataHash:
        tx.format === 1 ? formatOneRoot : (tx.data_root ?? Buffer.alloc(0)),
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
): Promise<boolean | undefined> {
  if (block.height < FORK_2_0) return undefined;
  const root = await computeTxRoot(block.height, txs);
  if (root === undefined) return undefined;
  if (root.length === 0) return empty(block.tx_root);
  return block.tx_root !== null && root.equals(block.tx_root);
}
