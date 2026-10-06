/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Verifying `parquet-l1` bands directly, with no gateway and no `core.db`.
 *
 * `index-l1-verify --core-db` checks a gateway's own imported database,
 * which is the operator's view. This is the consumer's: someone holding a
 * directory of bands — an analyst, an agent, another gateway deciding
 * whether to install them — can establish that they are faithful to the
 * chain before importing anything, or without ever importing at all.
 *
 * That distinction is the point rather than a convenience. An index whose
 * only verifier runs inside the gateway that owns it is an index you have
 * to trust the gateway about; the band format is content-addressed and
 * signed precisely so that it does not have to be.
 *
 * **Every chain rule is shared with the `core.db` verifier.** The eras,
 * the seeds, the padding and the `tx_root` arithmetic all live in
 * `chain.ts`, and this module only drives them over a different reader.
 * The two drivers are held together by a differential test that runs both
 * over the same chain and requires the same verdicts, because a rule
 * reimplemented twice is a rule that drifts.
 */
import type { Database } from 'duckdb-async';

import {
  ChainTransaction,
  checkTxRoot,
  expectedHashListMerkle,
  foldSeed,
  PREDECESSOR_HAS_NO_MERKLE,
} from './chain.js';
import { ParquetL1Band, readBandDirectory } from './layout.js';
import {
  addFailure,
  FORK_2_0_HEIGHT,
  STRICT_DATA_SPLIT_THRESHOLD,
  VerifyCheck,
} from './verify.js';

export class BandsRefused extends Error {}

export interface BandsVerifyResult {
  bandsDir: string;
  bands: Array<{ id: string; heightRange: [number, number] }>;
  heightRange: [number, number];
  blocks: number;
  checks: VerifyCheck[];
  txRootChecked: number;
  txRootSkipped: number;
  merkleChecked: number;
  merkleSkipped: number;
  accountingChecked: number;
  accountingSkipped: number;
  ok: boolean;
  seconds: number;
}

/** Heights read per query, so one window's rows are not all held at once. */
export const WINDOW = 10_000;

interface BlockRow {
  height: number;
  indep_hash: Buffer;
  previous_block: Buffer | null;
  block_size: number;
  weave_size: number;
  tx_root: Buffer | null;
  hash_list_merkle: Buffer | null;
}

const asBuffer = (value: unknown): Buffer | null =>
  value === null || value === undefined
    ? null
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);

/**
 * The bands to read, lowest first, refusing a set that is not one
 * contiguous run of heights.
 *
 * A consumer holding an overlapping or gapped set has a different
 * problem from a consumer holding a faithful one, and saying so is more
 * use than silently verifying whatever happens to line up.
 */
