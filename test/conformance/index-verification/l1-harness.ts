/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The L1 kinds of the index-verification conformance suite (`l1-bands`,
 * `l1-anchor`): builds each case from one honest chain, tampers with it as
 * the case says, runs it through `verifyBands`, and gives the verdict and
 * the checks that failed. See README.md, "L1 cases", for the build spec and
 * the verdict mapping.
 *
 * The honest chain is built once per run: 20 blocks from 1,900,000 (2.9
 * era) whose headers recompute and whose transactions carry real
 * signatures (`buildCoreDb({ verifiable: true })`), exported by the real
 * exporter as two bands of 10 heights, named by their real ids. Each case
 * works on its own copy of the bands; the chain a scripted node serves is
 * always the honest one.
 *
 * Cases with `chain: "pre20"` start instead from a chain below the 2.0
 * fork (`honestPre20`): one band of the 20 heights below 422,250, given
 * its `l1-4` witnesses by the real builder, and judged against that
 * chain's own pinned folds (`foldPins`), since its blocks are not
 * mainnet's.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import { getSolanaAddress } from '../../../src/lib/httpsig.js';
import {
  type IndexPublication,
  serializeIndexPublication,
  signIndexPublication,
} from '../../../src/lib/index-publication.js';
import { ArweaveNodePool } from '../../../src/lib/onchain/arweave-nodes.js';
import { VerifyRefused } from '../../../src/lib/parquet-l1/checks.js';
import {
  BAND_FILE,
  FORK_2_0_WITNESS,
  PARQUET_L1_LOOKUPS,
  PARQUET_L1_WITNESSES,
  parseBandFile,
  serializeBandFile,
  V1_DATA_ROOTS_WITNESS,
  witnessesOf,
} from '../../../src/lib/parquet-l1/layout.js';
import { writeBandLookups } from '../../../src/lib/parquet-l1/lookups.js';
import { digestBandTable } from '../../../src/lib/parquet-l1/read.js';
import {
  BandsRefused,
  type BandsVerifyResult,
  verifyBands,
} from '../../../src/lib/parquet-l1/verify-bands.js';
import {
  exportBands,
  republish,
  rewriteTable,
  witnessTestBand,
} from '../../parquet-l1-bands.js';
import { buildCoreDb } from '../../parquet-l1-core-db.js';
import {
  chainNode,
  type HeaderRow,
  type NodeAnswer,
  scriptedFetch,
  scriptedLookup,
  syntheticHeader,
} from '../../parquet-l1-headers.js';
import type { Case, Verdict } from './harness.js';
import {
  type ChainBlock,
  foldBlockIndexEntry,
  FORK_2_0,
  nextHashListMerkle,
} from '../../../src/lib/parquet-l1/chain.js';

/** The honest chain's first band height, and its two bands. */
export const L1_FIRST = 1_900_000;
const RANGES: Array<[number, number]> = [
  [L1_FIRST, L1_FIRST + 9],
  [L1_FIRST + 10, L1_FIRST + 19],
];
const TOP = L1_FIRST + 19;

interface Honest {
  root: string;
  coreDb: string;
  bandsDir: string;
  /** The publisher the bands are named for: a wallet address. */
  publisher: string;
}
let honest: Promise<Honest> | undefined;

/** The honest chain and its bands, built once per run under `root`. */
export function honestL1(root: string): Promise<Honest> {
  honest ??= (async () => {
    const dir = path.join(root, 'l1-honest');
    await fs.mkdir(dir, { recursive: true });
    const coreDb = path.join(dir, 'core.db');
    const bandsDir = path.join(dir, 'bands');
    const publisher = getSolanaAddress(
      crypto.generateKeyPairSync('ed25519').publicKey,
    );
    await buildCoreDb(coreDb, L1_FIRST, 20, {
      padded: false,
      verifiable: true,
    });
    await exportBands(coreDb, bandsDir, RANGES, publisher);
    return { root: dir, coreDb, bandsDir, publisher };
  })();
  return honest;
}

