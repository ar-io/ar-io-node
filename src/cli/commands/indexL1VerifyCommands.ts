/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l1-verify`: check a gateway's L1 index against the weave size the
 * chain commits to, and against itself.
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

import {
  AnchorAnswer,
  anchorHeights,
  checkAnchors,
  checkTxRoots,
  chooseRange,
  stableHeightRange,
  verifyRange,
  VerifyRefused,
  type VerifyCheck,
  type VerifyFailure,
} from '../../lib/parquet-l1/verify.js';
import { verifyBands } from '../../lib/parquet-l1/verify-bands.js';
import type { IndexL1VerifyCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

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
  } = {},
): Promise<{
  duck: Database;
  spill: string;
  /** What the spill is capped at, in bytes, and the bytes free when it opened. */
  spillCapBytes: number;
  freeBytes: number;
  /** Spill folders a killed run left, removed as this one opened. */
  removedStale: string[];
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
      freeBytes - SPILL_RESERVE_BYTES,
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
    await fsp.rm(dir, { recursive: true, force: true });
    removedStale.push(dir);
  }
  const spill = await fsp.mkdtemp(path.join(tmpRoot, prefix));
  const heartbeat = path.join(spill, SPILL_HEARTBEAT_FILE);
  await fsp.writeFile(heartbeat, '');
  const beating = setInterval(() => {
    const now = new Date();
    fsp.utimes(heartbeat, now, now).catch(() => undefined);
  }, HEARTBEAT_MS);
  beating.unref();
  const removeSpill = () => fsp.rm(spill, { recursive: true, force: true });
  // An interrupted run leaves no spill behind: removed, then the signal's
  // usual end (exit 130 for Ctrl-C) follows.
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(spill, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const forget = () => {
    clearInterval(beating);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  let duck: Database | undefined;
  try {
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
    const cap = `${Math.max(1, Math.floor(spillCapBytes / 2 ** 20))}MiB`;
    await duck.exec(
      `SET memory_limit = '2GB'; SET threads = 2; SET temp_directory = '${spill.replace(/'/g, "''")}'; SET max_temp_directory_size = '${cap}'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
    );
  } catch (error) {
    await duck?.close().catch(() => undefined);
    await removeSpill();
    forget();
    throw error;
  }
  const opened = duck;
  return {
    duck: opened,
    spill,
    spillCapBytes,
    freeBytes,
    removedStale,
    close: async () => {
      try {
        await opened.close();
      } finally {
        await removeSpill();
        forget();
      }
    },
  };
}

/** Checks a directory of bands, with no database involved. */
async function verifyBandsCLI(
  options: IndexL1VerifyCLIOptions,
  log: Logger,
): Promise<JsonSerializable> {
  const bandsDir = options.bandsDir as string;
  const whole = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new VerifyRefused(`${flag} must be a whole height, 0 or above`);
    }
    return n;
  };
  const session = await openBandsDuck({
    ...(options.spillMax !== undefined ? { spillMax: options.spillMax } : {}),
  });
  const { duck } = session;
  try {
    for (const dir of session.removedStale) {
      log.warn('Removed a spill folder a killed run left', { dir });
    }
    log.info('Checking bands', { bandsDir, spill: session.spill });
    const out = await verifyBands(duck, bandsDir, {
      ...(whole(options.from, '--from') !== undefined
        ? { from: whole(options.from, '--from') as number }
        : {}),
      ...(whole(options.to, '--to') !== undefined
        ? { to: whole(options.to, '--to') as number }
        : {}),
      txRoot: options.skipTxRoot !== true,
      lookups: options.skipLookups !== true,
    });
    log.info('Checked bands', { ok: out.ok, blocks: out.blocks });
    const answer = {
      bandsDir: out.bandsDir,
      bands: out.bands.length,
      heightRange: out.heightRange,
      blocks: out.blocks,
      txRootChecked: out.txRootChecked,
      txRootSkipped: out.txRootSkipped,
      merkleChecked: out.merkleChecked,
      merkleSkipped: out.merkleSkipped,
      accountingChecked: out.accountingChecked,
      accountingSkipped: out.accountingSkipped,
      lookupsChecked: out.lookupsChecked,
      lookupsSkipped: out.lookupsSkipped,
      ok: out.ok,
      checks: out.checks.map((c: VerifyCheck) => ({
        name: c.name,
        ok: c.ok,
        detail: c.detail,
        ...(c.failures !== undefined
          ? {
              failures: c.failures.map((f: VerifyFailure) => ({
                height: f.height,
                found: f.found,
                expected: f.expected,
              })),
            }
          : {}),
        ...(c.more !== undefined ? { more: c.more } : {}),
      })),
      seconds: Math.round(out.seconds * 10) / 10,
    };
    if (!out.ok) throw answer;
    return answer;
  } finally {
    await session.close();
  }
}

export interface IndexL1VerifyDeps {
  log: Logger;
  /** Asks one source for a block's identity hash; injected in tests. */
  fetchIndepHash?: (
    url: string,
    height: number,
    timeoutMs: number,
  ) => Promise<string>;
}

/** How long one source gets to answer before it counts as unreachable. */
export const ANCHOR_TIMEOUT_MS = 10_000;

/**
 * Asks one source for a block's identity hash. Any Arweave node or
 * gateway serves `/block/height/N`; raw nodes on port 1984 are a
 * different implementation from this one, which is what makes their
 * agreement worth having.
 */
