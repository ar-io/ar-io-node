/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * An `l1-4` band's witnesses ({@link PARQUET_L1_WITNESSES}): checking the
 * files a band carries, and building them for a band.
 *
 * **Checking** ({@link checkBandWitnesses}) is the band-level half: every
 * row inside the band, well formed, once, in its order, as `band.json`
 * describes, and every v1 root for a format-1 transaction with data that
 * the band holds at that height. The judge (`judge.ts`) does the rest with
 * what is left: recomputes `tx_root` with the roots, and the 2.0 seed fold
 * with the transition roots, against the chain's own values. Nothing here
 * is trusted because a publisher wrote it.
 *
 * **Building** ({@link buildBandWitnesses}) is the exporter's: it takes v1
 * roots and transition `tx_root`s from wherever an operator has them — a
 * directory, Arweave nodes — and keeps only what the chain confirms. A v1
 * root is kept when its block's `tx_root` recomputes with it (and, below
 * the 2.0 fork, the transition root it gives is the one the fold carries);
 * the fold must reach every pinned value the band crosses and, when the
 * band holds it, block 422,250's `hash_list_merkle`. Anything else refuses
 * the band's witnesses, so a band is never published with a witness its
 * consumers would fail.
 */
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import {
  computeTxRoot,
  foldBlockIndexEntry,
  FORK_2_0,
  foldH2,
  FORK_2_0_PINS,
  type Fork20Pins,
  FORK_2_5,
} from './chain.js';
import {
  FORK_2_0_WITNESS,
  ParquetL1Band,
  V1_DATA_ROOTS_WITNESS,
  WitnessSpec,
  witnessesOf,
} from './layout.js';
import { hash20Of10Block } from './block-hash.js';
import { digestBandTable } from './read.js';

const CHUNK = 256 * 1024;

const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;

const asBuffer = (value: unknown): Buffer | null =>
  value === null || value === undefined
    ? null
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);

const b64 = (value: Buffer | null) =>
  value === null ? 'null' : value.toString('base64url');

/** A witness problem: the height it is at, and what is wrong. */
export interface WitnessProblem {
  height: number;
  found: string;
  expected: string;
}

/**
 * Checks the witness files a band of `l1-4` carries, as files: digests and
 * order as `band.json` describes, every row inside the band, well formed,
 * and every v1 root for a format-1 transaction with data at its height.
 * What the rows say about the chain is the judge's to check.
 *
 * @returns what is wrong; empty when every witness file is as it must be.
 */
