/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l1-verify`: check an L1 index — a gateway's `core.db`, or a
 * directory of `parquet-l1` bands — against the chain: anchored at its top
 * block (recomputed from the block's own fields, from at least two distinct
 * machines), judged block by block, and sampled where nothing else binds.
 * Fails closed: what it cannot bind is listed and fails the run unless an
 * `--allow-*` flag accepts it. See `src/lib/parquet-l1/verify.ts`.
 *
 * Read-only, so it is safe to run while the gateway is up.
 */
import { rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import type { Database } from 'duckdb-async';
import { Logger } from 'winston';

import crypto from 'node:crypto';

import type { GatewayRegistry } from '../../index-swarm/gateway-registry.js';
import {
  ArweaveNodePool,
  type FetchLike,
  parseNodeUrls,
} from '../../lib/onchain/arweave-nodes.js';
import {
  chooseRange,
  stableHeightRange,
  verifyCoreDb,
  VerifyRefused,
} from '../../lib/parquet-l1/verify.js';
import {
  BandsRefused,
  verifyBands,
} from '../../lib/parquet-l1/verify-bands.js';
import type {
  L1Allowances,
  L1VerifyReport,
} from '../../lib/parquet-l1/verify-run.js';
import { exactJsonFetch } from '../../lib/parquet-l1/anchor.js';
import type { SampleOptions } from '../../lib/parquet-l1/sample.js';
import type { IndexL1VerifyCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';
import { resolvePublication } from './index-publication-options.js';

/**
 * The most a check may spill unless `--spill-max` says otherwise. The lookup
 * check of a 69-million-item band (h1.8M of `ardrive-l2`) peaks at about
 * 65 GB (measured 2026-10-20); 128 GB leaves room for a band twice that.
 */
export const BANDS_SPILL_MAX = '128GB';
/** A DuckDB size: digits and a unit (`16GB`, `512MB`, `1TB`). */
export const SPILL_MAX_PATTERN =
  /^\d+(\.\d+)?\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i;

/** Bytes in a DuckDB size such as `16GB` (10^9) or `16GiB` (2^30). */
export function spillBytes(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(K|M|G|T)(i?)B$/i.exec(size.trim());
  if (m === null) throw new Error(`not a size: ${size}`);
  const power = 'KMGT'.indexOf(m[2].toUpperCase()) + 1;
  const base = m[3] !== '' ? 1024 : 1000;
  return Math.floor(Number(m[1]) * base ** power);
}

/** The share of the spill directory's free space a run may spill into. */
export const SPILL_FREE_SHARE = 0.8;
/** Space a run always leaves free under its spill, whatever else it may take. */
export const SPILL_RESERVE_BYTES = 100e9;
/** A spill folder whose heartbeat is older than this was left by a killed run. */
export const STALE_SPILL_MS = 24 * 3600 * 1000;
/**
 * A file in each spill folder its run touches every minute: another run
 * removes the folder only once it has stopped beating for a day.
 */
export const SPILL_HEARTBEAT_FILE = '.heartbeat';
const HEARTBEAT_MS = 60_000;

/**
 * A DuckDB session for checking bands: bounded memory, two threads, no
 * extensions, and somewhere it can always spill.
 *
 * Without a `temp_directory`, an in-memory DuckDB spills to `.tmp` under the
 * working directory. Through `tools/ar-io-node`, or `docker run` as the
 * caller's user, that is the image's `/app`, which the caller cannot write,
 * so checking the lookups of a large band failed on the directory, not the
 * band. The spill goes in a folder of its own under the system temp
 * directory (`TMPDIR`), which `close` removes, and is capped so a run cannot
 * fill the disk under it: at `spillMax`, at most {@link SPILL_FREE_SHARE}
 * of the space free there when the run starts, and never into the last
 * {@link SPILL_RESERVE_BYTES} of it
 * (`tools/ar-io-node` mounts a folder under the node's data directory
 * there, so the container layer on `/` is never the one filled). An
 * interrupt (SIGINT, SIGTERM) removes the folder before the process ends.
 */
export async function openBandsDuck(
  options: {
    tmpRoot?: string;
    prefix?: string;
    spillMax?: string;
    /** Injected in tests: the bytes free under the temp root. */
    freeBytes?: (dir: string) => Promise<number>;
    /** Space always left free under the spill (default {@link SPILL_RESERVE_BYTES}). */
    reserveBytes?: number;
  } = {},
): Promise<{
  duck: Database;
  spill: string;
  /** What the spill is capped at, in bytes, and the bytes free when it opened. */
  spillCapBytes: number;
  freeBytes: number;
  /** Spill folders a killed run left, removed as this one opened. */
  removedStale: string[];
  /**
   * Opens `count` more databases set up as `duck` is, each spilling to a
   * folder of its own inside the run's, each capped at the whole spill cap:
   * a caller using more than one shares the cap out between them (as
   * `verifyL2Bands` does, given `spillBytes`). `close` closes them too.
   */
  openMore(count: number): Promise<Database[]>;
  close(): Promise<void>;
}> {
  const spillMax = options.spillMax ?? BANDS_SPILL_MAX;
  if (!SPILL_MAX_PATTERN.test(spillMax)) {
    throw new Error(
      `--spill-max must be a size such as 16GB or 512MB, not ${spillMax}`,
    );
  }
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const freeBytes = await (
    options.freeBytes ??
    (async (dir: string) => {
      const stats = await fsp.statfs(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    })
  )(tmpRoot);
  const spillCapBytes = Math.max(
    0,
    Math.min(
      spillBytes(spillMax),
      Math.floor(freeBytes * SPILL_FREE_SHARE),
      freeBytes - (options.reserveBytes ?? SPILL_RESERVE_BYTES),
    ),
  );
  const prefix = options.prefix ?? 'ar-io-node-l1-verify-';
  // Folders of this kind a killed run (SIGKILL) left a day or more ago.
  const removedStale: string[] = [];
  for (const name of await fsp.readdir(tmpRoot).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(tmpRoot, name);
    const stat = await fsp.lstat(dir).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) continue;
    // The heartbeat's age, or the folder's where a run kept none.
    const beat = await fsp
      .stat(path.join(dir, SPILL_HEARTBEAT_FILE))
      .catch(() => undefined);
    if (Date.now() - (beat ?? stat).mtimeMs < STALE_SPILL_MS) continue;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      removedStale.push(dir);
    } catch {
      // Another user's folder, or one still in use: not this run's to remove.
    }
  }
  const spill = await fsp.mkdtemp(path.join(tmpRoot, prefix));
  const removeSpill = () => fsp.rm(spill, { recursive: true, force: true });
  // An interrupted run leaves no spill behind: removed, then the signal's
  // usual end (exit 130 for Ctrl-C) follows. Set before anything is
  // written into the folder.
  const beat: { timer?: NodeJS.Timeout } = {};
  const onSignal = (signal: NodeJS.Signals) => {
    clearInterval(beat.timer);
    rmSync(spill, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const forget = () => {
    clearInterval(beat.timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  const heartbeat = path.join(spill, SPILL_HEARTBEAT_FILE);
  try {
    await fsp.writeFile(heartbeat, '');
  } catch (error) {
    forget();
    await removeSpill();
    throw error;
  }
  beat.timer = setInterval(() => {
    const now = new Date();
    fsp.utimes(heartbeat, now, now).catch(() => undefined);
  }, HEARTBEAT_MS);
  beat.timer.unref();
  const capOf = (bytes: number) =>
    `${Math.max(1, Math.floor(bytes / 2 ** 20))}MiB`;
  const open = async (dir: string, capBytes: number) => {
    const { Database } = await import('duckdb-async');
    const opened = await Database.create(':memory:');
    try {
      await opened.exec(
        `SET memory_limit = '2GB'; SET threads = 2; SET temp_directory = '${dir.replace(/'/g, "''")}'; SET max_temp_directory_size = '${capOf(capBytes)}'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
      );
    } catch (error) {
      await opened.close().catch(() => undefined);
      throw error;
    }
    return opened;
  };
  let duck: Database | undefined;
  try {
    duck = await open(spill, spillCapBytes);
  } catch (error) {
    await removeSpill();
    forget();
    throw error;
  }
  const opened = duck;
  const more: Database[] = [];
  return {
    duck: opened,
    spill,
    spillCapBytes,
    freeBytes,
    removedStale,
    openMore: async (count: number) => {
      const added: Database[] = [];
      for (let i = 1; i <= count; i += 1) {
        const dir = path.join(spill, `db-${more.length + 1}`);
        await fsp.mkdir(dir);
        more.push(await open(dir, spillCapBytes));
        added.push(more[more.length - 1]);
      }
      return added;
    },
    close: async () => {
      try {
        for (const other of more) {
          await other.close().catch(() => undefined);
        }
        await opened.close();
      } finally {
        await removeSpill();
        forget();
      }
    },
  };
}

