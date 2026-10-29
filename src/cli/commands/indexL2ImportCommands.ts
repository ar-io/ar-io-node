/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l2-import`: load verified `parquet-l2` bands (an L2 index such as
 * `ardrive-l2`) into this gateway's index, so its GraphQL answers for their
 * data items without unbundling them.
 *
 * `--target clickhouse` verifies each band as `index-l2-verify` does, bound
 * to a signed publication, its roots found in the L1 index and a sample of
 * its items read on chain, then writes a job of the rows ClickHouse lacks
 * for `clickhouse-auto-import` to load (`import-clickhouse.ts`). Nothing is
 * written for a band that fails any check.
 *
 * `--forget <band>` removes what an import of that band wrote.
 *
 * See `docs/cli.md` and the design in the knowledge base
 * (`index-layer/design-l2-import.md`).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';
import { Logger } from 'winston';

import { type GatewayRegistry } from '../../index-swarm/gateway-registry.js';
import type { RootSourceFactory } from '../../lib/index-band/verify.js';
import {
  ArweaveNodePool,
  DEFAULT_ARWEAVE_NODE_URLS,
} from '../../lib/onchain/arweave-nodes.js';
import { onChainRootSource } from '../../lib/onchain/root-source.js';
import {
  type ClickHouseForget,
  type ClickHouseHeld,
  httpClickHouseForget,
  httpClickHouseHeld,
} from '../../lib/parquet-l2/clickhouse-held.js';
import {
  bandIndexedAt,
  type L2ImportBlock,
  type L2ImportBlockSource,
  type L2ImportJob,
  JOB_FILE,
  L2ImportRefused,
  PARTIAL_DIR,
  WRITTEN_FILE,
  writeClickHouseJob,
} from '../../lib/parquet-l2/import-clickhouse.js';
import {
  assertL2LedgerMigrated,
  DONE_DIR,
  FAILED_DIR,
  FORGOTTEN_DIR,
  QUEUE_DIR,
  readLedger,
  recordNothingToWrite,
  recordQueued,
  reconcileJobs,
} from '../../lib/parquet-l2/import-ledger.js';
import {
  bandTablesDigest,
  idHeightRange,
} from '../../lib/parquet-l2/layout.js';
import {
  forgetSqliteBand,
  importBandIntoSqlite,
} from '../../lib/parquet-l2/import-sqlite.js';
import {
  liveL2Bands,
  readL2BandsDir,
  verifyL2Bands,
  type L2BandOnDisk,
} from '../../lib/parquet-l2/verify-bands.js';
import { parseDuckdbThreads } from '../../lib/duckdb-threads.js';
import type { IndexL2ImportCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';
import { openBandsDuck } from './indexL1VerifyCommands.js';
import {
  DEFAULT_BAND_DEADLINE_SECONDS,
  DEFAULT_ONCHAIN_PER_BAND,
  l1Index,
  urlList,
} from './indexL2VerifyCommands.js';
import { resolvePublication } from './index-publication-options.js';

/** Jobs waiting in the queue before a run writes no more. */
export const DEFAULT_MAX_QUEUED = 2;

/** Where DuckDB spills and scratch files go: the gateway's temp volume. */
export const DEFAULT_TMP_DIR = 'data/tmp';

export interface IndexL2ImportDeps {
  log: Logger;
  env?: Record<string, string | undefined>;
  /** Injected in tests: what ClickHouse holds. */
  held?: ClickHouseHeld;
  /** Injected in tests: how --forget deletes. */
  forget?: ClickHouseForget;
  /** Injected in tests: where root bytes are read from. */
  openRoot?: RootSourceFactory;
  /** Injected in tests: the registry `--registry-url` reads. */
  registry?: GatewayRegistry;
  /** Injected in tests: the bytes free under the spill directory. */
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => Date;
}

const whole = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new L2ImportRefused(`${flag} must be a whole number, 0 or above`);
  }
  return n;
};

const fraction = (
  value: string | undefined,
  flag: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new L2ImportRefused(`${flag} must be a number from 0 to 1`);
  }
  return n;
};

const nonEmpty = (v: string | undefined) =>
  v === undefined || v === '' ? undefined : v;

/** Blocks from this gateway's `core.db`, read-only. */
export function coreDbBlocks(db: Sqlite.Database): L2ImportBlockSource {
  const select = db.prepare(
    `SELECT indep_hash, height, previous_block, nonce, hash, block_timestamp, tx_count, block_size
     FROM stable_blocks WHERE height BETWEEN ? AND ? ORDER BY height`,
  );
  return {
    *blocks(from: number, to: number): Iterable<L2ImportBlock> {
      for (const r of select.iterate(from, to) as IterableIterator<{
        indep_hash: Buffer;
        height: number;
        previous_block: Buffer | null;
        nonce: Buffer;
        hash: Buffer;
        block_timestamp: number;
        tx_count: number;
        block_size: number | null;
      }>) {
        yield {
          indepHash: r.indep_hash,
          height: r.height,
          previousBlock: r.previous_block,
          nonce: r.nonce,
          hash: r.hash,
          blockTimestamp: r.block_timestamp,
          txCount: r.tx_count,
          blockSize: r.block_size,
        };
      }
    },
  };
}

/** The allow flags a run accepted bands with, as the ledger records them. */
function acceptedFlags(options: IndexL2ImportCLIOptions): string[] {
  return [
    ...(options.allowUnlocated === true ? ['--allow-unlocated'] : []),
    ...(options.maxUnlocatedShare !== undefined
      ? [`--max-unlocated-share=${options.maxUnlocatedShare}`]
      : []),
    ...(options.maxUnchecked !== undefined
      ? [`--max-unchecked=${options.maxUnchecked}`]
      : []),
    ...(options.allowAgreement === true ? ['--allow-agreement'] : []),
    ...(options.allowExpired === true ? ['--allow-expired'] : []),
  ];
}

export async function indexL2ImportCLICommand(
  options: IndexL2ImportCLIOptions,
  deps: IndexL2ImportDeps,
): Promise<JsonSerializable> {
  const { log } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const target = options.target;
  if (target !== 'clickhouse' && target !== 'sqlite') {
    throw new L2ImportRefused('--target must be clickhouse or sqlite');
  }
  const bandsDir = requiredStringFromOptions(options, 'bandsDir');
  const bundlesDbPath = options.bundlesDb ?? 'data/sqlite/bundles.db';
  if (target === 'sqlite') {
    return importIntoSqlite({
      options,
      deps,
      bandsDir,
      bundlesDbPath,
      env,
    });
  }
  // Where clickhouse-auto-import looks: ETL_STAGING_PATH/l2-import. Unset
  // in the core container (both containers mount the host path at
  // data/etl/staging), set by .env under `yarn start`.
  const jobsDir =
    options.jobsDir ??
    path.join(
      nonEmpty(env.ETL_STAGING_PATH) ?? 'data/etl/staging',
      'l2-import',
    );
  const index = path.basename(path.resolve(bandsDir));

  const clickhouseUrl = nonEmpty(env.CLICKHOUSE_URL);
  if (clickhouseUrl === undefined && deps.held === undefined) {
    throw new L2ImportRefused(
      "CLICKHOUSE_URL is not set: --target clickhouse writes this gateway's ClickHouse",
    );
  }
  const credentials = {
    url: clickhouseUrl ?? '',
    username: nonEmpty(env.CLICKHOUSE_USER) ?? 'default',
    password: env.CLICKHOUSE_PASSWORD ?? '',
  };

  const db = new Sqlite(bundlesDbPath, { fileMustExist: true });
  let lock: Sqlite.Database | undefined;
  try {
    db.pragma('busy_timeout = 60000');
    assertL2LedgerMigrated(db);
    lock = await takeL2ImportLock(jobsDir);
    // No other import runs now, so whatever a killed one left is garbage.
    for (const left of await sweepLeftovers(
      jobsDir,
      options.tmpDir ?? DEFAULT_TMP_DIR,
    )) {
      log.warn('Removed what an interrupted import left', { path: left });
    }
    if (options.forget !== undefined) {
      return await forgetBand({
        db,
        bandId: options.forget,
        jobsDir,
        tmpDir: options.tmpDir ?? DEFAULT_TMP_DIR,
        forget: deps.forget ?? httpClickHouseForget(credentials),
        log,
      });
    }
    return await importBands({
      options,
      deps,
      db,
      bandsDir,
      index,
      jobsDir,
      held: deps.held ?? httpClickHouseHeld(credentials),
      env,
      now,
    });
  } finally {
    lock?.close();
    db.close();
  }
}

/**
 * `--target sqlite`, with `--forget`: one run at a time per `bundles.db`,
 * holding the lock file beside it.
 */
async function importIntoSqlite({
  options,
  deps,
  bandsDir,
  bundlesDbPath,
  env,
}: {
  options: IndexL2ImportCLIOptions;
  deps: IndexL2ImportDeps;
  bandsDir: string;
  bundlesDbPath: string;
  env: Record<string, string | undefined>;
}): Promise<JsonSerializable> {
  if (nonEmpty(env.CLICKHOUSE_URL) !== undefined) {
    // clickhouse-auto-import moves stable data items out of SQLite and
    // prunes them, and never exports heights below its own: rows imported
    // here would be neither shown from ClickHouse nor kept.
    throw new L2ImportRefused(
      'CLICKHOUSE_URL is set: this gateway keeps its stable data items in ClickHouse, so import with --target clickhouse',
    );
  }
  const index = path.basename(path.resolve(bandsDir));
  const db = new Sqlite(bundlesDbPath, { fileMustExist: true });
  let lock: Sqlite.Database | undefined;
  try {
    db.pragma('busy_timeout = 60000');
    assertL2LedgerMigrated(db);
    lock = await takeL2ImportLock(path.dirname(path.resolve(bundlesDbPath)));
    if (options.forget !== undefined) {
      return await forgetBandSqlite({
        db,
        bandId: options.forget,
        bandsDir,
        log: deps.log,
      });
    }
    return await importBandsSqlite({
      options,
      deps,
      db,
      bundlesDbPath,
      bandsDir,
      index,
      env,
    });
  } finally {
    lock?.close();
    db.close();
  }
}

/**
 * Refuses an import or forget while another runs on the same jobs
 * directory: two would queue the same band, and one could remove the
 * other's half-written job. As `takeImportLock` does for the L1 import, the
 * lock is an exclusive transaction on a small SQLite file: the kernel's
 * lock, held across containers sharing the directory and released however
 * the process exits.
 */
export async function takeL2ImportLock(
  jobsDir: string,
): Promise<Sqlite.Database> {
  await fsp.mkdir(jobsDir, { recursive: true });
  const lock = new Sqlite(path.join(jobsDir, '.l2-import.lock'), {
    timeout: 0,
  });
  try {
    lock.pragma('locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw new L2ImportRefused(
      `another index-l2-import is running on ${jobsDir} (${(error as Error).message})`,
    );
  }
  return lock;
}

/**
 * Removes the half-written jobs (`<jobs>/.partial/*`) and scratch folders
 * (`<tmp>/*.scratch`) a killed run left. Only called holding the lock.
 */