export async function checkBandWitnesses(
  duck: Database,
  dir: string,
  band: Pick<ParquetL1Band, 'schema' | 'heightRange' | 'witnesses'>,
): Promise<WitnessProblem[]> {
  const problems: WitnessProblem[] = [];
  const [from, to] = band.heightRange;
  const declared = witnessesOf(band.schema, band.heightRange);
  const file = (spec: WitnessSpec) => sql(path.join(dir, spec.file));
  const count = async (query: string) => {
    const [row] = (await duck.all(query)) as Array<{ n: number | bigint }>;
    return Number(row.n);
  };
  for (const spec of declared) {
    const described = band.witnesses?.[spec.name];
    try {
      const digest = await digestBandTable(duck, dir, spec);
      if (
        described === undefined ||
        digest.rows !== described.rows ||
        digest.rowDigest !== described.rowDigest
      ) {
        problems.push({
          height: from,
          found: `${spec.file}: ${digest.rows} rows with digest ${digest.rowDigest}`,
          expected:
            described === undefined
              ? 'a witness band.json describes'
              : `${described.rows} rows with digest ${described.rowDigest}, as band.json says`,
        });
      }
    } catch (error) {
      problems.push({
        height: from,
        found: `${spec.file}: ${(error as Error).message.split('\n')[0]}`,
        expected: `rows strictly in the witness's order (${spec.orderBy.join(', ')})`,
      });
    }
  }
  if (declared.includes(V1_DATA_ROOTS_WITNESS)) {
    const v1 = file(V1_DATA_ROOTS_WITNESS);
    const malformed = await count(
      `SELECT COUNT(*) AS n FROM read_parquet(${v1})
       WHERE height IS NULL OR height < ${from} OR height > ${to}
          OR id IS NULL OR octet_length(id) <> 32
          OR data_root IS NULL OR octet_length(data_root) <> 32`,
    );
    if (malformed > 0) {
      problems.push({
        height: from,
        found: `${V1_DATA_ROOTS_WITNESS.file}: ${malformed} rows outside heights ${from}-${to}, or with an id or data_root that is not 32 bytes`,
        expected: 'every row inside the band, its id and data_root 32 bytes',
      });
    }
    // Only a transaction whose tx_root leaf is its data's root has one: a
    // row for any other is not a witness of anything.
    const txs = sql(path.join(dir, 'transactions.parquet'));
    const stray = (await duck.all(
      `SELECT w.height, w.id FROM read_parquet(${v1}) w
       WHERE NOT EXISTS (
         SELECT 1 FROM read_parquet(${txs}) t
         WHERE t.height = w.height AND t.id = w.id
           AND t.format = 1 AND t.data_size > 0)
       ORDER BY w.height, w.id LIMIT 3`,
    )) as Array<{ height: number | bigint; id: unknown }>;
    if (stray.length > 0) {
      const n = await count(
        `SELECT COUNT(*) AS n FROM read_parquet(${v1}) w
         WHERE NOT EXISTS (
           SELECT 1 FROM read_parquet(${txs}) t
           WHERE t.height = w.height AND t.id = w.id
             AND t.format = 1 AND t.data_size > 0)`,
      );
      problems.push({
        height: Number(stray[0].height),
        found: `${V1_DATA_ROOTS_WITNESS.file}: ${n} rows for no format-1 transaction with data at their height (first: ${stray.map((r) => `${b64(asBuffer(r.id))} at ${Number(r.height)}`).join(', ')})`,
        expected:
          'a v1 data root only for a format-1 transaction with data_size > 0, at its height',
      });
    }
  }
  if (declared.includes(V1_DATA_ROOTS_WITNESS)) {
    // Every format-1 transaction with data has its root: a band with one
    // left out would leave its block for an --allow flag to accept.
    const txs = sql(path.join(dir, 'transactions.parquet'));
    const lacking = await count(
      `SELECT COUNT(*) AS n FROM read_parquet(${txs}) t
       WHERE t.format = 1 AND t.data_size > 0 AND NOT EXISTS (
         SELECT 1 FROM read_parquet(${file(V1_DATA_ROOTS_WITNESS)}) w
         WHERE w.height = t.height AND w.id = t.id)`,
    );
    if (lacking > 0) {
      problems.push({
        height: from,
        found: `${V1_DATA_ROOTS_WITNESS.file}: no row for ${lacking} format-1 transactions with data`,
        expected:
          'a v1 data root for every format-1 transaction with data in the band',
      });
    }
  }
  if (declared.includes(FORK_2_0_WITNESS)) {
    const top = Math.min(to, FORK_2_0 - 1);
    const rows = await count(
      `SELECT COUNT(DISTINCT height) AS n FROM read_parquet(${file(FORK_2_0_WITNESS)})
       WHERE height BETWEEN ${from} AND ${top}`,
    );
    if (rows !== top - from + 1) {
      problems.push({
        height: from,
        found: `${FORK_2_0_WITNESS.file}: rows for ${rows} of the ${top - from + 1} heights below the 2.0 fork`,
        expected: 'one row for every height of the band below the 2.0 fork',
      });
    }
    const malformed = await count(
      `SELECT COUNT(*) AS n FROM read_parquet(${file(FORK_2_0_WITNESS)})
       WHERE height IS NULL OR height < ${from} OR height > ${top}
          OR tx_root IS NULL OR octet_length(tx_root) NOT IN (0, 32)
          OR fold IS NULL OR octet_length(fold) <> 48
          OR h2 IS NULL OR octet_length(h2) <> 48`,
    );
    if (malformed > 0) {
      problems.push({
        height: from,
        found: `${FORK_2_0_WITNESS.file}: ${malformed} rows outside heights ${from}-${top}, or with a tx_root not empty or 32 bytes, or a fold or h2 not 48 bytes`,
        expected: `one row per height below the 2.0 fork, a tx_root of 0 or 32 bytes, a 48-byte fold and a 48-byte h2`,
      });
    }
  }
  return problems;
}