/** Blocks drawn for the header sample by default. */
export const DEFAULT_SAMPLE_BLOCKS = 1000;
/** Transactions drawn per band for the signature sample by default. */
export const DEFAULT_SAMPLE_TXS = 1000;
/**
 * Format-1 transactions drawn per band, from blocks whose tx_root cannot be
 * recomputed, by default: what catches a format-2 transaction relabelled.
 */
export const DEFAULT_SAMPLE_FORMAT1 = 200;
/**
 * Bytes of format-1 data a band's signature sample may fetch, counting
 * every machine's copy: a band of 1,000 draws at two copies measured about
 * 1.22 GB (200000-299999), so this leaves room to spare.
 */
export const DEFAULT_SAMPLE_V1_BYTES = 4e9;
/** Sample fetches in flight by default. */
export const DEFAULT_SAMPLE_CONCURRENCY = 8;
/** How long one read from a source may take by default. */
export const DEFAULT_READ_TIMEOUT_MS = 30_000;

const whole = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VerifyRefused(`${flag} must be a whole number, 0 or above`);
  }
  return parsed;
};

/** `--spill-reserve-gb` in bytes, or the default. */
export function spillReserveBytes(value: string | undefined): number {
  if (value === undefined) return SPILL_RESERVE_BYTES;
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb < 0) {
    throw new VerifyRefused('--spill-reserve-gb must be a number, 0 or above');
  }
  return gb * 1e9;
}

