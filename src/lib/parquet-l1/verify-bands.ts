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

import { ChainTransaction, checkTxRoot } from './chain.js';
import { lookupsOf, ParquetL1Band, readBandDirectory } from './layout.js';
import { verifyBandLookups } from './lookups.js';
import { BlockWalker, CheckedBlock } from './verify-steps.js';
import { addFailure, FORK_2_0_HEIGHT, VerifyCheck } from './verify.js';

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
  /** Bands whose lookups were checked, and bands of a layout without lookups. */
  lookupsChecked: number;
  lookupsSkipped: number;
  ok: boolean;
  seconds: number;
}

/** Heights read per query, so one window's rows are not all held at once. */
export const WINDOW = 10_000;

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
    lookups = true,
    window = WINDOW,
  }: {
    from?: number;
    to?: number;
    txRoot?: boolean;
    lookups?: boolean;
    window?: number;
  } = {},
): Promise<BandsVerifyResult> {
  const started = Date.now();
  const foundBands = await readBandDirectory(bandsDir);
  const byId = new Map(foundBands.map((b) => [b.id, b]));
  const { ordered, span } = bandCoverage(foundBands);
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

  const roots: VerifyCheck = { name: 'tx_root', ok: true, detail: '' };
  const walker = new BlockWalker(low, high);
  let rootsChecked = 0;
  let rootsSkipped = 0;

  for (let at = low; at <= high; at += window) {
    const end = Math.min(high, at + window - 1);
    const blocks = await blocksOf(at, end);
    // Grouped as they arrive, so a block's transactions are to hand
    // without a second query per height.
    const byHeight = new Map<number, ChainTransaction[]>();
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
      const block: CheckedBlock = {
        height: Number(raw.height),
        indep_hash: asBuffer(raw.indep_hash),
        previous_block: asBuffer(raw.previous_block),
        block_size: Number(raw.block_size),
        weave_size: Number(raw.weave_size),
        tx_root: asBuffer(raw.tx_root),
        hash_list_merkle: asBuffer(raw.hash_list_merkle),
      };
      const txs = byHeight.get(block.height) ?? [];
      // The same judgement the core.db verifier makes, from the same
      // code: only the reading differs between the two.
      walker.step(
        block,
        txs.reduce((sum, tx) => sum + Number(tx.data_size), 0),
      );

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
    }
  }

  const { checks, totals } = walker.finish();
  // `walker.finish()` already worded the five it owns.
  roots.detail = !txRoot
    ? 'not checked'
    : rootsChecked === 0
      ? 'no block in this range could have its tx_root recomputed'
      : `${rootsChecked} blocks' transaction sets reproduce the tx_root they carry; ${rootsSkipped} hold a format-1 transaction with data, which needs index-l1-audit`;
  if (txRoot) checks.push(roots);

  // Each band's lookups against its own description and its own tables:
  // whole bands, for every band the checked range reaches.
  let lookupsChecked = 0;
  let lookupsSkipped = 0;
  if (lookups) {
    const check: VerifyCheck = { name: 'lookups', ok: true, detail: '' };
    for (const found of ordered) {
      if (found.to < low || found.from > high) continue;
      const band = byId.get(found.id);
      if (band === undefined) continue;
      if (lookupsOf(band.band.schema).length === 0) {
        lookupsSkipped += 1;
        continue;
      }
      lookupsChecked += 1;
      for (const problem of await verifyBandLookups(
        duck,
        band.dir,
        band.band,
      )) {
        addFailure(check, {
          height: found.from,
          found: `${found.id}: ${problem}`,
          expected:
            "lookups derived from the band's own tables, as its band.json describes them",
        });
      }
    }
    check.detail =
      lookupsChecked === 0
        ? 'no band in this range carries lookups'
        : `${lookupsChecked} bands' lookups hold exactly the rows their tables give and their band.json describes` +
          (lookupsSkipped > 0
            ? `; ${lookupsSkipped} bands are of a layout without lookups`
            : '');
    checks.push(check);
  }

  return {
    bandsDir,
    bands: ordered.map((b) => ({
      id: b.id,
      heightRange: [b.from, b.to] as [number, number],
    })),
    heightRange: [low, high],
    blocks: totals.blocks,
    checks,
    txRootChecked: rootsChecked,
    txRootSkipped: rootsSkipped,
    merkleChecked: totals.merkleChecked,
    merkleSkipped: totals.merkleSkipped,
    accountingChecked: totals.accountingChecked,
    accountingSkipped: totals.accountingSkipped,
    lookupsChecked,
    lookupsSkipped,
    ok: checks.every((c) => c.ok),
    seconds: (Date.now() - started) / 1000,
  };
}