/** The pre-2.0 chain's band: the 20 heights below the 2.0 fork. */
export const PRE20_FIRST = FORK_2_0 - 20;

interface HonestPre20 extends Honest {
  /** The chain's own pinned folds: the seed below the band, and the fold through its top. */
  pins: Map<number, Buffer>;
}
let honestPre20Promise: Promise<HonestPre20> | undefined;

/**
 * The pre-2.0 chain and its one band, witnessed, built once per run: 20
 * blocks of format-1 transactions signed over their data
 * (`buildCoreDb({ verifiable: true })` below the fork), exported by the
 * real exporter (as `l1-3`: no pin below its first height), then given its
 * witnesses by the real builder (`witnessTestBand`), the chain's v1 roots
 * taken from the data its transactions sign. Its 2.0 seed fold starts from
 * `SHA-384("pre20")` below the band; the fold through 422,249 is what its
 * blocks and their transition roots give. Those two are the chain's pins.
 */
export function honestPre20(
  root: string,
  duck: Database,
): Promise<HonestPre20> {
  honestPre20Promise ??= (async () => {
    const dir = path.join(root, 'l1-honest-pre20');
    await fs.mkdir(dir, { recursive: true });
    const coreDb = path.join(dir, 'core.db');
    const bandsDir = path.join(dir, 'bands');
    const publisher = getSolanaAddress(
      crypto.generateKeyPairSync('ed25519').publicKey,
    );
    await buildCoreDb(coreDb, PRE20_FIRST, 20, {
      padded: false,
      verifiable: true,
    });
    const [exported] = await exportBands(
      coreDb,
      bandsDir,
      [[PRE20_FIRST, FORK_2_0 - 1]],
      publisher,
    );
    const pins = await witnessTestBand(duck, coreDb, exported.dir);
    return { root: dir, coreDb, bandsDir, publisher, pins };
  })();
  return honestPre20Promise;
}

/** Rewrites one of a band's witness files with `select` over `SRC`, its columns kept. */
async function rewriteWitness(
  duck: Database,
  dir: string,
  name: string,
  select: string,
): Promise<void> {
  const spec = PARQUET_L1_WITNESSES.find((w) => w.name === name);
  if (spec === undefined) throw new Error(`no witness ${name}`);
  const file = path.join(dir, spec.file);
  const cols = spec.columns.map((c) => `"${c.name}"`).join(', ');
  await duck.exec(
    `CREATE OR REPLACE TABLE src AS SELECT * FROM read_parquet('${file}')`,
  );
  await duck.exec(
    `COPY (SELECT ${cols} FROM (${select.replace(/\bSRC\b/g, 'src')})) TO '${file}.x' (FORMAT PARQUET)`,
  );
  await fs.rename(`${file}.x`, file);
}

/** One change to a case's bands, applied in order (see README.md). */
export type L1Op = { op: string; band?: number; [field: string]: unknown };

/** What a case's run gives. */
export interface L1CaseResult {
  verdict: Verdict;
  failing: string[];
  publisherBound?: boolean;
  result?: BandsVerifyResult;
  refused?: string;
}

const sqlLiteral = (value: unknown): string =>
  typeof value === 'number' ? String(value) : String(value);

/** The band directories of a case, by index, lowest first. */
async function bandDirs(bandsDir: string): Promise<string[]> {
  const names = (await fs.readdir(bandsDir))
    .filter((n) => /^l1-h\d+-\d+-[0-9a-f]{8}-[0-9a-f]{12}$/.test(n))
    .sort(
      (a, b) =>
        Number(/^l1-h(\d+)/.exec(a)?.[1]) - Number(/^l1-h(\d+)/.exec(b)?.[1]),
    );
  return names.map((n) => path.join(bandsDir, n));
}

