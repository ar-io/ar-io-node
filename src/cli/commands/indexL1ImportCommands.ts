/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `index-l1-import`: fills a gateway's `core.db` from published
 * `parquet-l1` bands, so it starts from an index instead of walking the
 * chain block by block.
 *
 * Offline: the gateway must be stopped. The command refuses a database
 * another writer holds rather than racing it.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import {
  applyImportPragmas,
  ImportOutcome,
  ImportRefused,
  runFill,
  runImport,
} from '../../lib/parquet-l1/import.js';
import type { IndexL1ImportCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

export interface IndexL1ImportDeps {
  log: Logger;
}

/**
 * Page cache for the import, in MiB. Large enough to hold the working set
 * of the indexes being maintained, small enough to leave room for a
 * gateway's other databases on a modest box.
 */
export const DEFAULT_CACHE_MIB = 1024;

/** How long `--fill` waits for the gateway to release the write lock. */
export const FILL_BUSY_TIMEOUT_MS = 60_000;

/** DuckDB's spill directories beside `core.db`, one per run. */
const SPILL_PREFIX = '.duckdb-import-';

/**
 * Refuses an import or fill while another runs against the same `core.db`:
 * two fills would plan the same holes and clear each other's rows, and a
 * fill would take an offline import's spill directory for a dead run's.
 *
 * The lock is an exclusive transaction on a small SQLite file beside
 * `core.db`. SQLite's locks are the kernel's, so they hold across
 * containers sharing the directory and are released when the process
 * holding one exits, however it exits — no stale lock file to clean up.
 */
export function takeImportLock(coreDb: string): Sqlite.Database {
  const lockPath = path.join(path.dirname(coreDb), '.l1-import.lock');
  const lock = new Sqlite(lockPath, { timeout: 0 });
  try {
    lock.pragma('locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw new ImportRefused(
      `Another import or fill is running against ${coreDb} (${(error as Error).message})`,
    );
  }
  return lock;
}

/** Removes the spill directories runs that were killed left behind. */
async function removeStaleSpills(dir: string): Promise<void> {
  for (const name of await fsp.readdir(dir)) {
    if (name.startsWith(SPILL_PREFIX) || name === '.duckdb-import-tmp') {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

/** One band or range of a run, as the CLI contract reports it. */
function describe(o: ImportOutcome) {
  return {
    heightRange: o.heightRange,
    ...(o.heights !== undefined ? { heights: o.heights } : {}),
    result: o.result,
    // A refused band imported nothing, and `undefined` would not survive
    // the JSON the CLI contract promises.
    ...(o.rows !== undefined ? { rows: o.rows } : {}),
    ...(o.reason !== undefined ? { reason: o.reason } : {}),
    seconds: Math.round(o.seconds),
  };
}

export async function indexL1ImportCLICommand(
  options: IndexL1ImportCLIOptions,
  { log }: IndexL1ImportDeps,
): Promise<JsonSerializable> {
  const bandsDir = requiredStringFromOptions(options, 'bandsDir');
  const coreDb = requiredStringFromOptions(options, 'coreDb');
  const maxBands =
    options.maxBands === undefined ? undefined : Number(options.maxBands);
  if (maxBands !== undefined && (!Number.isInteger(maxBands) || maxBands < 1)) {
    throw new Error(`--max-bands must be a positive whole number`);
  }
  const bound = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new ImportRefused(`${flag} must be a whole height, 0 or above`);
    }
    return n;
  };
  const from = bound(options.from, '--from');
  const to = bound(options.to, '--to');
  if (from !== undefined && to !== undefined && to < from) {
    throw new ImportRefused(`--to (${to}) is below --from (${from})`);
  }
  const cacheMib =
    options.cacheMib === undefined
      ? DEFAULT_CACHE_MIB
      : Number(options.cacheMib);
  if (!Number.isInteger(cacheMib) || cacheMib < 1) {
    throw new Error('--cache-mib must be a positive whole number');
  }

  const fill = options.fill === true;
  const started = Date.now();
  let db: Sqlite.Database;
  try {
    // Filling shares the database with a running gateway, whose flush can
    // hold the write lock for a while; wait for it rather than fail.
    db = new Sqlite(coreDb, {
      fileMustExist: true,
      ...(fill ? { timeout: FILL_BUSY_TIMEOUT_MS } : {}),
    });
  } catch (error) {
    throw new ImportRefused(
      `Cannot open ${coreDb}: ${(error as Error).message}`,
    );
  }
  applyImportPragmas(db, cacheMib);
  let lock: Sqlite.Database;
  try {
    lock = takeImportLock(coreDb);
  } catch (error) {
    db.close();
    throw error;
  }

  // Without a temp directory DuckDB sorts entirely in memory whatever
  // `memory_limit` says, as the Parquet exporter's own comment records.
  // Spill beside the database, not into the container's layer, in a
  // directory of this run's own.
  let spill: string | undefined;
  const { Database } = await import('duckdb-async');
  const duck = await Database.create(':memory:');
  try {
    // Holding the lock, no other run is using a spill directory here: any
    // left over is from a run that was killed, and goes.
    await removeStaleSpills(path.dirname(coreDb));
    spill = await fsp.mkdtemp(path.join(path.dirname(coreDb), SPILL_PREFIX));
    await duck.exec(
      `SET memory_limit = '1GB'; SET threads = 2; SET temp_directory = '${spill.replace(/'/g, "''")}'; SET max_temp_directory_size = '16GB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`,
    );
    if (fill) {
      log.info('Filling', { coreDb, cacheMib });
      const run = await runFill({
        db,
        duck,
        bandsDir,
        log,
        ...(maxBands !== undefined ? { limit: maxBands } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        onBand: (outcome) =>
          log.info('Range finished', {
            heights: outcome.heights,
            result: outcome.result,
            rows: outcome.rows,
            seconds: Math.round(outcome.seconds),
          }),
      });
      const filled = run.outcomes.filter((o) => o.result === 'imported');
      const refused = run.outcomes.find((o) => o.result === 'refused');
      const answer = {
        coreDb,
        bandsDir,
        mode: 'fill',
        ceiling: run.ceiling,
        filled: filled.length,
        rows: filled.reduce((sum, o) => sum + (o.rows ?? 0), 0),
        missingTransactions: filled.reduce(
          (sum, o) => sum + (o.missingTransactions ?? 0),
          0,
        ),
        uncovered: run.uncovered,
        ...(refused !== undefined ? { refused: refused.reason } : {}),
        ranges: run.outcomes.map(describe),
        seconds: Math.round((Date.now() - started) / 100) / 10,
      };
      if (refused !== undefined) throw answer;
      return answer;
    }
    log.info('Importing', { coreDb, cacheMib });
    const run = await runImport({
      db,
      duck,
      bandsDir,
      log,
      ...(maxBands !== undefined ? { limit: maxBands } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      onBand: (outcome) =>
        log.info('Band finished', {
          heightRange: outcome.heightRange,
          result: outcome.result,
          rows: outcome.rows,
          seconds: Math.round(outcome.seconds),
        }),
    });
    const imported = run.outcomes.filter((o) => o.result === 'imported');
    const refused = run.outcomes.find((o) => o.result === 'refused');
    const answer = {
      coreDb,
      bandsDir,
      haveTo: run.haveTo,
      imported: imported.length,
      rows: imported.reduce((sum, o) => sum + (o.rows ?? 0), 0),
      missingTransactions: imported.reduce(
        (sum, o) => sum + (o.missingTransactions ?? 0),
        0,
      ),
      ...(run.holes.length > 0 ? { holes: run.holes } : {}),
      skipped: run.skipped.map((b) => ({
        heightRange: b.heightRange,
        reason: b.reason,
      })),
      ...(refused !== undefined ? { refused: refused.reason } : {}),
      bands: run.outcomes.map(describe),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    // A refused band stops the run, so the command failed, even though
    // the bands below it were imported and kept. Thrown rather than
    // returned so the CLI exits 1 and a script notices.
    if (refused !== undefined) throw answer;
    return answer;
  } finally {
    await duck.close();
    if (spill !== undefined) {
      await fsp.rm(spill, { recursive: true, force: true });
    }
    db.pragma('locking_mode = NORMAL');
    db.close();
    lock.close();
  }
}
