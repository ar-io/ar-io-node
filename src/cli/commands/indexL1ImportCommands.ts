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
import Sqlite from 'better-sqlite3';
import { Logger } from 'winston';

import { ImportRefused, runImport } from '../../lib/parquet-l1/import.js';
import type { IndexL1ImportCLIOptions, JsonSerializable } from '../types.js';
import { requiredStringFromOptions } from '../utils.js';

export interface IndexL1ImportDeps {
  log: Logger;
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

  const started = Date.now();
  let db: Sqlite.Database;
  try {
    db = new Sqlite(coreDb, { fileMustExist: true });
  } catch (error) {
    throw new ImportRefused(
      `Cannot open ${coreDb}: ${(error as Error).message}`,
    );
  }
  // The gateway's own setting; an import writes far more than a normal run.
  db.pragma('journal_mode = WAL');

  const { Database } = await import('duckdb-async');
  const duck = await Database.create(':memory:');
  try {
    await duck.exec(
      "SET memory_limit = '1GB'; SET threads = 2; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;",
    );
    const run = await runImport({
      db,
      duck,
      bandsDir,
      log,
      ...(maxBands !== undefined ? { limit: maxBands } : {}),
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
    return {
      coreDb,
      bandsDir,
      haveTo: run.haveTo,
      imported: imported.length,
      rows: imported.reduce((sum, o) => sum + (o.rows ?? 0), 0),
      missingTransactions: imported.reduce(
        (sum, o) => sum + (o.missingTransactions ?? 0),
        0,
      ),
      skipped: run.skipped.length,
      ...(refused !== undefined ? { refused: refused.reason } : {}),
      bands: run.outcomes.map((o) => ({
        heightRange: o.heightRange,
        result: o.result,
        rows: o.rows,
        seconds: Math.round(o.seconds),
      })),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    await duck.close();
    db.close();
  }
}