/** Applies one op to a case's bands. */
async function apply(
  duck: Database,
  bandsDir: string,
  publisher: string,
  op: L1Op,
): Promise<void> {
  const dirs = await bandDirs(bandsDir);
  const dir = dirs[op.band ?? 0];
  const h = op.height as number | undefined;
  switch (op.op) {
    case 'republish':
      await republish(duck, dir, publisher);
      return;
    case 'relookup': {
      // Lookups rebuilt from the (tampered) tables and described in
      // band.json; the tables' digests left as they were.
      const file = path.join(dir, 'band.json');
      const band = parseBandFile(await fs.readFile(file, 'utf8'));
      band.lookups = await writeBandLookups(duck, dir, dir);
      await fs.writeFile(file, serializeBandFile(band));
      return;
    }
    case 'rewrite':
      await rewriteTable(duck, dir, op.table as string, op.select as string);
      return;
    case 'setFormat':
      await rewriteTable(
        duck,
        dir,
        'transactions',
        `SELECT * REPLACE (CASE WHEN height = ${h} AND block_transaction_index = ${op.bti as number} THEN ${op.format as number}::UTINYINT ELSE format END AS format) FROM SRC`,
      );
      return;
    case 'nullCell':
      await rewriteTable(
        duck,
        dir,
        op.table as string,
        `SELECT * REPLACE (CASE WHEN ${op.where as string} THEN NULL ELSE "${op.column as string}" END AS "${op.column as string}") FROM SRC`,
      );
      return;
    case 'dropLink':
      await rewriteTable(
        duck,
        dir,
        'block_transactions',
        `SELECT * FROM SRC WHERE NOT (height = ${h} AND block_transaction_index = ${op.bti as number})`,
      );
      return;
    case 'moveTx': {
      // Reverses the order of a block's transactions; `links` too.
      const tables =
        op.links === true
          ? ['transactions', 'block_transactions']
          : ['transactions'];
      for (const table of tables) {
        await rewriteTable(
          duck,
          dir,
          table,
          `SELECT * REPLACE (CASE WHEN height = ${h} THEN (SELECT max(block_transaction_index) FROM SRC WHERE height = ${h}) - block_transaction_index ELSE block_transaction_index END AS block_transaction_index) FROM SRC`,
        );
      }
      return;
    }
    case 'editBlockField':
      await rewriteTable(
        duck,
        dir,
        'blocks',
        `SELECT * REPLACE (CASE WHEN height = ${h} THEN ${sqlLiteral(op.value)} ELSE "${op.column as string}" END AS "${op.column as string}") FROM SRC`,
      );
      return;
    case 'inventTx': {
      // A format-2 transaction with no data appended to a block, linked.
      const id = crypto.randomBytes(32).toString('hex');
      await rewriteTable(
        duck,
        dir,
        'transactions',
        `SELECT * FROM SRC UNION ALL
         SELECT * REPLACE (from_hex('${id}') AS id,
           (SELECT max(block_transaction_index) + 1 FROM SRC WHERE height = ${h})::USMALLINT AS block_transaction_index,
           0::UBIGINT AS data_size, NULL::BLOB AS data_root, 0 AS tag_count)
         FROM (SELECT * FROM SRC WHERE height = ${h} LIMIT 1)`,
      );
      await rewriteTable(
        duck,
        dir,
        'block_transactions',
        `SELECT * FROM SRC UNION ALL
         SELECT ${h}::UBIGINT AS height,
           (SELECT max(block_transaction_index) + 1 FROM SRC WHERE height = ${h})::USMALLINT AS block_transaction_index,
           from_hex('${id}') AS transaction_id`,
      );
      await rewriteTable(
        duck,
        dir,
        'blocks',
        `SELECT * REPLACE (CASE WHEN height = ${h} THEN tx_count + 1 ELSE tx_count END AS tx_count) FROM SRC`,
      );
      return;
    }
    case 'editTag':
      await rewriteTable(
        duck,
        dir,
        'tags',
        `SELECT * REPLACE (CASE WHEN height = ${h} AND tag_index = 1 THEN 'forged'::BLOB ELSE tag_value END AS tag_value) FROM SRC`,
      );
      return;
    case 'setQuantity':
      await rewriteTable(
        duck,
        dir,
        'transactions',
        `SELECT * REPLACE (CASE WHEN height = ${h} THEN ${op.quantity as string}::DECIMAL(20,0) ELSE quantity END AS quantity) FROM SRC`,
      );
      return;
    case 'dropWallet':
      await rewriteTable(duck, dir, 'wallets', 'SELECT * FROM SRC WHERE false');
      return;
    case 'forgeWallet':
      await rewriteTable(
        duck,
        dir,
        'wallets',
        "SELECT address, '\\xDEAD'::BLOB AS public_modulus FROM SRC",
      );
      return;
    case 'strayRow':
      await rewriteTable(
        duck,
        dir,
        op.table as string,
        `SELECT * FROM SRC UNION ALL SELECT * REPLACE (height + ${op.shift as number} AS height) FROM SRC`,
      );
      return;
    case 'dropColumn': {
      const file = path.join(dir, `${op.table as string}.parquet`);
      await duck.exec(
        `COPY (SELECT ${(op.keep as string[]).map((c) => `"${c}"`).join(', ')} FROM read_parquet('${file}')) TO '${file}.x' (FORMAT PARQUET)`,
      );
      await fs.rename(`${file}.x`, file);
      return;
    }
    case 'reorderLookup': {
      const spec = PARQUET_L1_LOOKUPS.find((s) => s.name === op.lookup);
      if (spec === undefined) throw new Error(`no lookup ${String(op.lookup)}`);
      const file = path.join(dir, spec.file);
      await duck.exec(
        `COPY (SELECT * FROM read_parquet('${file}') ORDER BY ${spec.orderBy.map((c) => `"${c}" DESC`).join(', ')}) TO '${file}.x' (FORMAT PARQUET, ROW_GROUP_SIZE 2)`,
      );
      await fs.rename(`${file}.x`, file);
      return;
    }
    case 'writeFile':
      await fs.writeFile(path.join(dir, op.file as string), op.text as string);
      return;
    case 'removeFile':
      await fs.rm(path.join(dir, op.file as string));
      return;
    case 'truncate': {
      const file = path.join(dir, op.file as string);
      const { size } = await fs.stat(file);
      await fs.truncate(file, Math.floor(size / 2));
      return;
    }
    case 'appendByte':
      await fs.appendFile(path.join(dir, op.file as string), Buffer.from([0]));
      return;
    case 'renameDir': {
      // `RENAME_DIGEST`: the same name with a digest its tables do not give.
      const name =
        op.name === 'RENAME_DIGEST'
          ? path.basename(dir).replace(/[0-9a-f]{12}$/, '000000000000')
          : (op.name as string);
      await fs.rename(dir, path.join(bandsDir, name));
      return;
    }
    case 'rechain': {
      // A fabricated chain under the real top: every block hash below the
      // top replaced, and each block's previous_block and hash_list_merkle
      // rebuilt to match, in every band; then republished.
      const rows: ChainBlock[] = [];
      for (const d of dirs) {
        for (const r of (await duck.all(
          `SELECT height, indep_hash, previous_block, CAST(weave_size AS VARCHAR) AS weave_size, tx_root, hash_list_merkle FROM read_parquet('${path.join(d, 'blocks.parquet')}') ORDER BY height`,
        )) as Array<Record<string, any>>) {
          rows.push({
            height: Number(r.height),
            indep_hash: Buffer.from(r.indep_hash),
            previous_block: Buffer.from(r.previous_block),
            weave_size: r.weave_size,
            tx_root: Buffer.from(r.tx_root ?? []),
            hash_list_merkle: Buffer.from(r.hash_list_merkle),
          });
        }
      }
      for (let i = 0; i < rows.length; i += 1) {
        if (i < rows.length - 1) rows[i].indep_hash = crypto.randomBytes(48);
        if (i > 0) {
          rows[i].previous_block = rows[i - 1].indep_hash;
          rows[i].hash_list_merkle = nextHashListMerkle(rows[i - 1]);
        }
      }
      for (const d of dirs) {
        const values = rows
          .map(
            (r) =>
              `(${r.height}, from_hex('${r.indep_hash.toString('hex')}'), from_hex('${(r.previous_block as Buffer).toString('hex')}'), from_hex('${(r.hash_list_merkle as Buffer).toString('hex')}'))`,
          )
          .join(', ');
        await rewriteTable(
          duck,
          d,
          'blocks',
          `SELECT SRC.* REPLACE (v.i AS indep_hash, v.p AS previous_block, v.m AS hash_list_merkle) FROM SRC JOIN (VALUES ${values}) v(h, i, p, m) ON v.h = SRC.height`,
        );
        await republish(duck, d, publisher);
      }
      return;
    }
    case 'swapGeneration': {
      // Two installed generations of one band, `<id>~a` and `<id>~b`; with
      // `differ`, the second holds other tables (a forged tag, republished
      // under the same id).
      const id = path.basename(dir);
      const a = path.join(bandsDir, `${id}~a`);
      const b = path.join(bandsDir, `${id}~b`);
      await fs.cp(dir, b, { recursive: true });
      await fs.rename(dir, a);
      if (op.differ === true) {
        await rewriteTable(
          duck,
          b,
          'tags',
          "SELECT * REPLACE (CASE WHEN tag_index = 1 THEN 'other'::BLOB ELSE tag_value END AS tag_value) FROM SRC",
        );
        const moved = await republish(duck, b, publisher);
        await fs.rename(moved, b);
      }
      // The second is the newer, as a replacement is.
      const now = new Date();
      await fs.utimes(b, now, now);
      return;
    }
    case 'retireCopy': {
      const id = path.basename(dir);
      const copy = path.join(bandsDir, `${id}~retired`);
      await fs.cp(dir, copy, { recursive: true });
      await fs.rm(path.join(copy, 'band.json'));
      return;
    }
    case 'strayDir': {
      const stray = path.join(bandsDir, 'stray');
      await fs.mkdir(stray);
      await fs.copyFile(
        path.join(dir, 'blocks.parquet'),
        path.join(stray, 'blocks.parquet'),
      );
      return;
    }
    case 'removeBand':
      await fs.rm(dir, { recursive: true });
      return;
    case 'witnessV1': {
      // A v1 data root for the transaction at `height`, `bti`: its own
      // data_root (`leaf`, which its tx_root leaf holds) or another
      // (`random`). Unless `keepDataRoot`, its data_root is then cleared,
      // as a band holds a format-1 transaction's.
      const [row] = (await duck.all(
        `SELECT id, data_root FROM read_parquet('${path.join(dir, 'transactions.parquet')}')
         WHERE height = ${h} AND block_transaction_index = ${op.bti as number}`,
      )) as Array<{ id: Uint8Array; data_root: Uint8Array | null }>;
      const id = Buffer.from(row.id).toString('hex');
      const root =
        op.root === 'random'
          ? crypto.randomBytes(32).toString('hex')
          : Buffer.from(row.data_root as Uint8Array).toString('hex');
      await rewriteWitness(
        duck,
        dir,
        V1_DATA_ROOTS_WITNESS.name,
        `SELECT * FROM SRC UNION ALL SELECT ${h}::UBIGINT, from_hex('${id}'), from_hex('${root}')`,
      );
      if (op.keepDataRoot !== true) {
        await rewriteTable(
          duck,
          dir,
          'transactions',
          `SELECT * REPLACE (CASE WHEN height = ${h} AND block_transaction_index = ${op.bti as number} THEN NULL ELSE data_root END AS data_root) FROM SRC`,
        );
      }
      return;
    }
    case 'editWitness':
      await rewriteWitness(
        duck,
        dir,
        op.witness as string,
        op.select as string,
      );
      return;
    case 'forgeTransitionRoot': {
      // The transition tx_root at `height` replaced, and every fold from
      // there rebuilt on it: a self-consistent witness of another root.
      const file = path.join(dir, FORK_2_0_WITNESS.file);
      const rows = (await duck.all(
        `SELECT w.height, w.tx_root, w.fold, b.indep_hash, CAST(b.weave_size AS VARCHAR) AS weave_size
         FROM read_parquet('${file}') w
         JOIN read_parquet('${path.join(dir, 'blocks.parquet')}') b ON b.height = w.height
         ORDER BY w.height`,
      )) as Array<Record<string, any>>;
      const at = rows.findIndex((r) => Number(r.height) === h);
      let fold = Buffer.from(rows[at - 1].fold);
      const values: string[] = [];
      for (const [i, r] of rows.entries()) {
        let txRoot = Buffer.from(r.tx_root);
        let rowFold = Buffer.from(r.fold);
        if (i >= at) {
          if (i === at) txRoot = crypto.randomBytes(32);
          fold = foldBlockIndexEntry(fold, {
            indep_hash: Buffer.from(r.indep_hash),
            weave_size: r.weave_size,
            tx_root: txRoot,
          });
          rowFold = fold;
        }
        values.push(
          `(${Number(r.height)}::UBIGINT, from_hex('${txRoot.toString('hex')}'), from_hex('${rowFold.toString('hex')}'))`,
        );
      }
      await rewriteWitness(
        duck,
        dir,
        FORK_2_0_WITNESS.name,
        `SELECT * FROM (VALUES ${values.join(', ')}) v(height, tx_root, fold)`,
      );
      return;
    }
    case 'dropWitnesses': {
      // The band as l1-3: no witness files, none described.
      const file = path.join(dir, BAND_FILE);
      const band = parseBandFile(await fs.readFile(file, 'utf8'));
      for (const spec of witnessesOf(band.schema, band.heightRange)) {
        await fs.rm(path.join(dir, spec.file));
      }
      const { witnesses: _w, ...rest } = band;
      void _w;
      await fs.writeFile(file, serializeBandFile({ ...rest, schema: 'l1-3' }));
      return;
    }
    case 'redescribeWitness': {
      // A witness's rows and digest in band.json as its file now is.
      const spec = PARQUET_L1_WITNESSES.find((w) => w.name === op.witness);
      if (spec === undefined)
        throw new Error(`no witness ${String(op.witness)}`);
      const file = path.join(dir, BAND_FILE);
      const band = parseBandFile(await fs.readFile(file, 'utf8'));
      const { rows, rowDigest } = await digestBandTable(duck, dir, spec);
      band.witnesses = { ...band.witnesses, [spec.name]: { rows, rowDigest } };
      await fs.writeFile(file, serializeBandFile(band));
      return;
    }
    default:
      throw new Error(`unknown l1 op ${op.op}`);
  }
}