export async function sweepLeftovers(
  jobsDir: string,
  tmpDir: string,
): Promise<string[]> {
  const removed: string[] = [];
  const sweep = async (dir: string, match: (name: string) => boolean) => {
    for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!match(name)) continue;
      const target = path.join(dir, name);
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(target);
    }
  };
  await sweep(path.join(jobsDir, PARTIAL_DIR), () => true);
  await sweep(
    tmpDir,
    (name) => name.startsWith('l2-') && name.endsWith('.scratch'),
  );
  return removed;
}

/** A run's limits and verification settings, parsed once for either target. */
interface RunSettings {
  maxBands: number | undefined;
  perBand: number;
  timeoutMs: number;
  seed: number | undefined;
  maxUnchecked: number | undefined;
  maxUnlocatedShare: number | undefined;
  deadlineSeconds: number;
  threads: number;
}

function parseRunSettings(options: IndexL2ImportCLIOptions): RunSettings {
  const maxBands = whole(options.maxBands, '--max-bands');
  const perBand =
    whole(options.onchain, '--onchain') ?? DEFAULT_ONCHAIN_PER_BAND;
  if (perBand === 0) {
    throw new L2ImportRefused(
      '--onchain 0 is refused: an import reads a sample of every band on chain',
    );
  }
  const timeoutMs = whole(options.readTimeout, '--read-timeout') ?? 30000;
  const seed = whole(options.seed, '--seed');
  const maxUnchecked = whole(options.maxUnchecked, '--max-unchecked');
  if (maxUnchecked !== undefined && maxUnchecked >= perBand) {
    throw new L2ImportRefused(
      `--max-unchecked must be below --onchain (${perBand}): a band must have items verified to pass`,
    );
  }
  const maxUnlocatedShare = fraction(
    options.maxUnlocatedShare,
    '--max-unlocated-share',
  );
  const deadlineSeconds =
    whole(options.bandDeadline, '--band-deadline') ??
    DEFAULT_BAND_DEADLINE_SECONDS;
  if (deadlineSeconds === 0) {
    throw new L2ImportRefused('--band-deadline must be 1 or above');
  }
  let threads: number;
  try {
    threads = parseDuckdbThreads(options.duckdbThreads);
  } catch (error) {
    throw new L2ImportRefused((error as Error).message);
  }
  return {
    maxBands,
    perBand,
    timeoutMs,
    seed,
    maxUnchecked,
    maxUnlocatedShare,
    deadlineSeconds,
    threads,
  };
}

