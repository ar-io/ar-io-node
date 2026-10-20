/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index-verification conformance suite's generator and runner, for this
 * implementation. Each case (`cases/<id>/case.json`) declares what is built
 * and how it is tampered with; this module builds it into a temporary
 * directory at test time (nothing large is committed), runs it through
 * `verifyL2Bands` or `checkDrawnHeaders`, and gives the verdict:
 * `verified`, `refuted` or `unknown`, with the checks that fired.
 *
 * Building is deterministic in structure: the same case gives the same
 * bands, rows, heights, offsets and node answers. Ids that come from
 * signatures differ run to run (Arweave and ANS-104 signatures are salted),
 * and are referred to only by symbol (`G`, `R`, …).
 *
 * See README.md for the case format and how another implementation runs it.
 */
import {
  ArweaveSigner,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { default as Arweave } from 'arweave';
import type { JWKInterface } from 'arweave/node/lib/wallet.js';
import type { Database } from 'duckdb-async';

import { scanBundle } from '../../../src/lib/ans104-bundle-scan.js';
import { getSolanaAddress } from '../../../src/lib/httpsig.js';
import { bandPublisherTag } from '../../../src/lib/index-band/build.js';
import type { BandSampleEntry } from '../../../src/lib/index-band/build.js';
import {
  checkDrawnHeaders,
  type RootSourceFactory,
} from '../../../src/lib/index-band/verify.js';
import {
  type IndexPublication,
  serializeIndexPublication,
  signIndexPublication,
} from '../../../src/lib/index-publication.js';
import {
  ArweaveNodePool,
  type FetchLike,
} from '../../../src/lib/onchain/arweave-nodes.js';
import { onChainRootSource } from '../../../src/lib/onchain/root-source.js';
import { RowDigest } from '../../../src/lib/parquet/digest.js';
import {
  BAND_FILE,
  DATA_ITEM_LOCATION_COLUMNS,
  l2BandId,
  orderByClause,
  PARQUET_L2_TABLES,
  type ParquetL2Band,
  serializeBandFile,
} from '../../../src/lib/parquet-l2/layout.js';
import { writeBandLookups } from '../../../src/lib/parquet-l2/lookups.js';
import {
  L2BandsRefused,
  verifyL2Bands,
} from '../../../src/lib/parquet-l2/verify-bands.js';
import { BufferByteRangeSource } from '../../buffer-byte-range-source.js';
import { writeL1Band } from '../../parquet-l2-fixture.js';

export type Verdict = 'verified' | 'refuted' | 'unknown';

export interface CaseExpect {
  verdict: Verdict;
  /** The check that must fire (a failing check's name, or `refused`). */
  check?: string;
  publisherBound?: boolean;
  /** The same seed draws the same items twice. */
  repeatable?: boolean;
  /** For a draw case: how the band's sample was drawn. */
  draw?: {
    drawnUniform: number;
    readsInclude?: number[];
    /** Two bands of one layout draw different positions under one seed. */
    bandsDiffer?: boolean;
  };
  /** Every check that fails, exactly (for `refuted` and `unknown`). */
  failing?: string[];
  /**
   * On-chain cases: why, exactly. Refuted: the kinds of wrong entries
   * (`not-the-item`, `past-end`, `refuted`, `missing`). Unknown: one of
   * `unchecked`, `nothing-verified`, `nothing-drawn`.
   */
  reason?: string[];
}

export interface Case {
  id: string;
  description: string;
  tampered: string;
  kind: 'bands' | 'onchain';
  expect: CaseExpect;
  [field: string]: unknown;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every case, in id order. */
export async function loadCases(): Promise<Case[]> {
  const dir = path.join(HERE, 'cases');
  const cases: Case[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const text = await fs.readFile(path.join(dir, name, 'case.json'), 'utf8');
    const parsed = JSON.parse(text) as Case;
    if (parsed.id !== name) {
      throw new Error(`cases/${name}/case.json has id ${parsed.id}`);
    }
    cases.push(parsed);
  }
  return cases;
}

// ---------------------------------------------------------------- bands --

/** A value in a case: null, a number, or tagged text. */
type CaseValue = null | number | string;

/** `hash:<label>` is sha256 of the label; `utf8:<s>` its bytes; numbers as is. */
function value(v: CaseValue): unknown {
  if (v === null || typeof v === 'number') return v;
  if (v.startsWith('hash:')) {
    return crypto.createHash('sha256').update(v.slice(5)).digest();
  }
  if (v.startsWith('utf8:')) return Buffer.from(v.slice(5), 'utf8');
  if (v.startsWith('hex:')) return Buffer.from(v.slice(4), 'hex');
  throw new Error(`not a case value: ${v}`);
}

const LOC = (name: string) =>
  13 + DATA_ITEM_LOCATION_COLUMNS.indexOf(name as never);
const columnIndex = (table: string, column: string) => {
  const spec = PARQUET_L2_TABLES.find((t) => t.name === table)!;
  const i = spec.columns.findIndex((c) => c.name === column);
  if (i < 0) throw new Error(`${table} has no column ${column}`);
  return i;
};
const sha = (label: string) =>
  crypto.createHash('sha256').update(label).digest();

/**
 * A band's rows: one item directly in its root, one in a nested bundle
 * that `parents` describes; Arweave-signed (type 1) layout.
 */
function baseRows(from: number, label: string): Record<string, unknown[][]> {
  const [root, nested] = [`${label}-root`, `${label}-nested`].map(sha);
  const [a, b] = [`${label}-a`, `${label}-b`].map(sha);
  const key = Buffer.concat([sha(`${label}-key`), Buffer.alloc(480, 7)]);
  const owner = crypto.createHash('sha256').update(key).digest();
  const at = (rpo: number, offset: number, size: number, payload: number) => [
    rpo,
    offset,
    size,
    offset + size - payload,
    offset + 514,
    512,
    offset + 2,
    512,
  ];
  const item = (id: Buffer, parent: Buffer, place: unknown[], ds: number) => [
    id,
    from + 1,
    0,
    root,
    parent,
    owner,
    null,
    null,
    1,
    ds,
    null,
    null,
    1,
    ...place,
  ];
  return {
    data_items: [
      item(a, root, at(0, 0, 1200, 100), 100),
      item(b, nested, at(3500, 0, 1300, 200), 200),
    ],
    tags: [
      [from + 1, a, 0, Buffer.from('App-Name'), Buffer.from('ArDrive-App')],
      [from + 1, b, 0, Buffer.from('App-Name'), Buffer.from('ArDrive-Web')],
    ],
    wallets: [[owner, key]],
    parents: [[nested, root, 0, 2400, 4000, 3500]],
  };
}

/** A tamper of a band's rows before they are written. */
type RowOp =
  | { op: 'set'; table: string; row: number; column: string; value: CaseValue }
  | { op: 'push'; table: string; values: CaseValue[] }
  | { op: 'pushNull'; table: string }
  | { op: 'clear'; table: string }
  | { op: 'unlocate'; row: number | 'all' }
  | { op: 'moreDirect'; count: number }
  | { op: 'moreNested'; count: number };

function applyRowOp(
  rows: Record<string, unknown[][]>,
  op: RowOp,
  from: number,
) {
  switch (op.op) {
    case 'set':
      rows[op.table][op.row][columnIndex(op.table, op.column)] = value(
        op.value,
      );
      return;
    case 'push':
      rows[op.table].push(op.values.map(value));
      return;
    case 'pushNull':
      rows[op.table].push(rows[op.table][0].map(() => null));
      return;
    case 'clear':
      rows[op.table] = [];
      return;
    case 'unlocate':
      for (const [i, row] of rows.data_items.entries()) {
        if (op.row !== 'all' && op.row !== i) continue;
        for (const name of DATA_ITEM_LOCATION_COLUMNS) row[LOC(name)] = null;
      }
      if (op.row === 'all') rows.parents = [];
      return;
    case 'moreNested': {
      // More items in the nested bundle, each at its own offset in it.
      const nestedItem = rows.data_items[1];
      for (let i = 0; i < op.count; i += 1) {
        const copy = [...nestedItem];
        copy[0] = sha(`nested-${from}-${i}`);
        const off = 10_000 * (i + 1);
        copy.splice(
          LOC('root_parent_offset'),
          8,
          3500,
          off,
          1300,
          off + 1100,
          off + 514,
          512,
          off + 2,
          512,
        );
        rows.data_items.push(copy);
        rows.tags.push([
          from + 1,
          copy[0],
          0,
          Buffer.from('App-Name'),
          Buffer.from('ArDrive-Web'),
        ]);
      }
      return;
    }
    case 'moreDirect': {
      // More items directly in the root, each at its own offset.
      const direct = rows.data_items[0];
      for (let i = 0; i < op.count; i += 1) {
        const copy = [...direct];
        copy[0] = sha(`more-${from}-${i}`);
        const off = 10_000 * (i + 1);
        copy.splice(
          LOC('root_parent_offset'),
          8,
          0,
          off,
          1200,
          off + 1100,
          off + 514,
          512,
          off + 2,
          512,
        );
        rows.data_items.push(copy);
        rows.tags.push([
          from + 1,
          copy[0],
          0,
          Buffer.from('App-Name'),
          Buffer.from('ArDrive-App'),
        ]);
      }
      return;
    }
  }
}

function literal(v: unknown, type: string): string {
  if (v === null) return `NULL::${type}`;
  if (Buffer.isBuffer(v)) return `from_hex('${v.toString('hex')}')`;
  return `${String(v)}::${type}`;
}

/** A band spec in a case. */
interface BandSpec {
  from: number;
  to: number;
  /** `wallet`: tagged for the case's registered publisher wallet. */
  publisher?: 'default' | 'wallet';
  rows?: RowOp[];
  /** Edits to band.json after its id is taken (a lying publisher). */
  band?: Array<
    | { op: 'addRows'; table: string; delta: number }
    | { op: 'setChecks'; value: Record<string, unknown> }
  >;
}

/** The publisher the bands are tagged for, unless a case names the wallet. */
export const PUBLISHER = 'conformance-publisher-wallet-0000000000000';

async function writeBand(
  duck: Database,
  parent: string,
  spec: BandSpec,
  wallet: string,
): Promise<{ dir: string; id: string }> {
  const rows = baseRows(spec.from, `band-${spec.from}`);
  for (const op of spec.rows ?? []) applyRowOp(rows, op, spec.from);
  const staging = await fs.mkdtemp(path.join(parent, '.staging-'));
  const tables: ParquetL2Band['tables'] = {};
  for (const table of PARQUET_L2_TABLES) {
    const file = path.join(staging, table.file);
    const names = table.columns.map((c) => `"${c.name}"`).join(', ');
    const empty = rows[table.name].length === 0;
    const values = (empty ? [table.columns.map(() => null)] : rows[table.name])
      .map(
        (row) =>
          `(${row.map((v, i) => literal(v, table.columns[i].type)).join(', ')})`,
      )
      .join(', ');
    await duck.exec(
      `COPY (SELECT * FROM (VALUES ${values}) v(${names})${empty ? ' WHERE false' : ''} ORDER BY ${orderByClause(table)}) TO '${file}' (FORMAT PARQUET)`,
    );
    const digest = new RowDigest(table.columns);
    const read = (await duck.all(
      `SELECT * FROM read_parquet('${file}') ORDER BY ${orderByClause(table)}`,
    )) as Array<Record<string, unknown>>;
    for (const row of read) digest.add(table.columns.map((c) => row[c.name]));
    tables[table.name] = { rows: digest.rows, rowDigest: digest.hex() };
  }
  const band: ParquetL2Band = {
    version: 1,
    schema: 'l2-1',
    heightRange: [spec.from, spec.to],
    selection: {
      kind: 'ans104-data-items',
      tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
    },
    tables,
    lookups: await writeBandLookups(duck, staging),
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const id = l2BandId(
    band,
    bandPublisherTag(spec.publisher === 'wallet' ? wallet : PUBLISHER),
  );
  for (const op of spec.band ?? []) {
    if (op.op === 'addRows') band.tables[op.table].rows += op.delta;
    else band.checks = op.value;
  }
  await fs.writeFile(path.join(staging, BAND_FILE), serializeBandFile(band));
  const dir = path.join(parent, id);
  await fs.rename(staging, dir);
  return { dir, id };
}

/** A change to the directory once its bands are written. */
type FileOp =
  | { op: 'removeFile'; band: number; file: string }
  | { op: 'writeFile'; band: number; file: string; text: string }
  | { op: 'appendByte'; band: number; file: string }
  | { op: 'reverseFile'; band: number; file: string }
  | { op: 'sql'; band: number; file: string; select: string }
  | { op: 'supersedes'; band: number; target: number }
  | { op: 'renameId'; band: number; from: string; to: string }
  | { op: 'renameGeneration'; band: number; generation: string }
  | { op: 'symlinkElsewhere'; band: number }
  | { op: 'removeDir'; band: number }
  | { op: 'rebuild'; band: number; spec: BandSpec }
  | { op: 'editBandJson'; band: number; checks: Record<string, unknown> };

/** What a case's directory and run are made of, built. */
interface BuiltBands {
  dir: string;
  run: (seedOverride?: number) => Promise<{
    verdict: Verdict;
    failing: string[];
    publisherBound?: boolean;
    reads: number[];
    readsByRoot: Map<string, number[]>;
    drawnUniform?: number;
  }>;
}

/** A source answering every read with a header of no item here. */
function strangerSource(
  reads: number[],
  answer: 'stranger' | 'busy',
  byRoot: Map<string, number[]> = new Map(),
): RootSourceFactory {
  return (root) => ({
    read: async (offset: number, size: number) => {
      reads.push(offset);
      byRoot.set(root, [...(byRoot.get(root) ?? []), offset]);
      if (answer === 'busy') {
        throw Object.assign(new Error('busy'), { response: { status: 503 } });
      }
      const header = Buffer.alloc(size);
      header.writeUInt16LE(1, 0);
      crypto.randomBytes(512).copy(header, 2);
      return header;
    },
    close: async () => undefined,
    isOpen: () => true,
  });
}

export async function buildBandsCase(
  duck: Database,
  root: string,
  c: Case,
): Promise<BuiltBands> {
  const dir = await fs.mkdtemp(path.join(root, `${c.id}-`));
  const elsewhere = await fs.mkdtemp(path.join(root, `${c.id}-elsewhere-`));
  const key = crypto.generateKeyPairSync('ed25519');
  const keyAddress = getSolanaAddress(key.publicKey);
  const wallet = getSolanaAddress(
    crypto.generateKeyPairSync('ed25519').publicKey,
  );
  const specs = c.bands as BandSpec[];
  const bands: Array<{ dir: string; id: string }> = [];
  for (const spec of specs)
    bands.push(await writeBand(duck, dir, spec, wallet));

  // The publication, signed over the bands as written.
  const pub = c.publication as
    | {
        key?: 'right' | 'other';
        expiresAt?: string;
        issuedAt?: string;
        index?: string;
      }
    | undefined;
  let document: string | undefined;
  if (pub !== undefined) {
    const listed = [];
    for (const band of bands) {
      const files = [];
      for (const name of (await fs.readdir(band.dir))
        .filter((n) => !n.startsWith('.'))
        .sort()) {
        const bytes = await fs.readFile(path.join(band.dir, name));
        files.push({
          name,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      }
      listed.push({ id: band.id, files });
    }
    const publication: IndexPublication = {
      version: 1,
      publisher: wallet,
      sequence: 3,
      previousManifestSha256: null,
      issuedAt: pub.issuedAt ?? '2026-10-20T00:00:00Z',
      expiresAt: pub.expiresAt ?? '2099-01-01T00:00:00Z',
      indexes: [
        { name: pub.index ?? 'ardrive-l2', kind: 'parquet-l2', bands: listed },
      ],
    };
    document = serializeIndexPublication(
      signIndexPublication(publication, key.privateKey, keyAddress),
    );
  }

  // Changes after writing (and signing).
  const during: Array<{
    when: 'afterBand' | 'onTable';
    band: number;
    file?: string;
  }> = [];
  for (const op of (c.files ?? []) as Array<
    | FileOp
    | { op: 'deleteDuringRun'; band: number }
    | { op: 'deleteFileDuringRun'; band: number; file: string }
  >) {
    const band = bands[(op as { band: number }).band];
    switch (op.op) {
      case 'removeFile':
        await fs.rm(path.join(band.dir, op.file));
        break;
      case 'writeFile':
        await fs.writeFile(path.join(band.dir, op.file), op.text);
        break;
      case 'appendByte':
        await fs.appendFile(path.join(band.dir, op.file), Buffer.from([0]));
        break;
      case 'reverseFile': {
        const p = path.join(band.dir, op.file);
        const cols = (await duck.all(
          `DESCRIBE SELECT * FROM read_parquet('${p}')`,
        )) as Array<{ column_name: string }>;
        await duck.exec(
          `COPY (SELECT * FROM read_parquet('${p}') ORDER BY ${cols.map((col) => `"${col.column_name}" DESC`).join(', ')}) TO '${p}.x' (FORMAT PARQUET)`,
        );
        await fs.rename(`${p}.x`, p);
        break;
      }
      case 'sql': {
        const p = path.join(band.dir, op.file);
        await duck.exec(
          `COPY (SELECT ${op.select} FROM read_parquet('${p}')) TO '${p}.x' (FORMAT PARQUET)`,
        );
        await fs.rename(`${p}.x`, p);
        break;
      }
      case 'supersedes':
        await fs.writeFile(
          path.join(band.dir, '.publisher.json'),
          JSON.stringify({ supersedes: [bands[op.target].id] }),
        );
        break;
      case 'renameId': {
        const to = path.join(dir, band.id.replace(op.from, op.to));
        await fs.rename(band.dir, to);
        bands[op.band] = { dir: to, id: path.basename(to) };
        break;
      }
      case 'renameGeneration': {
        const to = path.join(dir, `${band.id}~${op.generation}`);
        await fs.rename(band.dir, to);
        bands[op.band] = { dir: to, id: band.id };
        break;
      }
      case 'symlinkElsewhere': {
        const to = path.join(elsewhere, band.id);
        await fs.rename(band.dir, to);
        await fs.symlink(to, band.dir);
        break;
      }
      case 'removeDir':
        await fs.rm(band.dir, { recursive: true });
        break;
      case 'rebuild': {
        await fs.rm(band.dir, { recursive: true });
        bands[op.band] = await writeBand(duck, dir, op.spec, wallet);
        break;
      }
      case 'editBandJson': {
        const file = path.join(band.dir, BAND_FILE);
        const parsed = JSON.parse(
          await fs.readFile(file, 'utf8'),
        ) as ParquetL2Band;
        parsed.checks = op.checks;
        await fs.writeFile(file, serializeBandFile(parsed));
        break;
      }
      case 'deleteDuringRun':
        during.push({ when: 'afterBand', band: op.band });
        break;
      case 'deleteFileDuringRun':
        during.push({ when: 'onTable', band: op.band, file: op.file });
        break;
    }
  }

  const options = (c.options ?? {}) as {
    from?: number;
    to?: number;
    publisher?: boolean;
    lookups?: boolean;
    maxUnlocatedShare?: number;
    allowUnlocated?: boolean;
    allowExpired?: boolean;
    onchain?: {
      perBand: number;
      source: 'stranger' | 'busy';
      seed?: number;
      maxUnchecked?: number;
    };
    l1?: {
      required: boolean;
      bands: Array<{
        from: number;
        to: number;
        roots: Array<{ band: number; height: number; bti: number }>;
      }>;
    };
  };
  let l1Dir: string | undefined;
  if (options.l1 !== undefined) {
    l1Dir = await fs.mkdtemp(path.join(root, `${c.id}-l1-`));
    for (const l1 of options.l1.bands) {
      await writeL1Band(
        l1Dir,
        l1.from,
        l1.to,
        l1.roots.map((r) => ({
          id: sha(`band-${specs[r.band].from}-root`),
          height: r.height,
          blockTransactionIndex: r.bti,
        })),
      );
    }
  }

  return {
    dir,
    run: async (seedOverride) => {
      const reads: number[] = [];
      const readsByRoot = new Map<string, number[]>();
      const stream = duck.stream.bind(duck);
      for (const d of during.filter((x) => x.when === 'onTable')) {
        const target = bands[d.band];
        (duck as unknown as { stream: typeof duck.stream }).stream = (
          sql: string,
          ...rest: unknown[]
        ) => {
          if (sql.includes(target.dir) && sql.includes(d.file!)) {
            rmSync(path.join(target.dir, d.file!), { force: true });
          }
          return stream(sql, ...rest);
        };
      }
      try {
        const result = await verifyL2Bands(duck, dir, {
          ...(options.from !== undefined ? { from: options.from } : {}),
          ...(options.to !== undefined ? { to: options.to } : {}),
          ...(options.publisher === true ? { publisher: PUBLISHER } : {}),
          ...(options.lookups === false ? { lookups: false } : {}),
          ...(options.maxUnlocatedShare !== undefined
            ? { maxUnlocatedShare: options.maxUnlocatedShare }
            : {}),
          ...(options.allowUnlocated === true ? { allowUnlocated: true } : {}),
          ...(document !== undefined
            ? {
                publication: {
                  document,
                  publisherKey:
                    pub?.key === 'other'
                      ? getSolanaAddress(
                          crypto.generateKeyPairSync('ed25519').publicKey,
                        )
                      : keyAddress,
                  ...(options.allowExpired === true
                    ? { allowExpired: true }
                    : {}),
                },
              }
            : {}),
          ...(l1Dir !== undefined
            ? { l1: { bandsDir: l1Dir, required: options.l1!.required } }
            : {}),
          ...(options.onchain !== undefined
            ? {
                onchain: {
                  perBand: options.onchain.perBand,
                  openRoot: strangerSource(
                    reads,
                    options.onchain.source,
                    readsByRoot,
                  ),
                  concurrency: 1,
                  ...(seedOverride !== undefined ||
                  options.onchain.seed !== undefined
                    ? { seed: seedOverride ?? options.onchain.seed }
                    : {}),
                  ...(options.onchain.maxUnchecked !== undefined
                    ? { maxUnchecked: options.onchain.maxUnchecked }
                    : {}),
                },
              }
            : {}),
          progress: (done) => {
            for (const d of during.filter((x) => x.when === 'afterBand')) {
              if (done === d.band) {
                rmSync(bands[d.band].dir, { recursive: true, force: true });
              }
            }
          },
        });
        const failing = result.checks.filter((x) => !x.ok).map((x) => x.name);
        const onlyInconclusive =
          failing.length === 1 &&
          failing[0] === 'onchain' &&
          (result.onchain?.inconclusiveBands.length ?? 0) > 0 &&
          (result.onchain?.wrong ?? 0) === 0;
        return {
          verdict: result.ok
            ? 'verified'
            : onlyInconclusive
              ? 'unknown'
              : 'refuted',
          failing,
          publisherBound: result.publisherBound,
          reads,
          readsByRoot,
          ...(result.onchain !== undefined && result.onchain.bands.length > 0
            ? { drawnUniform: result.onchain.bands[0].drawnUniform }
            : {}),
        };
      } catch (error) {
        if (error instanceof L2BandsRefused) {
          return {
            verdict: 'refuted',
            failing: ['refused'],
            reads,
            readsByRoot,
          };
        }
        throw error;
      } finally {
        (duck as unknown as { stream: typeof duck.stream }).stream = stream;
      }
    },
  };
}

// -------------------------------------------------------------- onchain --

const arweave = Arweave.init({});
const START = 40_000_000_000_000n;
const BLOCK = 'B'.repeat(64);

let walletPromise: Promise<JWKInterface> | undefined;
/** One RSA key per run: generating them is slow, and signatures are salted anyway. */
const runWallet = () => (walletPromise ??= arweave.wallets.generate());

/** A root of an on-chain case, built. */
interface Root {
  id: string;
  header: Record<string, unknown>;
  data: Buffer;
  chunks: Array<{ min: number; max: number; chunk: Buffer; dataPath: Buffer }>;
  start: bigint;
  height: number;
  items: BandSampleEntry[];
}

/** What a node answers for one kind of request. */
type Answer =
  | 'honest'
  | '404'
  | '503'
  | 'timeout'
  | 'reset'
  | 'resetOnce'
  | '503Twice'
  | 'otherHeader'
  | 'format1'
  | 'malformed'
  | 'wrongSize'
  | 'badproof'
  | 'hang'
  | `status:height=${number}`;

type NodeScript = {
  default?: Answer;
} & Partial<
  Record<'header' | 'status' | 'offset' | 'chunk', Record<string, Answer>>
>;

async function chunksOf(
  tx: Awaited<ReturnType<typeof arweave.createTransaction>>,
  data: Buffer,
) {
  await tx.prepareChunks(data);
  return tx.chunks!.chunks.map((c, i) => {
    const got = tx.getChunk(i, data);
    return {
      min: c.minByteRange,
      max: c.maxByteRange,
      chunk: Buffer.from(got.chunk, 'base64url'),
      dataPath: Buffer.from(got.data_path, 'base64url'),
    };
  });
}

async function buildRoot(
  symbol: string,
  kind: { transfer?: boolean; format1Injected?: boolean; height?: number },
  index: number,
): Promise<Root> {
  const jwk = await runWallet();
  const signer = new ArweaveSigner(jwk as never);
  const bundle = await bundleAndSignData(
    [createData(`${symbol}-one`, signer), createData(`${symbol}-two`, signer)],
    signer,
  );
  const data = Buffer.from(bundle.getRaw());
  const start = START + BigInt(index) * 10_000_000n;
  const height = kind.height ?? 1000;
  const helper = await arweave.createTransaction(
    { data, last_tx: '', reward: '0' },
    jwk,
  );
  const chunks = await chunksOf(helper, data);
  let tx = helper;
  let header: Record<string, unknown>;
  if (kind.transfer === true) {
    tx = await arweave.createTransaction(
      { target: 'x'.repeat(43), quantity: '1', last_tx: '', reward: '0' },
      jwk,
    );
    await arweave.transactions.sign(tx, jwk);
    header = tx.toJSON() as unknown as Record<string, unknown>;
  } else if (kind.format1Injected === true) {
    tx = await arweave.createTransaction(
      {
        format: 1,
        target: 'x'.repeat(43),
        quantity: '1',
        last_tx: '',
        reward: '0',
      } as never,
      jwk,
    );
    await arweave.transactions.sign(tx, jwk);
    header = tx.toJSON() as unknown as Record<string, unknown>;
    header.data_root = helper.data_root;
    header.data_size = String(data.length);
  } else {
    await arweave.transactions.sign(tx, jwk);
    header = tx.toJSON() as unknown as Record<string, unknown>;
    header.data = '';
  }
  const items: BandSampleEntry[] = [];
  for await (const item of scanBundle({
    source: new BufferByteRangeSource(data),
    rootTxId: tx.id,
    bundleSize: data.length,
  })) {
    items.push({
      id: item.id,
      rootTxId: tx.id,
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
      height,
    });
  }
  return { id: tx.id, header, data, chunks, start, height, items };
}

const json = (code: number, body: unknown) =>
  Promise.resolve({ status: code, ok: code === 200, json: async () => body });

/** Nodes answering as their scripts say, over the case's roots. */
function scriptedNodes(
  roots: Map<string, Root>,
  scripts: Record<string, NodeScript>,
): FetchLike {
  const counters = new Map<string, number>();
  const symbolOf = new Map([...roots].map(([s, r]) => [r.id, s]));
  return async (url, init) => {
    const u = new URL(url);
    const host = u.host;
    const script = scripts[host] ?? {};
    const [, kind, a, b] = u.pathname.split('/');
    let requestKind: 'header' | 'status' | 'offset' | 'chunk';
    let root: Root | undefined;
    let symbol = '';
    if (kind === 'tx') {
      requestKind =
        b === 'status' ? 'status' : b === 'offset' ? 'offset' : 'header';
      symbol = symbolOf.get(a) ?? '';
      root = roots.get(symbol);
    } else {
      requestKind = 'chunk';
      const abs = BigInt(a);
      for (const [s, r] of roots) {
        if (abs >= r.start && abs < r.start + BigInt(r.data.length)) {
          root = r;
          symbol = s;
        }
      }
    }
    const answer: Answer =
      script[requestKind]?.[symbol] ??
      script[requestKind]?.['*'] ??
      script.default ??
      'honest';
    const count = (counters.get(`${host}:${requestKind}`) ?? 0) + 1;
    counters.set(`${host}:${requestKind}`, count);
    if (answer === 'timeout') {
      throw new DOMException('timed out', 'TimeoutError');
    }
    if (answer === 'hang') {
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(init.signal.reason as Error),
        ),
      );
    }
    if (answer === 'reset' || (answer === 'resetOnce' && count === 1)) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNRESET' },
      });
    }
    if (answer === '503' || (answer === '503Twice' && count <= 2)) {
      return json(503, {});
    }
    if (answer === '404' || root === undefined) return json(404, {});
    switch (requestKind) {
      case 'header':
        if (answer === 'otherHeader') {
          return json(200, {
            ...root.header,
            signature: crypto.randomBytes(512).toString('base64url'),
          });
        }
        if (answer === 'format1')
          return json(200, { ...root.header, format: 1 });
        return json(200, root.header);
      case 'status': {
        const m = /^status:height=(\d+)$/.exec(answer);
        return json(200, {
          block_indep_hash: BLOCK,
          block_height: m !== null ? Number(m[1]) : root.height,
          number_of_confirmations: 50,
        });
      }
      case 'offset':
        if (answer === 'malformed') return json(200, { error: 'x' });
        return json(200, {
          offset: String(root.start + BigInt(root.data.length) - 1n),
          size: String(root.data.length + (answer === 'wrongSize' ? 1 : 0)),
        });
      case 'chunk': {
        const rel = Number(BigInt(a) - root.start);
        const c = root.chunks.find((x) => rel >= x.min && rel < x.max);
        if (c === undefined) return json(404, {});
        const dataPath = Buffer.from(c.dataPath);
        if (answer === 'badproof') dataPath[0] ^= 1;
        return json(200, {
          chunk: c.chunk.toString('base64url'),
          data_path: dataPath.toString('base64url'),
          packing: 'unpacked',
        });
      }
    }
  };
}