export function bandCoverage(
  bands: ReadonlyArray<{ id: string; band: ParquetL1Band }>,
): {
  ordered: Array<{ id: string; from: number; to: number }>;
  span: [number, number];
} {
  if (bands.length === 0) {
    throw new BandsRefused('no readable band in this directory');
  }
  const ordered = bands
    .map(({ id, band }) => ({
      id,
      from: band.heightRange[0],
      to: band.heightRange[1],
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const next = ordered[i];
    if (next.from === previous.to + 1) continue;
    throw new BandsRefused(
      next.from <= previous.to
        ? `bands ${previous.id} and ${next.id} overlap at height ${next.from}`
        : `nothing covers height ${previous.to + 1}: ${previous.id} ends there and ${next.id} starts at ${next.from}`,
    );
  }
  return {
    ordered,
    span: [ordered[0].from, ordered[ordered.length - 1].to],
  };
}

/**
 * Checks a directory of bands against the chain's own rules.
 *
 * Reads the Parquet in height windows, so a 12.8 GB set never has to fit
 * in memory, and drives the same `chain.ts` rules the `core.db` verifier
 * does.
 */
export async function verifyBands(
  duck: Database,
  bandsDir: string,
  {
    from,
    to,
    txRoot = true,
    window = WINDOW,
  }: { from?: number; to?: number; txRoot?: boolean; window?: number } = {},
): Promise<BandsVerifyResult> {
  const started = Date.now();
  const found = await readBandDirectory(bandsDir);
  const { ordered, span } = bandCoverage(found);
  const low = Math.max(from ?? span[0], span[0]);
  const high = Math.min(to ?? span[1], span[1]);
  if (high <= low) {
    throw new BandsRefused(
      `nothing to check between ${low} and ${high}: this compares each block with the one below it`,
    );
  }

  const glob = `${bandsDir.replace(/'/g, "''")}/*`;
  const blocksOf = async (lo: number, hi: number) =>
    (await duck.all(
      `SELECT height, indep_hash, previous_block, block_size,
              CAST(weave_size AS VARCHAR) AS weave_size, tx_root, hash_list_merkle
       FROM read_parquet('${glob}/blocks.parquet')
       WHERE height BETWEEN ${lo} AND ${hi} ORDER BY height`,
    )) as Array<Record<string, unknown>>;
  const txsOf = async (lo: number, hi: number) =>
    (await duck.all(
      `SELECT height, id, format, CAST(data_size AS VARCHAR) AS data_size, data_root
       FROM read_parquet('${glob}/transactions.parquet')
       WHERE height BETWEEN ${lo} AND ${hi}
       ORDER BY height, block_transaction_index`,
    )) as Array<Record<string, unknown>>;

  const contiguous: VerifyCheck = {
    name: 'contiguous',
    ok: true,
    detail: 'every height the bands cover is present, exactly once',
  };
  const linked: VerifyCheck = {
    name: 'linked',
    ok: true,
    detail: "each block's previous_block is the hash of the block below it",
  };
  const merkle: VerifyCheck = {
    name: 'hash_list_merkle',
    ok: true,
    detail: '',
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
  const roots: VerifyCheck = { name: 'tx_root', ok: true, detail: '' };

  let previous: BlockRow | undefined;
  let seen = 0;
  let merkleChecked = 0;
  let merkleSkipped = 0;
  let accChecked = 0;
  let accSkipped = 0;
  let rootsChecked = 0;
  let rootsSkipped = 0;
  let seedFold: Buffer | undefined = low === 0 ? Buffer.alloc(0) : undefined;

  for (let at = low; at <= high; at += window) {
    const end = Math.min(high, at + window - 1);
    const blocks = await blocksOf(at, end);
    // Grouped as they arrive, so a block's transactions are to hand
    // without a second query per height.
    const byHeight = new Map<number, ChainTransaction[]>();
    // Always read: the weave accounting needs the sizes even when
    // `tx_root` is not being recomputed.
    for (const row of await txsOf(at, end)) {
      const height = Number(row.height);
      const list = byHeight.get(height) ?? [];
      list.push({
        id: asBuffer(row.id) as Buffer,
        format: Number(row.format),
        data_size: String(row.data_size ?? '0'),
        data_root: asBuffer(row.data_root),
      });
      byHeight.set(height, list);
    }

    for (const raw of blocks) {
      const block: BlockRow = {
        height: Number(raw.height),
        indep_hash: asBuffer(raw.indep_hash) as Buffer,
        previous_block: asBuffer(raw.previous_block),
        block_size: Number(raw.block_size),
        weave_size: Number(raw.weave_size),
        tx_root: asBuffer(raw.tx_root),
        hash_list_merkle: asBuffer(raw.hash_list_merkle),
      };
      seen += 1;
      const txs = byHeight.get(block.height) ?? [];

      if (previous === undefined) {
        if (block.height !== low) {
          addFailure(contiguous, {
            height: low,
            found: `the range starts at ${block.height}`,
            expected: `${low}`,
          });
        }
      } else if (block.height !== previous.height + 1) {
        addFailure(contiguous, {
          height: previous.height + 1,
          found: `the next block is ${block.height}`,
          expected: `${previous.height + 1}`,
        });
        previous = block;
        seedFold = foldSeed(seedFold, block);
        continue;
      } else {
        if (
          block.previous_block === null ||
          !block.previous_block.equals(previous.indep_hash)
        ) {
          addFailure(linked, {
            height: block.height,
            found: block.previous_block?.toString('base64url') ?? 'null',
            expected: previous.indep_hash.toString('base64url'),
          });
        }
        const want = expectedHashListMerkle(block.height, previous, seedFold);
        if (want === PREDECESSOR_HAS_NO_MERKLE) {
          merkleChecked += 1;
          addFailure(merkle, {
            height: block.height,
            found: 'the block below carries no hash_list_merkle',
            expected: 'every block above the 1.6 fork has one',
          });
        } else if (want === undefined) {
          merkleSkipped += 1;
        } else {
          merkleChecked += 1;
          const got = block.hash_list_merkle;
          const ok =
            want === null
              ? got === null || got.length === 0
              : got !== null && want.equals(got);
          if (!ok) {
            addFailure(merkle, {
              height: block.height,
              found: got === null ? 'null' : got.toString('base64url'),
              expected: want === null ? 'empty' : want.toString('base64url'),
            });
          }
        }
        const grew = block.weave_size - previous.weave_size;
        if (grew !== block.block_size) {
          addFailure(sizes, {
            height: block.height,
            found: `block_size ${block.block_size}`,
            expected: `weave grew by ${grew}`,
          });
        }
        if (block.weave_size <= STRICT_DATA_SPLIT_THRESHOLD) {
          accChecked += 1;
          const total = txs.reduce((sum, tx) => sum + Number(tx.data_size), 0);
          if (grew !== total) {
            addFailure(accounting, {
              height: block.height,
              found: `transactions total ${total}`,
              expected: `weave grew by ${grew}`,
            });
          }
        } else {
          accSkipped += 1;
        }
      }

      if (txRoot && block.height >= FORK_2_0_HEIGHT) {
        const ok = await checkTxRoot(
          { height: block.height, tx_root: block.tx_root },
          txs,
        );
        if (ok === undefined) {
          rootsSkipped += 1;
        } else {
          rootsChecked += 1;
          if (!ok) {
            addFailure(roots, {
              height: block.height,
              found: `${txs.length} transactions that do not reproduce it`,
              expected: block.tx_root?.toString('base64url') ?? 'empty',
            });
          }
        }
      }

      seedFold = foldSeed(seedFold, block);
      previous = block;
    }
  }

  const expected = high - low + 1;
  if (seen !== expected) {
    addFailure(contiguous, {
      height: high,
      found: `${seen} blocks`,
      expected: `${expected}`,
    });
  }

  merkle.detail =
    merkleChecked === 0
      ? 'no block in this range has a rebuildable hash_list_merkle'
      : `${merkleChecked} blocks commit to every block hash below them; ${merkleSkipped} are seeds or below the 1.6 fork`;
  accounting.detail =
    accSkipped === 0
      ? "each block grew the weave by exactly its transactions' data_size"
      : `${accChecked} blocks grew the weave by exactly their transactions' data_size; ${accSkipped} are past the padding threshold, where that no longer holds`;
  roots.detail = !txRoot
    ? 'not checked'
    : rootsChecked === 0
      ? 'no block in this range could have its tx_root recomputed'
      : `${rootsChecked} blocks' transaction sets reproduce the tx_root they carry; ${rootsSkipped} hold a format-1 transaction with data, which needs index-l1-audit`;

  const checks = [contiguous, linked, merkle, sizes, accounting];
  if (txRoot) checks.push(roots);
  return {
    bandsDir,
    bands: ordered.map((b) => ({
      id: b.id,
      heightRange: [b.from, b.to] as [number, number],
    })),
    heightRange: [low, high],
    blocks: seen,
    checks,
    txRootChecked: rootsChecked,
    txRootSkipped: rootsSkipped,
    merkleChecked,
    merkleSkipped,
    accountingChecked: accChecked,
    accountingSkipped: accSkipped,
    ok: checks.every((c) => c.ok),
    seconds: (Date.now() - started) / 1000,
  };
}