/** The bands live in `bandsDir`, refusing a directory with anything else. */
async function liveBandsIn(bandsDir: string): Promise<L2BandOnDisk[]> {
  const listing = await readL2BandsDir(bandsDir);
  if (listing.problems.length > 0) {
    throw new L2ImportRefused(
      `the bands directory holds entries that are not bands: ${listing.problems
        .slice(0, 3)
        .map((p) => `${p.entry} (${p.problem})`)
        .join('; ')}`,
    );
  }
  return liveL2Bands(listing.bands).live;
}

/** A band refused before anything of it was written. */
interface BandRefusal {
  band: string;
  reason: string;
  kind: 'refused' | 'unreadable';
  checks: Array<{ name: string; detail: string }>;
  onchain?: unknown;
}

/** What a run verifies bands with; {@link openVerifier} makes one. */
interface BandVerifier {
  duck: Database;
  /**
   * Verifies one band: its publisher when it passes, or why it is refused.
   * Logs either way.
   */
  verify(
    b: L2BandOnDisk,
  ): Promise<{ publisher: string } | { refusal: BandRefusal }>;
  /** Where the on-chain sample was read, for a refused run's result. */
  describeSource(): Record<string, unknown>;
  close(): Promise<void>;
}

/**
 * Everything a run needs to verify bands: the publication, the L1 index,
 * the on-chain sample's source and a DuckDB session. Verification is the
 * same for every target, so a band either target writes has passed the
 * same checks.
 */