export interface IndexL1VerifyDeps {
  log: Logger;
  /** Injected in tests: the bytes free under the spill directory. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Injected in tests: how sources are fetched from (`/block/…`, `/tx/…`). */
  fetch?: FetchLike;
  /** Injected in tests: every address a source's host name resolves to. */
  lookupAll?: (host: string) => Promise<string[]>;
  /** Injected in tests: the registry `--registry-url` reads. */
  registry?: GatewayRegistry;
  /** Injected in tests: the time a publication's expiry is judged at. */
  now?: () => number;
}

/**
 * The sources `--anchor-from` names, as a pool that counts machines, not
 * names; undefined without any.
 */
export function anchorPool(
  options: { anchorFrom?: string; readTimeout?: string },
  deps: Pick<IndexL1VerifyDeps, 'fetch' | 'lookupAll'>,
  Refused: new (message: string) => Error = VerifyRefused,
): ArweaveNodePool | undefined {
  const given = options.anchorFrom?.trim() ?? '';
  if (given === '') return undefined;
  let urls: string[];
  try {
    urls = parseNodeUrls(given);
  } catch (error) {
    throw new Refused(`--anchor-from: ${(error as Error).message}`);
  }
  return new ArweaveNodePool({
    urls,
    timeoutMs:
      whole(options.readTimeout, '--read-timeout') ?? DEFAULT_READ_TIMEOUT_MS,
    // Long integers kept exact, or some headers could not be recomputed.
    fetch: deps.fetch ?? exactJsonFetch,
    ...(deps.lookupAll !== undefined ? { lookupAll: deps.lookupAll } : {}),
    dedupeByAddress: true,
  });
}