/** A scripted answer for one node, by kind (see README.md). */
function answering(coreDb: string, kind: string): (p: string) => NodeAnswer {
  const node = chainNode(coreDb);
  switch (kind) {
    case 'honest':
      return node;
    case 'missing':
      return () => ({ status: 404 });
    case 'otherBlock':
      // The block below the one asked for, served as if it were it.
      return (p) => {
        const m = /^\/block\/height\/(\d+)$/.exec(p);
        return m !== null ? node(`/block/height/${Number(m[1]) - 1}`) : node(p);
      };
    case 'alteredUnhashed':
      // weave_size changed, the hash left as it was: does not recompute.
      return (p) => {
        const answer = node(p);
        if (!p.startsWith('/block/') || answer.status !== 200) return answer;
        const body = { ...(answer.body as Record<string, unknown>) };
        body.weave_size = String(BigInt(body.weave_size as string) + 1n);
        return { status: 200, body };
      };
    case 'rehashedMerkle':
      // A fabricated hash_list_merkle, the header re-hashed to match it.
      return (p) => {
        const answer = node(p);
        if (!p.startsWith('/block/') || answer.status !== 200) return answer;
        const body = answer.body as Record<string, any>;
        const row: HeaderRow = {
          height: body.height,
          previous_block: Buffer.from(body.previous_block, 'base64url'),
          nonce: Buffer.from(body.nonce, 'base64url'),
          hash: Buffer.from(body.hash, 'base64url'),
          block_timestamp: body.timestamp,
          diff: body.diff,
          cumulative_diff: body.cumulative_diff,
          last_retarget: body.last_retarget,
          reward_addr:
            body.reward_addr === 'unclaimed'
              ? null
              : Buffer.from(body.reward_addr, 'base64url'),
          reward_pool: body.reward_pool,
          block_size: Number(body.block_size),
          weave_size: Number(body.weave_size),
          usd_to_ar_rate_dividend: Number(body.usd_to_ar_rate[0]),
          usd_to_ar_rate_divisor: Number(body.usd_to_ar_rate[1]),
          scheduled_usd_to_ar_rate_dividend: Number(
            body.scheduled_usd_to_ar_rate[0],
          ),
          scheduled_usd_to_ar_rate_divisor: Number(
            body.scheduled_usd_to_ar_rate[1],
          ),
          // The same fabrication from every liar, so two liars agree.
          hash_list_merkle: crypto
            .createHash('sha384')
            .update(Buffer.from(body.hash_list_merkle, 'base64url'))
            .digest(),
          wallet_list: Buffer.from(body.wallet_list, 'base64url'),
          tx_root: Buffer.from(body.tx_root, 'base64url'),
        };
        return {
          status: 200,
          body: syntheticHeader(
            row,
            (body.txs as string[]).map((t) => Buffer.from(t, 'base64url')),
          ),
        };
      };
    case 'unreachable':
      return () => {
        throw new TypeError('fetch failed');
      };
    default:
      throw new Error(`unknown node answer ${kind}`);
  }
}