async function openVerifier({
  options,
  deps,
  bandsDir,
  settings,
  tmpDir,
  env,
}: {
  options: IndexL2ImportCLIOptions;
  deps: IndexL2ImportDeps;
  bandsDir: string;
  settings: RunSettings;
  tmpDir: string;
  env: Record<string, string | undefined>;
}): Promise<BandVerifier> {
  const { log } = deps;
  const publication = await resolvePublication(
    options,
    { log, timeoutMs: settings.timeoutMs, registry: deps.registry },
    L2ImportRefused,
  );
  if (publication === undefined) {
    throw new L2ImportRefused(
      '--publication is required: an import writes only bands bound to a signed publication',
    );
  }
  const l1 = await l1Index(bandsDir, options.l1BandsDir);
  if (l1 === undefined) {
    throw new L2ImportRefused(
      "no L1 index to find the bands' roots in (--l1-bands-dir, or data/indexes/installed/parquet-l1): an import writes only bands whose roots are mined",
    );
  }
  let openRoot = deps.openRoot;
  let closeSource = () => undefined as void;
  let describeSource = () => ({}) as Record<string, unknown>;
  if (openRoot === undefined) {
    const urls = urlList(options.arweaveNodes) ?? DEFAULT_ARWEAVE_NODE_URLS;
    const pool = new ArweaveNodePool({ urls, timeoutMs: settings.timeoutMs });
    const onchain = onChainRootSource({
      pool,
      allowAgreement: options.allowAgreement === true,
    });
    openRoot = onchain.openRoot;
    describeSource = () => ({
      from: 'arweave-nodes',
      ...onchain.stats(),
      nodeFaultCount: onchain.nodeFaultCount(),
    });
    closeSource = () => {
      for (const fault of onchain.nodeFaults()) {
        log.warn('An Arweave node gave an answer that did not hold up', {
          ...fault,
        });
      }
    };
  }
  await fsp.mkdir(tmpDir, { recursive: true });
  const session = await openBandsDuck({
    prefix: 'ar-io-node-l2-import-',
    tmpRoot: tmpDir,
    threads: settings.threads,
    ...(deps.freeBytes !== undefined ? { freeBytes: deps.freeBytes } : {}),
    ...(options.spillMax !== undefined ? { spillMax: options.spillMax } : {}),
  });
  const ownWallet = nonEmpty(env.AR_IO_WALLET);
  const verifyOpenRoot = openRoot;
  return {
    duck: session.duck as Database,
    describeSource: () => describeSource(),
    close: async () => {
      closeSource();
      await session.close();
    },
    verify: async (b) => {
      const [from, to] = b.band.heightRange;
      log.info('Verifying a band before importing it', { band: b.id });
      const out = await verifyL2Bands(session.duck, bandsDir, {
        from,
        to,
        lookups: false,
        publication: {
          document: publication.document,
          publisherKey: publication.publisherKey,
          ...(publication.index !== undefined
            ? { index: publication.index }
            : {}),
          ...(publication.keyFrom !== undefined
            ? { keyFrom: publication.keyFrom }
            : {}),
          allowExpired: options.allowExpired === true,
        },
        l1: { bandsDir: l1.bandsDir, required: true },
        allowUnlocated: options.allowUnlocated === true,
        ...(settings.maxUnlocatedShare !== undefined
          ? { maxUnlocatedShare: settings.maxUnlocatedShare }
          : {}),
        onchain: {
          perBand: settings.perBand,
          openRoot: verifyOpenRoot,
          deadlineMs: settings.deadlineSeconds * 1000,
          ...(settings.maxUnchecked !== undefined
            ? { maxUnchecked: settings.maxUnchecked }
            : {}),
          ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
        },
      });
      const unchecked = out.skipped.filter((s) => s !== 'lookups');
      const reason = !out.ok
        ? 'a check failed'
        : !out.publisherBound
          ? 'not bound to the publication'
          : unchecked.length > 0
            ? `not checked: ${unchecked.join(', ')}`
            : out.bands !== 1 ||
                out.located.length !== 1 ||
                out.located[0].id !== b.id
              ? `the bands checked (${out.located.map((l) => l.id).join(', ')}) are not this band alone; its directory may have changed`
              : ownWallet !== undefined &&
                  out.publication?.publisher === ownWallet
                ? "signed by this gateway's own wallet: a publisher does not import its own export"
                : undefined;
      if (reason !== undefined) {
        const failed = out.checks
          .filter((c) => !c.ok)
          .map((c) => ({ name: c.name, detail: c.detail }));
        log.error('Import refused before writing', {
          band: b.id,
          reason,
          failed,
        });
        return {
          refusal: {
            band: b.id,
            reason,
            kind:
              out.onchain !== undefined &&
              out.onchain.inconclusiveBands.length > 0 &&
              out.onchain.failedBands.length === 0 &&
              out.checks.every((c) => c.ok || c.name === 'onchain')
                ? 'unreadable'
                : 'refused',
            checks: failed,
            onchain: out.onchain?.bands,
          },
        };
      }
      log.info('Verified a band before importing it', {
        band: b.id,
        items: out.items,
        assurance: out.assurance,
      });
      return { publisher: out.publication?.publisher ?? '' };
    },
  };
}