/** One v1 data root a band needs: its transaction, and where its data ends in the weave. */
export interface V1Need {
  height: number;
  id: Buffer;
  size: bigint;
  /**
   * The weave offset of its data's last byte: what `GET /chunk/{offset}`
   * takes. Undefined where its data is not in the weave (the genesis
   * block's: the weave never counted them).
   */
  endOffset?: bigint;
}

/** A pre-2.0 block-index entry from outside the band: `GET /block_index` or Arweave's checkpoint. */
export interface BlockIndexEntryIn {
  hash: Buffer;
  weaveSize: bigint;
  txRoot: Buffer;
}

/**
 * Where a band's witnesses come from. Nothing either gives is trusted: a
 * root or a transition `tx_root` is kept only where the chain confirms it.
 */
export interface WitnessInputs {
  /** The v1 data roots it has for these transactions, by base64url id. */
  v1Roots(needs: V1Need[]): Promise<Map<string, Buffer>>;
  /**
   * The v1 data roots of these transactions computed from their data
   * (`v1DataRoot`): asked for a block whose roots from {@link v1Roots}
   * do not reproduce its `tx_root`.
   */
  v1RootsFromData?(needs: V1Need[]): Promise<Map<string, Buffer>>;
  /** The block-index entries it has for heights `from` to `to` (below the 2.0 fork), by height. */
  blockIndex?(
    from: number,
    to: number,
  ): Promise<Map<number, BlockIndexEntryIn>>;
  /**
   * Arweave's `genesis_data/hash_list_1_0`, indexed by height (entry
   * `422250 - h - 1` is height `h`), when it has it: each block's 2.0 hash
   * is then checked at its height, as well as through the pinned fold.
   */
  hashList10?(): Promise<Buffer[] | undefined>;
}

/** A band's witnesses, built and checked against the chain, in files. */
export interface BuiltWitnesses {
  /** Descriptions for `band.json`. */
  witnesses: Record<string, { rows: number; rowDigest: string }>;
  /** Format-1 transactions with data left without a root (no input had one). */
  missing: number;
  /** Blocks whose v1 roots were confirmed by their `tx_root`. */
  confirmed: number;
}

/**
 * Why a band's witnesses were not built; nothing is kept. `unavailable`:
 * the inputs lack what the band needs (try again with more). `contradicts`:
 * an input or the band disagrees with the chain or with each other.
 */
export class WitnessRefused extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'contradicts' = 'contradicts',
  ) {
    super(message);
  }
}

/** Heights read from the band per query. */
const BUILD_WINDOW = 5_000;

/**
 * Builds a band's witness files into `outDir` from `inputs`, keeping only
 * what the chain confirms (see the module comment).
 *
 * @throws WitnessRefused when the inputs contradict the band or the chain,
 *   when a fold below the 2.0 fork cannot be completed or does not reach
 *   the chain's, or when any v1 root is missing: an `l1-4` band holds
 *   every one, or is not given witnesses.
 */