/** An entry spec in an on-chain case. */
interface EntrySpec {
  root: string;
  /** A real item of the root (by index), or a made-up id at its offsets. */
  fabricated?: boolean;
  /** A made-up root id altogether. */
  madeUp?: boolean;
  /** A header range that runs past the root's end. */
  pastEnd?: boolean;
  height?: number;
  repeat?: number;
}

export async function runOnchainCase(c: Case): Promise<{
  verdict: Verdict;
  failing: string[];
  reason: string[];
}> {
  const rootSpecs = (c.roots ?? {}) as Record<
    string,
    { transfer?: boolean; format1Injected?: boolean; height?: number }
  >;
  const roots = new Map<string, Root>();
  let index = 0;
  for (const [symbol, spec] of Object.entries(rootSpecs)) {
    roots.set(symbol, await buildRoot(symbol, spec, index));
    index += 1;
  }
  const entries: BandSampleEntry[] = [];
  for (const spec of c.entries as EntrySpec[]) {
    for (let i = 0; i < (spec.repeat ?? 1); i += 1) {
      if (spec.madeUp === true) {
        entries.push({
          id: crypto.randomBytes(32).toString('base64url'),
          rootTxId: crypto.randomBytes(32).toString('base64url'),
          rootOffset: 0,
          rootDataOffset: 1100,
          height: spec.height ?? 1000,
        });
        continue;
      }
      const root = roots.get(spec.root)!;
      const item =
        root.items.length > 0
          ? root.items[i % root.items.length]
          : {
              id: '',
              rootTxId: root.id,
              rootOffset: 0,
              rootDataOffset: 1100,
            };
      entries.push({
        ...item,
        ...(spec.fabricated === true || root.items.length === 0
          ? { id: crypto.randomBytes(32).toString('base64url') }
          : {}),
        ...(spec.pastEnd === true
          ? {
              rootOffset: root.data.length - 100,
              rootDataOffset: root.data.length + 1000,
            }
          : {}),
        rootTxId: root.id,
        height: spec.height ?? root.height,
      });
    }
  }
  const options = (c.options ?? {}) as {
    maxUnchecked?: number;
    deadlineMs?: number;
    allowAgreement?: boolean;
    timeoutMs?: number;
  };
  const nodes = c.nodes as Record<string, NodeScript>;
  const addresses = c.addresses as Record<string, string[]> | undefined;
  const pool = new ArweaveNodePool({
    urls: Object.keys(nodes).map((n) => `http://${n}`),
    fetch: scriptedNodes(roots, nodes),
    dedupeByAddress: addresses !== undefined,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(addresses !== undefined
      ? {
          lookupAll: async (host: string) => addresses[host] ?? [],
        }
      : {}),
  });
  const result = await checkDrawnHeaders({
    entries,
    openRoot: onChainRootSource({
      pool,
      ...(options.allowAgreement === true ? { allowAgreement: true } : {}),
    }).openRoot,
    concurrency: 1,
    retries: 0,
    retryDelayMs: 1,
    ...(options.maxUnchecked !== undefined
      ? { maxUnchecked: options.maxUnchecked }
      : {}),
    ...(options.deadlineMs !== undefined
      ? { deadlineMs: options.deadlineMs }
      : {}),
  });
  const kinds = [
    ...new Set(
      result.wrong.map((w) =>
        w.missing === true
          ? 'missing'
          : /^offsets run past the end/.test(w.reason)
            ? 'past-end'
            : /^its root .* is refuted/.test(w.reason)
              ? 'refuted'
              : 'not-the-item',
      ),
    ),
  ].sort();
  const verdict: Verdict = result.passed
    ? 'verified'
    : result.wrong.length > 0
      ? 'refuted'
      : 'unknown';
  return {
    verdict,
    failing: result.passed ? [] : ['onchain'],
    reason:
      verdict === 'refuted'
        ? kinds
        : verdict === 'unknown'
          ? [
              result.drawn === 0
                ? 'nothing-drawn'
                : result.ok === 0 &&
                    result.unchecked.length <= (options.maxUnchecked ?? 0)
                  ? 'nothing-verified'
                  : 'unchecked',
            ]
          : [],
  };
}

/** A scratch directory for a run of the suite. */
export const scratch = () =>
  fs.mkdtemp(path.join(os.tmpdir(), 'index-verification-conformance-'));