/**
 * A run's result, thrown (exit 1) when any band was refused. `unreadable`
 * only when every refusal is a sample that could not be read (an outage).
 */
function finishRun(
  result: Record<string, unknown>,
  refusals: BandRefusal[],
  verifier: BandVerifier,
): JsonSerializable {
  if (refusals.length > 0) {
    throw {
      ...result,
      refused: refusals.map((r) => `${r.band}: ${r.reason}`).join('; '),
      refusal: refusals.every((r) => r.kind === 'unreadable')
        ? 'unreadable'
        : 'refused',
      refusals,
      roots: verifier.describeSource(),
    };
  }
  return result as unknown as JsonSerializable;
}

async function importBands({
  options,
  deps,
  db,
  bandsDir,
  index,
  jobsDir,
  held,
  env,
  now,
}: {
  options: IndexL2ImportCLIOptions;
  deps: IndexL2ImportDeps;
  db: Sqlite.Database;
  bandsDir: string;
  index: string;
  jobsDir: string;
  held: ClickHouseHeld;
  env: Record<string, string | undefined>;
  now: () => Date;
}): Promise<JsonSerializable> {
  const { log } = deps;
  const started = Date.now();
  const coreDbPath = options.coreDb ?? 'data/sqlite/core.db';
  const tmpDir = options.tmpDir ?? DEFAULT_TMP_DIR;
  const maxQueued =
    whole(options.maxQueued, '--max-queued') ?? DEFAULT_MAX_QUEUED;
  const settings = parseRunSettings(options);

  // What auto-import did with the jobs written before.
  const reconciled = await reconcileJobs(db, jobsDir);
  for (const job of reconciled.loaded) {
    log.info('Job loaded into ClickHouse', { job });
  }
  for (const { job, reason } of reconciled.failed) {
    log.warn('Job not loaded; its band is written again later', {
      job,
      reason,
    });
  }
  if (reconciled.failed.length > 0) {
    // A job that would not load may fail the same way again: write nothing
    // this run, so the worker waits (twice as long each time) before the
    // bands are written again, rather than queueing a failing job every run.
    throw {
      bandsDir,
      index,
      target: 'clickhouse',
      imported: 0,
      jobs: [],
      loaded: reconciled.loaded,
      failed: reconciled.failed,
      refused: `${reconciled.failed.length} job(s) failed to load: ${reconciled.failed
        .map((f) => `${f.job}: ${f.reason}`)
        .join('; ')}`,
      refusal: 'refused',
    };
  }
  const room = Math.max(0, maxQueued - reconciled.waiting.length);

  const live = await liveBandsIn(bandsDir);
  const ceiling = await held.topHeight();
  if (ceiling === undefined) {
    throw new L2ImportRefused(
      "ClickHouse holds no rows: the gateway's own export fills it first, and an import goes beneath it",
    );
  }

  // The heights of every job still in the queue, read from the queue
  // itself, so a job the ledger never recorded counts too.
  const queuedRanges: Array<[number, number]> = [];
  for (const name of await fsp
    .readdir(path.join(jobsDir, QUEUE_DIR))
    .catch(() => [] as string[])) {
    const range = idHeightRange(name.slice(0, name.lastIndexOf('.')));
    if (range !== undefined) queuedRanges.push(range);
  }

  // Newest first: the heights most asked for, as the L1 import does.
  const ledger = readLedger(db, 'clickhouse');
  const pending: L2BandOnDisk[] = [];
  const aboveCeiling: string[] = [];
  const waiting: string[] = [];
  const behindQueued: string[] = [];
  let done = 0;
  for (const b of [...live].sort(
    (x, y) => y.band.heightRange[0] - x.band.heightRange[0],
  )) {
    if (b.band.heightRange[0] > ceiling) {
      aboveCeiling.push(b.id);
      continue;
    }
    const top = Math.min(b.band.heightRange[1], ceiling);
    const row = ledger.get(b.id);
    if (row !== undefined && row.bandDigest.equals(bandTablesDigest(b.band))) {
      if (row.job !== null && row.completedAt === null) {
        waiting.push(b.id);
        continue;
      }
      if (row.completedAt !== null && row.heightTo >= top) {
        done += 1;
        continue;
      }
    }
    // No job beside a queued job over the same heights (a band and its
    // replacement): it would be built before the other loads, could list
    // the same items, and its --forget would then take the other's rows.
    // It is written once the other has loaded and is held.
    const [from, to] = b.band.heightRange;
    if (queuedRanges.some(([a, z]) => a <= to && from <= z)) {
      behindQueued.push(b.id);
      continue;
    }
    pending.push(b);
  }
  const take = pending.slice(0, Math.min(room, settings.maxBands ?? room));
  const summary = {
    bandsDir,
    index,
    target: 'clickhouse',
    ceiling,
    bands: live.length,
    done,
    waiting: waiting.length,
    pending: pending.length,
    aboveCeiling,
    behindQueued,
    loaded: reconciled.loaded,
    failed: reconciled.failed,
  };
  if (take.length === 0) {
    log.info('Nothing to import now', {
      ...summary,
      queueFull: room === 0 && pending.length > 0,
    });
    return {
      ...summary,
      imported: 0,
      jobs: [],
      seconds: Math.round((Date.now() - started) / 100) / 10,
    } as unknown as JsonSerializable;
  }

  const verifier = await openVerifier({
    options,
    deps,
    bandsDir,
    settings,
    tmpDir,
    env,
  });
  const core = new Sqlite(coreDbPath, { readonly: true, fileMustExist: true });
  const accepted = acceptedFlags(options);
  const jobs: Array<Record<string, unknown>> = [];
  const refusals: BandRefusal[] = [];
  try {
    const blocks = coreDbBlocks(core);
    for (const b of take) {
      const startedAt = Math.floor(Date.now() / 1000);
      const verified = await verifier.verify(b);
      if ('refusal' in verified) {
        // Nothing of this band is written. The others are still tried: one
        // band whose sample cannot be read must not hold back the rest.
        refusals.push(verified.refusal);
        continue;
      }
      const outcome = await writeClickHouseJob({
        duck: verifier.duck,
        band: b.band,
        bandDir: b.dir,
        bandId: b.id,
        index,
        publisher: verified.publisher,
        held,
        blocks,
        ceiling,
        jobsDir,
        workDir: tmpDir,
        now: now(),
        log,
      });
      if (outcome.counts.conflicting > 0) {
        log.warn(
          'The band places items differently from the rows ClickHouse holds; the held rows are kept',
          {
            band: b.id,
            conflicting: outcome.counts.conflicting,
            examples: outcome.conflictExamples,
          },
        );
      }
      const job = outcome.job;
      if (job === undefined) {
        recordNothingToWrite(db, {
          target: 'clickhouse',
          bandId: b.id,
          index,
          publisher: verified.publisher,
          heightRange: outcome.heightRange,
          bandDigest: bandTablesDigest(b.band),
          counts: outcome.counts,
          accepted,
          startedAt,
          completedAt: Math.floor(Date.now() / 1000),
        });
        jobs.push({
          band: b.id,
          job: null,
          counts: outcome.counts,
          conflictExamples: outcome.conflictExamples,
        });
        continue;
      }
      recordQueued(db, {
        target: 'clickhouse',
        job,
        accepted,
        startedAt,
        queuedAt: Math.floor(Date.now() / 1000),
      });
      log.info('Queued a band for ClickHouse', {
        band: b.id,
        job: job.job,
        ...job.counts,
      });
      jobs.push({ band: b.id, ...job });
    }
  } finally {
    core.close();
    await verifier.close();
  }
  return finishRun(
    {
      ...summary,
      imported: jobs.length,
      jobs,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    },
    refusals,
    verifier,
  );
}