/**
 * Whether a failed check refutes the index (it is shown wrong) or only
 * leaves something unestablished (README.md, "L1 verdicts").
 */
function inconclusive(name: string, result: BandsVerifyResult): boolean {
  if (name === 'unbound') return true;
  if (name === 'anchor') {
    const a = result.anchor;
    if (a === undefined) return true;
    const indexWrong =
      a.mismatches.length > 0 ||
      a.problems.some((p) =>
        /holds no block|has no indep_hash|does not build on/.test(p),
      );
    return !indexWrong;
  }
  if (name === 'sample') {
    const check = result.checks.find((c) => c.name === 'sample');
    return (check?.failures ?? []).every((f) =>
      /could not be read/.test(f.found),
    );
  }
  return false;
}

/**
 * Builds a case's bands from the honest chain into a directory of its own
 * under `root`, tampered as the case says, and its signed publication when
 * it asks for one. The caller removes `dir`.
 */
export async function buildL1Case(
  duck: Database,
  root: string,
  c: Case,
): Promise<{
  dir: string;
  bandsDir: string;
  coreDb: string;
  /** The chain's own pinned folds, for a chain that is not mainnet's below the 2.0 fork. */
  foldPins?: Map<number, Buffer>;
  publication?: NonNullable<Parameters<typeof verifyBands>[2]>['publication'];
}> {
  const pre20 = c.chain === 'pre20' ? await honestPre20(root, duck) : undefined;
  const base: Honest = pre20 ?? (await honestL1(root));
  const dir = await fs.mkdtemp(path.join(root, `${c.id}-`));
  const bandsDir = path.join(dir, 'bands');
  await fs.cp(base.bandsDir, bandsDir, { recursive: true });
  for (const op of (c.ops ?? []) as L1Op[]) {
    await apply(duck, bandsDir, base.publisher, op);
  }

  // The publication, signed over the bands as they now stand.
  const pub = c.publication as { omit?: number[] } | undefined;
  let publication: NonNullable<
    Parameters<typeof verifyBands>[2]
  >['publication'];
  if (pub !== undefined) {
    const key = crypto.generateKeyPairSync('ed25519');
    const keyAddress = getSolanaAddress(key.publicKey);
    const listed = [];
    for (const [i, band] of (await bandDirs(bandsDir)).entries()) {
      if (pub.omit?.includes(i) === true) continue;
      const files = [];
      for (const name of (await fs.readdir(band))
        .filter((n) => !n.startsWith('.'))
        .sort()) {
        const bytes = await fs.readFile(path.join(band, name));
        files.push({
          name,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
      listed.push({ id: path.basename(band), files });
    }
    const document: IndexPublication = {
      version: 1,
      publisher: base.publisher,
      sequence: 7,
      previousManifestSha256: null,
      issuedAt: '2026-10-20T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      indexes: [{ name: 'parquet-l1', kind: 'parquet-l1', bands: listed }],
    };
    publication = {
      document: serializeIndexPublication(
        signIndexPublication(document, key.privateKey, keyAddress),
      ),
      publisherKey: keyAddress,
    };
  }
  for (const op of (c.after ?? []) as L1Op[]) {
    await apply(duck, bandsDir, base.publisher, op);
  }
  return {
    dir,
    bandsDir,
    coreDb: base.coreDb,
    ...(pre20 !== undefined ? { foldPins: pre20.pins } : {}),
    ...(publication !== undefined ? { publication } : {}),
  };
}

/** Builds a case's bands from the honest chain, runs it, and judges it. */
export async function runL1Case(
  duck: Database,
  root: string,
  c: Case,
): Promise<L1CaseResult> {
  const { dir, bandsDir, coreDb, publication, foldPins } = await buildL1Case(
    duck,
    root,
    c,
  );
  const options = (c.options ?? {}) as {
    from?: number;
    to?: number;
    lookups?: boolean;
    allowUnanchored?: boolean;
    allowUnbound?: boolean;
    allowIncomplete?: boolean;
    allowUnverifiedFormat1?: boolean;
    anchorMin?: number;
    sample?: { blocks: number; txs: number; format1?: number };
  };
  const nodes = (c.nodes ?? []) as Array<{ name: string; answer: string }>;
  const shared = (c.shared ?? []) as string[][];
  let pool: ArweaveNodePool | undefined;
  if (nodes.length > 0) {
    const sharedHosts: Record<string, string[]> = {};
    shared.forEach((names, i) => {
      for (const name of names)
        sharedHosts[`${name}.test`] = [`198.51.100.${i + 1}`];
    });
    pool = new ArweaveNodePool({
      urls: nodes.map((n) => `http://${n.name}.test`),
      fetch: scriptedFetch(
        Object.fromEntries(
          nodes.map((n) => [
            `http://${n.name}.test`,
            answering(coreDb, n.answer),
          ]),
        ),
      ),
      lookupAll: scriptedLookup(sharedHosts),
      timeoutMs: 5_000,
    });
  }
  try {
    const result = await verifyBands(duck, bandsDir, {
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.to !== undefined ? { to: options.to } : {}),
      ...(options.lookups === false ? { lookups: false } : {}),
      ...(pool !== undefined ? { pool } : {}),
      ...(options.anchorMin !== undefined
        ? { anchorMin: options.anchorMin }
        : {}),
      ...(options.sample !== undefined
        ? {
            sample: {
              seed: 1,
              blocks: options.sample.blocks,
              txsPerStratum: options.sample.txs,
              ...(options.sample.format1 !== undefined
                ? { format1PerStratum: options.sample.format1 }
                : {}),
              v1BytesPerStratum: 1e6,
              concurrency: 2,
            },
          }
        : {}),
      allow: {
        unanchored: options.allowUnanchored === true,
        unbound: options.allowUnbound === true,
        incomplete: options.allowIncomplete === true,
        unverifiedFormat1: options.allowUnverifiedFormat1 === true,
      },
      ...(publication !== undefined ? { publication } : {}),
      ...(foldPins !== undefined ? { foldPins } : {}),
    });
    const failing = result.checks.filter((x) => !x.ok).map((x) => x.name);
    const verdict: Verdict = result.ok
      ? 'verified'
      : failing.every((name) => inconclusive(name, result))
        ? 'unknown'
        : 'refuted';
    return {
      verdict,
      failing,
      publisherBound: result.publisherBound,
      result,
    };
  } catch (error) {
    if (error instanceof BandsRefused || error instanceof VerifyRefused) {
      return {
        verdict: 'refuted',
        failing: ['refused'],
        refused: error.message,
      };
    }
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The honest top height, for cases that ask beyond it. */
export const L1_TOP = TOP;
