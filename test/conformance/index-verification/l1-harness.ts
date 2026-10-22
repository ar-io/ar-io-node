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
  PARQUET_L1_LOOKUPS,
  parseBandFile,
  serializeBandFile,
} from '../../../src/lib/parquet-l1/layout.js';
import { writeBandLookups } from '../../../src/lib/parquet-l1/lookups.js';
import {
  BandsRefused,
  type BandsVerifyResult,
  verifyBands,
} from '../../../src/lib/parquet-l1/verify-bands.js';
import {
  exportBands,
  republish,
  rewriteTable,
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
  publication?: NonNullable<Parameters<typeof verifyBands>[2]>['publication'];
}> {
  const base = await honestL1(root);
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
    ...(publication !== undefined ? { publication } : {}),
  };
}

/** Builds a case's bands from the honest chain, runs it, and judges it. */
export async function runL1Case(
  duck: Database,
  root: string,
  c: Case,
): Promise<L1CaseResult> {
  const { dir, bandsDir, coreDb, publication } = await buildL1Case(
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
    allowUnverifiedFormat1?: boolean;
    anchorMin?: number;
    sample?: { blocks: number; txs: number };
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
              v1BytesPerStratum: 1e6,
              concurrency: 2,
            },
          }
        : {}),
      allow: {
        unanchored: options.allowUnanchored === true,
        unbound: options.allowUnbound === true,
        unverifiedFormat1: options.allowUnverifiedFormat1 === true,
      },
      ...(publication !== undefined ? { publication } : {}),
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