/**
 * Bytes a written item takes in `bundles.db`, tags and indexes included,
 * for the room check: M1 measured about 2.9 KB (9.3 GB for 3.18M items and
 * their 23.3M tags), and this leaves a margin.
 */
export const SQLITE_BYTES_PER_ITEM = 4096;

/** Room kept free beyond a band's estimate: the WAL between checkpoints. */
export const SQLITE_HEADROOM_BYTES = 2 * 1024 ** 3;

const statfsFree = async (dir: string) => {
  const s = await fsp.statfs(dir);
  return s.bavail * s.bsize;
};

/**
 * `--target sqlite`: verifies each band, then writes its items straight
 * into `bundles.db` (`import-sqlite.ts`), newest band first, up to the
 * gateway's stable L1 tip.
 */
async function importBandsSqlite({
  options,
  deps,
  db,
  bundlesDbPath,
  bandsDir,
  index,
  env,
}: {
  options: IndexL2ImportCLIOptions;
  deps: IndexL2ImportDeps;
  db: Sqlite.Database;
  bundlesDbPath: string;
  bandsDir: string;
  index: string;
  env: Record<string, string | undefined>;
}): Promise<JsonSerializable> {
  const { log } = deps;
  const started = Date.now();
  const coreDbPath = options.coreDb ?? 'data/sqlite/core.db';
  const tmpDir = options.tmpDir ?? DEFAULT_TMP_DIR;
  const settings = parseRunSettings(options);
  const live = await liveBandsIn(bandsDir);

  const core = new Sqlite(coreDbPath, { readonly: true, fileMustExist: true });
  let verifier: BandVerifier | undefined;
  try {
    const ceiling = core
      .prepare('SELECT MAX(height) FROM stable_blocks')
      .pluck()
      .get() as number | null;
    if (ceiling === null) {
      throw new L2ImportRefused(
        "core.db holds no stable blocks: SQLite GraphQL shows an item only beside its block, so the L1 index comes first (index-l1-import, or the gateway's own sync)",
      );
    }

    const ledger = readLedger(db, 'sqlite');
    const pending: L2BandOnDisk[] = [];
    const aboveCeiling: string[] = [];
    let done = 0;
    for (const b of [...live].sort(
      (x, y) => y.band.heightRange[0] - x.band.heightRange[0],
    )) {
      if (b.band.heightRange[0] > ceiling) {
        aboveCeiling.push(b.id);
        continue;
      }
      const top = Math.min(b.band.heightRange[1], ceiling);
      const row = ledger.get(b.id);
      if (
        row !== undefined &&
        row.bandDigest.equals(bandTablesDigest(b.band)) &&
        row.completedAt !== null &&
        row.heightTo >= top
      ) {
        done += 1;
        continue;
      }
      pending.push(b);
    }
    const take = pending.slice(0, settings.maxBands ?? pending.length);
    const summary = {
      bandsDir,
      index,
      target: 'sqlite',
      ceiling,
      bands: live.length,
      done,
      pending: pending.length,
      aboveCeiling,
    };
    if (take.length === 0) {
      log.info('Nothing to import now', summary);
      return {
        ...summary,
        imported: 0,
        imports: [],
        seconds: Math.round((Date.now() - started) / 100) / 10,
      } as unknown as JsonSerializable;
    }

    verifier = await openVerifier({
      options,
      deps,
      bandsDir,
      settings,
      tmpDir,
      env,
    });
    const freeBytes = deps.freeBytes ?? statfsFree;
    const dbDir = path.dirname(path.resolve(bundlesDbPath));
    const hasBlock = core
      .prepare('SELECT 1 FROM stable_blocks WHERE height = ?')
      .pluck();
    const accepted = acceptedFlags(options);
    const imports: Array<Record<string, unknown>> = [];
    const refusals: BandRefusal[] = [];
    for (const b of take) {
      const verified = await verifier.verify(b);
      if ('refusal' in verified) {
        refusals.push(verified.refusal);
        continue;
      }
      try {
        const outcome = await importBandIntoSqlite({
          duck: verifier.duck,
          db,
          band: b.band,
          bandDir: b.dir,
          bandId: b.id,
          index,
          publisher: verified.publisher,
          ceiling,
          hasBlock: (height) => hasBlock.get(height) !== undefined,
          accepted,
          checkRoom: async (items) => {
            const need = items * SQLITE_BYTES_PER_ITEM + SQLITE_HEADROOM_BYTES;
            const free = await freeBytes(dbDir);
            if (free < need) {
              throw new L2ImportRefused(
                `too little disk beside bundles.db for ${items} items: ${Math.floor(free / 1024 ** 2)} MiB free, about ${Math.ceil(need / 1024 ** 2)} MiB needed`,
              );
            }
          },
          log,
        });
        if (outcome.counts.conflicting > 0) {
          log.warn(
            'The band places items differently from the rows SQLite holds; the held rows are kept',
            {
              band: b.id,
              conflicting: outcome.counts.conflicting,
              examples: outcome.conflictExamples,
            },
          );
        }
        log.info('Imported a band into SQLite', {
          band: b.id,
          heightRange: outcome.heightRange,
          ...outcome.counts,
        });
        imports.push({ band: b.id, ...outcome });
      } catch (error) {
        if (!(error instanceof L2ImportRefused)) throw error;
        // Refused before its first write (missing blocks, no room): the
        // other bands are still tried.
        log.error('Import refused before writing', {
          band: b.id,
          reason: error.message,
        });
        refusals.push({
          band: b.id,
          reason: error.message,
          kind: 'refused',
          checks: [],
        });
      }
    }
    return finishRun(
      {
        ...summary,
        imported: imports.length,
        imports,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      },
      refusals,
      verifier,
    );
  } finally {
    core.close();
    await verifier?.close();
  }
}