async function httpIndepHash(
  url: string,
  height: number,
  timeoutMs: number,
): Promise<string> {
  const stop = AbortSignal.timeout(timeoutMs);
  const response = await fetch(
    `${url.replace(/\/+$/, '')}/block/height/${height}`,
    { signal: stop },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { indep_hash?: unknown };
  if (typeof body.indep_hash !== 'string' || body.indep_hash.length === 0) {
    throw new Error('no indep_hash in the response');
  }
  return body.indep_hash;
}

const height = (
  value: string | undefined,
  flag: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VerifyRefused(`${flag} must be a whole height, 0 or above`);
  }
  return parsed;
};

export async function indexL1VerifyCLICommand(
  options: IndexL1VerifyCLIOptions,
  { log, fetchIndepHash = httpIndepHash }: IndexL1VerifyDeps,
): Promise<JsonSerializable> {
  // Bands are the consumer's view: a directory of them can be checked
  // with no gateway and no `core.db`, which is the whole point of the
  // format being content-addressed and signed.
  if (
    options.bandsDir !== undefined &&
    options.bandsDir.length > 0 &&
    options.coreDb === undefined
  ) {
    return verifyBandsCLI(options, log);
  }
  const coreDb = requiredStringFromOptions(options, 'coreDb');
  const wantFrom = height(options.from, '--from');
  const wantTo = height(options.to, '--to');
  // Deduplicated, and trailing slashes removed first, or the same node
  // listed twice satisfies --anchor-min on its own — which is precisely
  // the single point of trust the anchor exists to remove.
  const sources = [
    ...new Set(
      (options.anchorFrom ?? '')
        .split(',')
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter((url) => url.length > 0),
    ),
  ];
  const minSources =
    options.anchorMin === undefined ? 2 : Number(options.anchorMin);
  if (!Number.isInteger(minSources) || minSources < 1) {
    throw new VerifyRefused('--anchor-min must be a positive whole number');
  }

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
    const result = verifyRange(db, { from, to });

    // Separate because it is the only check that reads every
    // transaction rather than a sum over them, so it costs minutes
    // where the rest cost seconds. Skipped on request for a quick pass.
    let txRoots = { checked: 0, skipped: 0, seconds: 0 };
    if (options.skipTxRoot !== true) {
      const began = Date.now();
      const out = await checkTxRoots(db, { from, to });
      result.checks.push(out.check);
      result.ok = result.ok && out.check.ok;
      txRoots = {
        checked: out.checked,
        skipped: out.skipped,
        seconds: (Date.now() - began) / 1000,
      };
      log.info('Recomputed tx_root', txRoots);
    }

    // Everything above is the index agreeing with itself. This is the
    // only part that asks anyone else, and it is what turns the chain
    // binding into a statement about the real Arweave chain.
    let anchors: AnchorAnswer[] = [];
    if (sources.length > 0) {
      const wanted = anchorHeights(from, to);
      const hashes = db.prepare(
        'SELECT indep_hash FROM stable_blocks WHERE height = ?',
      );
      const ours = new Map<number, string>();
      for (const h of wanted) {
        const row = hashes.get(h) as { indep_hash: Buffer | null } | undefined;
        if (row?.indep_hash != null) {
          ours.set(h, row.indep_hash.toString('base64url'));
        }
      }
      anchors = (
        await Promise.all(
          wanted.flatMap((h) =>
            sources.map(async (url): Promise<AnchorAnswer> => {
              try {
                return {
                  url,
                  height: h,
                  indepHash: await fetchIndepHash(url, h, ANCHOR_TIMEOUT_MS),
                };
              } catch (error) {
                return { url, height: h, error: (error as Error).message };
              }
            }),
          ),
        )
      ).flat();
      const check = checkAnchors(ours, anchors, minSources);
      result.checks.push(check);
      result.ok = result.ok && check.ok;
      log.info('Asked for anchors', {
        heights: wanted,
        sources: sources.length,
        answered: anchors.filter((a) => a.indepHash !== undefined).length,
      });
    }
    log.info('Checked the L1 index', {
      ok: result.ok,
      blocks: result.blocks,
      seconds: Math.round(result.seconds),
    });
    const answer = {
      coreDb,
      heightRange: result.heightRange,
      blocks: result.blocks,
      anchored: result.anchored,
      ...(result.anchorHeight !== undefined
        ? { anchorHeight: result.anchorHeight }
        : {}),
      ...(result.weaveSize !== undefined
        ? { weaveSize: result.weaveSize, accountedFor: result.accountedFor }
        : {}),
      txRootChecked: txRoots.checked,
      txRootSkipped: txRoots.skipped,
      txRootSeconds: Math.round(txRoots.seconds * 10) / 10,
      merkleChecked: result.merkleChecked,
      merkleSkipped: result.merkleSkipped,
      accountingChecked: result.accountingChecked,
      accountingSkipped: result.accountingSkipped,
      ok: result.ok,
      ...(anchors.length > 0
        ? {
            anchorSources: anchors.map((a) => ({
              url: a.url,
              height: a.height,
              ...(a.indepHash !== undefined ? { indepHash: a.indepHash } : {}),
              ...(a.error !== undefined ? { error: a.error } : {}),
            })),
          }
        : {}),
      checks: result.checks.map((c) => ({
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
      // Everything, not just the streamed pass: tx_root runs outside
      // `verifyRange`'s own timer and dominates a whole-chain run, so
      // reporting that pass alone understated the cost tenfold.
      seconds: Math.round((result.seconds + txRoots.seconds) * 10) / 10,
      streamedPassSeconds: Math.round(result.seconds * 10) / 10,
    };
    // A failed check has to fail the command. `runCommand` prints a
    // thrown result on stderr and exits 1; returning it would print the
    // same JSON and exit 0, and a script would read a broken index as a
    // good one.
    if (!result.ok) throw answer;
    return answer;
  } finally {
    db.close();
  }
}