/** The sample a run draws: none without sources, or with every count 0. */
export function sampleOptions(
  options: {
    sampleBlocks?: string;
    sampleTxs?: string;
    sampleFormat1?: string;
    seed?: string;
    concurrency?: string;
  },
  pool: ArweaveNodePool | undefined,
  confirm: number,
): SampleOptions | undefined {
  const blocks =
    whole(options.sampleBlocks, '--sample-blocks') ?? DEFAULT_SAMPLE_BLOCKS;
  const txs = whole(options.sampleTxs, '--sample-txs') ?? DEFAULT_SAMPLE_TXS;
  const format1 =
    whole(options.sampleFormat1, '--sample-format1') ?? DEFAULT_SAMPLE_FORMAT1;
  if (pool === undefined || (blocks === 0 && txs === 0 && format1 === 0)) {
    return undefined;
  }
  return {
    seed: whole(options.seed, '--seed') ?? crypto.randomInt(2 ** 31),
    blocks,
    txsPerStratum: txs,
    format1PerStratum: format1,
    v1BytesPerStratum: DEFAULT_SAMPLE_V1_BYTES,
    concurrency:
      whole(options.concurrency, '--concurrency') ?? DEFAULT_SAMPLE_CONCURRENCY,
    confirm,
  };
}

/** What the `--allow-*` flags accept. */
export function allowances(options: {
  allowUnanchored?: boolean;
  allowUnbound?: boolean;
  allowIncomplete?: boolean;
  allowUnverifiedFormat1?: boolean;
}): L1Allowances {
  return {
    unanchored: options.allowUnanchored === true,
    unbound: options.allowUnbound === true,
    incomplete: options.allowIncomplete === true,
    unverifiedFormat1: options.allowUnverifiedFormat1 === true,
  };
}

/**
 * `--anchor-min`, at least 2 (the default): one machine never anchors an
 * index, as it never refutes or attests a draw.
 */
export function anchorMin(
  value: string | undefined,
  Refused: new (message: string) => Error = VerifyRefused,
): number {
  const n = value === undefined ? 2 : Number(value);
  if (!Number.isInteger(n) || n < 2) {
    throw new Refused('--anchor-min must be a whole number of at least 2');
  }
  return n;
}

/** A report as the command prints it: the checks' failures trimmed to their fields. */
function printable(report: L1VerifyReport): Record<string, unknown> {
  return {
    ...report,
    seconds: Math.round(report.seconds * 10) / 10,
    checks: report.checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      detail: c.detail,
      ...(c.failures !== undefined
        ? {
            failures: c.failures.map((f) => ({
              height: f.height,
              found: f.found,
              expected: f.expected,
            })),
          }
        : {}),
      ...(c.more !== undefined ? { more: c.more } : {}),
    })),
  };
}