export async function buildBandWitnesses(
  duck: Database,
  bandDir: string,
  band: Pick<ParquetL1Band, 'heightRange'>,
  outDir: string,
  inputs: WitnessInputs,
  {
    foldPins = FORK_2_0_PINS,
  }: {
    /** The chain's folds; a test chain gives its own. */
    foldPins?: Fork20Pins;
  } = {},
): Promise<BuiltWitnesses> {
  const [from, to] = band.heightRange;
  const specs = witnessesOf('l1-4', band.heightRange);
  const pre20Top = Math.min(to, FORK_2_0 - 1);
  const hasPre20 = from < FORK_2_0;
  let fold: Buffer | undefined;
  let h2Fold: Buffer | undefined;
  if (hasPre20) {
    fold = from === 0 ? Buffer.alloc(0) : foldPins.fold.get(from - 1);
    h2Fold = from === 0 ? Buffer.alloc(0) : foldPins.h2.get(from - 1);
    if (fold === undefined || h2Fold === undefined) {
      throw new WitnessRefused(
        `no pinned 2.0 seed fold at ${from - 1}, below the band, to start its fold from`,
        'unavailable',
      );
    }
    if (!foldPins.fold.has(pre20Top) || !foldPins.h2.has(pre20Top)) {
      throw new WitnessRefused(
        `the band's fold through ${pre20Top} would reach no pinned value, so nothing could confirm it`,
        'unavailable',
      );
    }
  }
  const external =
    hasPre20 && inputs.blockIndex !== undefined
      ? await inputs.blockIndex(from, pre20Top)
      : new Map<number, BlockIndexEntryIn>();
  // Arweave's own list of the 2.0 hashes, when given: each block's is then
  // checked where it is, not only through the pinned fold.
  const hashList10 =
    hasPre20 && inputs.hashList10 !== undefined
      ? await inputs.hashList10()
      : undefined;

  const v1Csv = path.join(outDir, `${V1_DATA_ROOTS_WITNESS.name}.csv`);
  const forkCsv = path.join(outDir, `${FORK_2_0_WITNESS.name}.csv`);
  const v1Out = createWriteStream(v1Csv);
  const forkOut = hasPre20 ? createWriteStream(forkCsv) : undefined;
  const line = async (
    stream: ReturnType<typeof createWriteStream>,
    text: string,
  ) => {
    if (!stream.write(`${text}\n`)) await once(stream, 'drain');
  };
  let missing = 0;
  let confirmed = 0;
  const blocksFile = sql(path.join(bandDir, 'blocks.parquet'));
  const txsFile = sql(path.join(bandDir, 'transactions.parquet'));
  try {
    for (let lo = from; lo <= to; lo += BUILD_WINDOW) {
      const hi = Math.min(to, lo + BUILD_WINDOW - 1);
      const blocks = (await duck.all(
        `SELECT height, indep_hash, CAST(weave_size AS VARCHAR) AS weave_size,
                CAST(block_size AS VARCHAR) AS block_size, tx_root, hash_list_merkle,
                previous_block, nonce, hash, CAST(block_timestamp AS VARCHAR) AS block_timestamp,
                CAST(last_retarget AS VARCHAR) AS last_retarget, diff, cumulative_diff,
                reward_addr, reward_pool, wallet_list
         FROM read_parquet(${blocksFile}) WHERE height BETWEEN ${lo} AND ${hi}
         ORDER BY height`,
      )) as Array<Record<string, unknown>>;
      // Each pre-2.0 block's transaction ids, for its 2.0 hash.
      const idsAt = new Map<number, Buffer[]>();
      if (lo < FORK_2_0) {
        for (const r of (await duck.all(
          `SELECT height, transaction_id FROM read_parquet(${sql(path.join(bandDir, 'block_transactions.parquet'))})
           WHERE height BETWEEN ${lo} AND ${Math.min(hi, FORK_2_0 - 1)}`,
        )) as Array<Record<string, unknown>>) {
          const h = Number(r.height);
          const list = idsAt.get(h) ?? [];
          list.push(asBuffer(r.transaction_id) ?? Buffer.alloc(0));
          idsAt.set(h, list);
        }
      }
      // Every transaction below the 2.0 fork (each block's transition root
      // needs them all); above it, only blocks holding a format-1
      // transaction with data, the only ones a v1 root changes.
      const txRows = (await duck.all(
        `SELECT height, id, format, CAST(data_size AS VARCHAR) AS data_size, data_root
         FROM read_parquet(${txsFile})
         WHERE height BETWEEN ${lo} AND ${hi}
           AND (height < ${FORK_2_0} OR height IN (
             SELECT height FROM read_parquet(${txsFile})
             WHERE height BETWEEN ${lo} AND ${hi} AND format = 1 AND data_size > 0))
         ORDER BY height, block_transaction_index`,
      )) as Array<Record<string, unknown>>;
      const txsAt = new Map<
        number,
        Array<{
          id: Buffer;
          format: number;
          data_size: bigint;
          data_root: Buffer | null;
        }>
      >();
      for (const r of txRows) {
        const h = Number(r.height);
        const list = txsAt.get(h) ?? [];
        list.push({
          id: asBuffer(r.id) ?? Buffer.alloc(0),
          format: Number(r.format),
          data_size: BigInt(String(r.data_size)),
          data_root: asBuffer(r.data_root),
        });
        txsAt.set(h, list);
      }
      if (blocks.length !== hi - lo + 1) {
        throw new WitnessRefused(
          `the band holds ${blocks.length} blocks at heights ${lo}-${hi}`,
        );
      }
      // Where each format-1 transaction's data ends in the weave: the
      // weave below the block, then the block's transactions in tx_root
      // order (format, then id), padded to a chunk from the 2.5 fork.
      const needs: V1Need[] = [];
      for (const block of blocks) {
        const h = Number(block.height);
        const sorted = [...(txsAt.get(h) ?? [])].sort(
          (a, b) => a.format - b.format || Buffer.compare(a.id, b.id),
        );
        let position =
          BigInt(String(block.weave_size)) - BigInt(String(block.block_size));
        for (const tx of sorted) {
          const end = position + tx.data_size;
          if (tx.format === 1 && tx.data_size > 0n) {
            // The genesis block's transactions were never added to the
            // weave (its weave size is 0): their data has no offset.
            needs.push({
              height: h,
              id: tx.id,
              size: tx.data_size,
              ...(h > 0 ? { endOffset: end } : {}),
            });
          }
          position =
            h >= FORK_2_5 && tx.data_size > 0n
              ? position +
                ((tx.data_size + BigInt(CHUNK) - 1n) / BigInt(CHUNK)) *
                  BigInt(CHUNK)
              : end;
        }
      }
      const roots =
        needs.length > 0
          ? await inputs.v1Roots(needs)
          : new Map<string, Buffer>();
      // Data the weave never held has no chunk to prove a root: only the
      // data itself gives one.
      const unplaced = needs.filter((need) => need.endOffset === undefined);
      if (unplaced.length > 0 && inputs.v1RootsFromData !== undefined) {
        for (const [id, root] of await inputs.v1RootsFromData(unplaced)) {
          roots.set(id, root);
        }
      }
      for (const block of blocks) {
        const h = Number(block.height);
        const txs = txsAt.get(h) ?? [];
        const own = txs.filter((tx) => tx.format === 1 && tx.data_size > 0n);
        // Above the fork only blocks with format-1 data were read whole.
        if (h >= FORK_2_0 && own.length === 0) {
          if (h === FORK_2_0 && fold !== undefined) {
            const merkle = asBuffer(block.hash_list_merkle);
            if (merkle === null || !merkle.equals(fold)) {
              throw new WitnessRefused(
                `block ${FORK_2_0}'s hash_list_merkle ${b64(merkle)} is not the 2.0 seed fold ${b64(fold)}`,
              );
            }
          }
          continue;
        }
        // The value the chain fixes for this block's tx_root: its header's
        // from the 2.0 fork (bound like every header field), below it the
        // transition root a block index gives, when one was given.
        let chainRoot: Buffer | undefined;
        const indep = asBuffer(block.indep_hash) ?? Buffer.alloc(0);
        const weave = BigInt(String(block.weave_size));
        if (h >= FORK_2_0) {
          chainRoot = asBuffer(block.tx_root) ?? Buffer.alloc(0);
        } else {
          const entry = external.get(h);
          if (entry !== undefined) {
            if (!entry.hash.equals(indep) || entry.weaveSize !== weave) {
              throw new WitnessRefused(
                `the block index given for ${h} (${b64(entry.hash)}, weave ${entry.weaveSize}) is not the band's block (${b64(indep)}, weave ${weave})`,
              );
            }
            chainRoot = entry.txRoot;
          }
        }
        let blockRoots: ReadonlyMap<string, Buffer> = roots;
        let computed = await computeTxRoot(h, txs, blockRoots);
        let confirmedRoots =
          computed !== undefined &&
          chainRoot !== undefined &&
          computed.equals(chainRoot);
        if (
          !confirmedRoots &&
          own.length > 0 &&
          chainRoot !== undefined &&
          inputs.v1RootsFromData !== undefined
        ) {
          // A second opinion, from the data itself, for a block the roots
          // given do not reproduce.
          const fromData = await inputs.v1RootsFromData(
            needs.filter((need) => need.height === h),
          );
          const merged = new Map(roots);
          for (const [id, root] of fromData) merged.set(id, root);
          const again = await computeTxRoot(h, txs, merged);
          if (again !== undefined && again.equals(chainRoot)) {
            blockRoots = merged;
            computed = again;
            confirmedRoots = true;
          }
        }
        // Below the fork with no block index, the roots are confirmed by
        // the fold reaching the chain's (a wrong one refuses the band);
        // anywhere else only by the chain's value for this block.
        const keep =
          own.length > 0 &&
          (confirmedRoots ||
            (h < FORK_2_0 &&
              chainRoot === undefined &&
              computed !== undefined));
        if (own.length > 0 && !keep) missing += own.length;
        if (h < FORK_2_0) {
          if (
            chainRoot !== undefined &&
            computed !== undefined &&
            !computed.equals(chainRoot)
          ) {
            throw new WitnessRefused(
              `block ${h}'s transactions give the transition tx_root ${b64(computed)}, the block index given says ${b64(chainRoot)}: the roots given, the band's transactions or the block index are wrong`,
            );
          }
          const txRoot = chainRoot ?? computed;
          if (txRoot === undefined) {
            throw new WitnessRefused(
              `no transition tx_root for block ${h}: ${own.filter((tx) => !roots.has(tx.id.toString('base64url'))).length} of its v1 data roots are missing and no block index was given for it`,
              'unavailable',
            );
          }
          fold = foldBlockIndexEntry(fold as Buffer, {
            indep_hash: indep,
            weave_size: weave,
            tx_root: txRoot,
          });
          const pin = foldPins.fold.get(h);
          if (pin !== undefined && !pin.equals(fold)) {
            throw new WitnessRefused(
              `the 2.0 seed fold through ${h} is ${b64(fold)}, not the chain's ${b64(pin)}: the band's blocks or the transition tx_roots given are not the chain's`,
            );
          }
          // The block's 2.0 hash, from its own fields: every header field,
          // its sorted ids and its transition root.
          let h2: Buffer;
          try {
            h2 = hash20Of10Block(
              {
                height: h,
                previous_block: asBuffer(block.previous_block),
                nonce: asBuffer(block.nonce) ?? Buffer.alloc(0),
                hash: asBuffer(block.hash) ?? Buffer.alloc(0),
                block_timestamp: String(block.block_timestamp),
                last_retarget: String(block.last_retarget),
                diff: String(block.diff),
                cumulative_diff:
                  block.cumulative_diff === null
                    ? null
                    : String(block.cumulative_diff),
                reward_addr: asBuffer(block.reward_addr),
                reward_pool: String(block.reward_pool),
                block_size: String(block.block_size),
                weave_size: String(block.weave_size),
                wallet_list: asBuffer(block.wallet_list),
                hash_list_merkle: asBuffer(block.hash_list_merkle),
              },
              idsAt.get(h) ?? [],
              txRoot,
            );
          } catch (error) {
            throw new WitnessRefused(
              `block ${h}'s 2.0 hash cannot be taken from its fields: ${(error as Error).message}`,
            );
          }
          const listed = hashList10?.[h];
          if (listed !== undefined && !listed.equals(h2)) {
            throw new WitnessRefused(
              `block ${h}'s fields give the 2.0 hash ${b64(h2)}, Arweave's hash_list_1_0 lists ${b64(listed)}`,
            );
          }
          h2Fold = foldH2(h2Fold as Buffer, h2);
          const h2Pin = foldPins.h2.get(h);
          if (h2Pin !== undefined && !h2Pin.equals(h2Fold)) {
            throw new WitnessRefused(
              `the fold of the 2.0 hashes through ${h} is ${b64(h2Fold)}, not hash_list_1_0's ${b64(h2Pin)}: a header field of the band's blocks is not Arweave's`,
            );
          }
          await line(
            forkOut as ReturnType<typeof createWriteStream>,
            `${h},${txRoot.toString('hex')},${fold.toString('hex')},${h2.toString('hex')}`,
          );
        }
        if (h === FORK_2_0 && fold !== undefined) {
          const merkle = asBuffer(block.hash_list_merkle);
          if (merkle === null || !merkle.equals(fold)) {
            throw new WitnessRefused(
              `block ${FORK_2_0}'s hash_list_merkle ${b64(merkle)} is not the 2.0 seed fold ${b64(fold)}`,
            );
          }
        }
        if (keep) {
          confirmed += 1;
          for (const tx of [...own].sort((a, b) =>
            Buffer.compare(a.id, b.id),
          )) {
            const root = blockRoots.get(tx.id.toString('base64url')) as Buffer;
            await line(
              v1Out,
              `${h},${tx.id.toString('hex')},${root.toString('hex')}`,
            );
          }
        }
      }
    }
  } finally {
    for (const stream of [v1Out, forkOut]) {
      if (stream === undefined) continue;
      await new Promise<void>((resolve, reject) =>
        stream.end((error?: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  }
  if (missing > 0) {
    throw new WitnessRefused(
      `${missing} v1 data roots are missing: no input had them, and an l1-4 band holds every one`,
      'unavailable',
    );
  }
  const witnesses: BuiltWitnesses['witnesses'] = {};
  for (const spec of specs) {
    const csv = spec === V1_DATA_ROOTS_WITNESS ? v1Csv : forkCsv;
    witnesses[spec.name] = await writeWitnessFile(duck, csv, outDir, spec);
    await fs.rm(csv, { force: true });
  }
  return { witnesses, missing, confirmed };
}

/**
 * Writes a witness's Parquet from its scratch CSV (hex bytes, decimal
 * heights, in the witness's order), and returns its description: rows and
 * digest as a verifier takes them from the file.
 */
async function writeWitnessFile(
  duck: Database,
  csv: string,
  outDir: string,
  spec: WitnessSpec,
): Promise<{ rows: number; rowDigest: string }> {
  const columns = spec.columns.map((c) => `'${c.name}': 'VARCHAR'`).join(', ');
  const select = spec.columns
    .map((c) =>
      c.type === 'BLOB'
        ? `from_hex("${c.name}") AS "${c.name}"`
        : `CAST("${c.name}" AS ${c.type}) AS "${c.name}"`,
    )
    .join(', ');
  const source = `read_csv(${sql(csv)}, header = false, delim = ',', auto_detect = false, nullstr = '\\N', columns = {${columns}})`;
  await duck.exec(
    `COPY (SELECT ${select} FROM ${source} ORDER BY ${spec.orderBy.map((c) => `"${c}"`).join(', ')}) TO ${sql(path.join(outDir, spec.file))} (FORMAT PARQUET, COMPRESSION 'zstd')`,
  );
  const { rows, rowDigest } = await digestBandTable(duck, outDir, spec);
  return { rows, rowDigest };
}