/**
 * `--forget <band> --target sqlite`: removes the rows imports of the band
 * wrote (`forgetSqliteBand`). The band must still be in `--bands-dir`: its
 * `createdAt` is what marks its rows.
 */
async function forgetBandSqlite({
  db,
  bandId,
  bandsDir,
  log,
}: {
  db: Sqlite.Database;
  bandId: string;
  bandsDir: string;
  log: Logger;
}): Promise<JsonSerializable> {
  const listing = await readL2BandsDir(bandsDir);
  const entry = listing.bands.find((b) => b.id === bandId);
  if (entry === undefined) {
    throw new L2ImportRefused(
      `${bandId} is not in ${bandsDir}: forgetting reads its band.json for the indexed_at its rows carry`,
    );
  }
  const indexedAt = bandIndexedAt(entry.band);
  const row = readLedger(db, 'sqlite').get(bandId);
  const heightRange: [number, number] = [
    entry.band.heightRange[0],
    Math.max(entry.band.heightRange[1], row?.heightTo ?? 0),
  ];
  log.info('Forgetting imported rows from SQLite', {
    band: bandId,
    heightRange,
    indexedAt,
  });
  const removed = await forgetSqliteBand({
    db,
    bandId,
    heightRange,
    indexedAt,
  });
  return {
    forgotten: bandId,
    target: 'sqlite',
    indexedAt,
    heightRange,
    ...removed,
  } as unknown as JsonSerializable;
}