export async function indexL1VerifyCLICommand(
  options: IndexL1VerifyCLIOptions,
  deps: IndexL1VerifyDeps,
): Promise<JsonSerializable> {
  const { log } = deps;
  const wantFrom = whole(options.from, '--from');
  const wantTo = whole(options.to, '--to');
  const min = anchorMin(options.anchorMin);
  const pool = anchorPool(options, deps);
  const sample = sampleOptions(options, pool, min);
  const accepted =
    pool !== undefined && sample === undefined
      ? ['--sample-blocks 0 --sample-txs 0']
      : [];
  const common = {
    txRoot: options.skipTxRoot !== true,
    ...(pool !== undefined ? { pool } : {}),
    anchorMin: min,
    ...(sample !== undefined ? { sample } : {}),
    allow: allowances(options),
    accepted,
  };

  const bandsMode =
    options.bandsDir !== undefined &&
    options.bandsDir.length > 0 &&
    options.coreDb === undefined;
  if (!bandsMode && options.publication !== undefined) {
    throw new VerifyRefused(
      '--publication binds bands: give --bands-dir, not --core-db',
    );
  }

  let report: Record<string, unknown>;
  let ok: boolean;
  if (bandsMode) {
    const bandsDir = options.bandsDir as string;
    // A directory that was named must be there and readable: a run that
    // reads nothing proves nothing.
    try {
      const stat = await fsp.stat(bandsDir);
      if (!stat.isDirectory()) throw new Error('not a directory');
      await fsp.readdir(bandsDir);
    } catch (error) {
      throw new VerifyRefused(
        `--bands-dir ${bandsDir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      );
    }
    const timeoutMs =
      whole(options.readTimeout, '--read-timeout') ?? DEFAULT_READ_TIMEOUT_MS;
    const publication = await resolvePublication(
      options,
      {
        log,
        timeoutMs,
        ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
      },
      VerifyRefused,
    );
    const session = await openBandsDuck({
      ...(options.spillMax !== undefined ? { spillMax: options.spillMax } : {}),
      ...(deps.freeBytes !== undefined ? { freeBytes: deps.freeBytes } : {}),
      reserveBytes: spillReserveBytes(options.spillReserveGb),
    });
    try {
      // The lookup check spills; with nothing to spill into it would fail
      // in DuckDB and report sound bands as unreadable. Refuse first.
      if (options.skipLookups !== true && session.spillCapBytes === 0) {
        throw new VerifyRefused(
          `no room to spill under ${path.dirname(session.spill)}: ${(session.freeBytes / 2 ** 30).toFixed(1)} GiB free, less the ${(spillReserveBytes(options.spillReserveGb) / 2 ** 30).toFixed(1)} GiB a run always leaves. Free space there, point TMPDIR elsewhere, lower --spill-reserve-gb, or --skip-lookups`,
        );
      }
      for (const dir of session.removedStale) {
        log.warn('Removed a spill folder a killed run left', { dir });
      }
      log.info('Checking bands', { bandsDir, spill: session.spill });
      let out;
      try {
        out = await verifyBands(session.duck, bandsDir, {
          ...common,
          ...(wantFrom !== undefined ? { from: wantFrom } : {}),
          ...(wantTo !== undefined ? { to: wantTo } : {}),
          lookups: options.skipLookups !== true,
          ...(publication !== undefined
            ? {
                publication: {
                  document: publication.document,
                  publisherKey: publication.publisherKey,
                  ...(publication.index !== undefined
                    ? { index: publication.index }
                    : {}),
                  ...(publication.keyFrom !== undefined
                    ? { keyFrom: publication.keyFrom }
                    : {}),
                  ...(options.allowExpired === true
                    ? { allowExpired: true }
                    : {}),
                  ...(deps.now !== undefined ? { now: deps.now } : {}),
                },
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof BandsRefused) {
          throw new VerifyRefused(error.message);
        }
        throw error;
      }
      log.info('Checked bands', { ok: out.ok, blocks: out.blocks });
      ok = out.ok;
      const { bands, ...rest } = out;
      report = {
        mode: 'bands-dir',
        ...printable(rest as unknown as L1VerifyReport),
        bands: bands.length,
        bandIds: bands.map((b) => b.id),
        ...(publication !== undefined
          ? {
              publication: {
                ...(out.publication ?? {}),
                source: publication.source,
              },
            }
          : {}),
      };
    } finally {
      await session.close();
    }
  } else {
    const coreDb = requiredStringFromOptions(options, 'coreDb');
    let db: Sqlite.Database;
    try {
      db = new Sqlite(coreDb, { readonly: true, fileMustExist: true });
    } catch (error) {
      throw new VerifyRefused(
        `Cannot open ${coreDb}: ${(error as Error).message}`,
      );
    }
    try {
      const held = stableHeightRange(db);
      if (held === undefined) {
        throw new VerifyRefused(`${coreDb} holds no stable blocks to check`);
      }
      const [from, to] = chooseRange(held, {
        ...(wantFrom !== undefined ? { from: wantFrom } : {}),
        ...(wantTo !== undefined ? { to: wantTo } : {}),
      });
      log.info('Checking the L1 index', { coreDb, from, to });
      const out = await verifyCoreDb(db, { ...common, from, to });
      ok = out.ok;
      report = { mode: 'core-db', coreDb, ...printable(out) };
    } finally {
      db.close();
    }
  }
  log.info('Checked the L1 index', { ok, seconds: report.seconds });
  // A failed check has to fail the command. `runCommand` prints a thrown
  // result on stderr and exits 1; returning it would print the same JSON
  // and exit 0, and a script would read a broken index as a good one.
  if (!ok) throw report;
  return report as JsonSerializable;
}
