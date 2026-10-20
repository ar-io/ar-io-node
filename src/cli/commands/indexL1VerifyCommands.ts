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

/** The most a check may spill, the cap `index-l1-import` uses too. */
export const BANDS_SPILL_MAX = '16GB';

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
 * fill the disk under it (through the wrapper, the container layer on `/`).
 */
export async function openBandsDuck(
  options: { tmpRoot?: string; prefix?: string } = {},
): Promise<{ duck: Database; spill: string; close(): Promise<void> }> {
  const spill = await fsp.mkdtemp(
    path.join(
      options.tmpRoot ?? os.tmpdir(),
      options.prefix ?? 'ar-io-node-l1-verify-',
    ),
  );
  const removeSpill = () => fsp.rm(spill, { recursive: true, force: true });
  let duck: Database | undefined;
  try {
    const { Database } = await import('duckdb-async');
    duck = await Database.create(':memory:');
    await duck.exec(
      `SET memory_limit = '2GB'; SET threads = 2; SET temp_directory = '${spill.replace(/'/g, "''")}'; SET max_temp_directory_size = '${BANDS_SPILL_MAX}'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
    );
  } catch (error) {
    await duck?.close().catch(() => undefined);
    await removeSpill();
    throw error;
  }
  const opened = duck;
  return {
    duck: opened,
    spill,
    close: async () => {
      try {
        await opened.close();
      } finally {
        await removeSpill();
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
  const session = await openBandsDuck();
  const { duck } = session;
  try {
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