/**
 * Deletes from ClickHouse the rows imports of `bandId` wrote, then forgets
 * the band in the ledger.
 *
 * Every job written for the band counts, not only the ledger's last: a band
 * imported up to one ceiling and later past it has two, and a job that
 * failed after some partitions loaded left rows its replacement does not
 * list. Each kept its `written.parquet` in `done/` or `failed/`; the ids of
 * all of them are deleted, within their heights and with the band's
 * `indexed_at`. Refused while a job of the band waits in the queue.
 */
async function forgetBand({
  db,
  bandId,
  jobsDir,
  tmpDir,
  forget,
  log,
}: {
  db: Sqlite.Database;
  bandId: string;
  jobsDir: string;
  tmpDir: string;
  forget: ClickHouseForget;
  log: Logger;
}): Promise<JsonSerializable> {
  const ofBand = (name: string) => name.startsWith(`${bandId}.`);
  const list = async (dir: string) =>
    (await fsp.readdir(path.join(jobsDir, dir)).catch(() => [] as string[]))
      .filter(ofBand)
      .map((name) => path.join(jobsDir, dir, name));
  const queued = await list(QUEUE_DIR);
  if (queued.length > 0) {
    throw new L2ImportRefused(
      `${bandId} has a job waiting to load (${queued.map((q) => path.basename(q)).join(', ')}): wait for clickhouse-auto-import, or remove it from the queue while auto-import is stopped`,
    );
  }
  const jobDirs = [...(await list(DONE_DIR)), ...(await list(FAILED_DIR))];
  const inLedger = readLedger(db, 'clickhouse').has(bandId);
  if (jobDirs.length === 0 && !inLedger) {
    throw new L2ImportRefused(
      `${bandId} is not in the ledger and has no loaded or failed job`,
    );
  }
  const manifests: L2ImportJob[] = [];
  for (const dir of jobDirs) {
    manifests.push(
      JSON.parse(
        await fsp.readFile(path.join(dir, JOB_FILE), 'utf8'),
      ) as L2ImportJob,
    );
  }
  // Every job of one band carries its createdAt; refuse rather than guess.
  const indexedAts = [...new Set(manifests.map((m) => m.indexedAt))];
  if (indexedAts.length > 1) {
    throw new L2ImportRefused(
      `${bandId}'s jobs disagree on indexed_at (${indexedAts.join(', ')})`,
    );
  }
  let ids: string[] = [];
  let matched = 0;
  const heightRange: [number, number] | undefined =
    manifests.length > 0
      ? [
          Math.min(...manifests.map((m) => m.heightRange[0])),
          Math.max(...manifests.map((m) => m.heightRange[1])),
        ]
      : undefined;
  if (heightRange !== undefined) {
    const files = jobDirs
      .map((dir) => `'${path.join(dir, WRITTEN_FILE).replace(/'/g, "''")}'`)
      .join(', ');
    // One database for the read; nothing spills.
    await fsp.mkdir(tmpDir, { recursive: true });
    const session = await openBandsDuck({
      prefix: 'ar-io-node-l2-forget-',
      tmpRoot: tmpDir,
    });
    try {
      ids = (
        (await session.duck.all(
          `SELECT DISTINCT hex(id) AS id FROM read_parquet([${files}]) ORDER BY id`,
        )) as Array<{ id: string }>
      ).map((r) => r.id);
    } finally {
      await session.close();
    }
    log.info('Forgetting imported rows: one ClickHouse mutation, waited for', {
      band: bandId,
      jobs: jobDirs.length,
      ids: ids.length,
      heightRange,
    });
    ({ matched } = await forget.forget({
      from: heightRange[0],
      to: heightRange[1],
      indexedAt: indexedAts[0],
      ids,
    }));
  }
  db.prepare(
    "DELETE FROM parquet_l2_imports WHERE band_id = ? AND target = 'clickhouse'",
  ).run(bandId);
  // The rows are gone and the ledger says so; moving the jobs aside is
  // tidying, so a failure here is reported, not fatal.
  const forgottenDir = path.join(jobsDir, FORGOTTEN_DIR);
  for (const dir of jobDirs) {
    await fsp
      .mkdir(forgottenDir, { recursive: true })
      .then(() => fsp.rename(dir, path.join(forgottenDir, path.basename(dir))))
      .catch((error: Error) =>
        log.warn('Could not move a forgotten job aside', {
          job: dir,
          error: error.message,
        }),
      );
  }
  return {
    forgotten: bandId,
    jobs: jobDirs.map((d) => path.basename(d)),
    indexedAt: indexedAts[0] ?? null,
    ids: ids.length,
    matched,
    heightRange: heightRange ?? null,
  } as unknown as JsonSerializable;
}
