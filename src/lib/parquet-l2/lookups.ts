/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A `parquet-l2` band's lookups: the layout's specs ({@link
 * PARQUET_L2_LOOKUPS}) run by the dataset-agnostic engine over the band's
 * own table files, as `src/lib/parquet-l1/lookups.ts` runs an L1 band's.
 * Shared by the exporter, which writes and checks them, and any verifier,
 * so what is checked is what was written.
 */
import * as path from 'node:path';
import type { Database } from 'duckdb-async';

import {
  LookupDescription,
  TableFiles,
  verifyLookup,
  writeLookup,
} from '../parquet/lookups.js';
import {
  PARQUET_L2_LOOKUPS,
  PARQUET_L2_TABLES,
  ParquetL2Band,
} from './layout.js';

/** A band directory's table files, by table name. */
export function bandTableFiles(bandDir: string): TableFiles {
  return Object.fromEntries(
    PARQUET_L2_TABLES.map((table) => [
      table.name,
      [path.join(bandDir, table.file)],
    ]),
  );
}

/**
 * Writes the band in `bandDir`'s lookups beside its tables, and returns
 * their descriptions, for `band.json`.
 */
export async function writeBandLookups(
  duck: Database,
  bandDir: string,
): Promise<Record<string, LookupDescription>> {
  const tables = bandTableFiles(bandDir);
  const described: Record<string, LookupDescription> = {};
  for (const spec of PARQUET_L2_LOOKUPS) {
    described[spec.name] = await writeLookup(duck, spec, tables, bandDir);
  }
  return described;
}

/**
 * Checks every lookup of a band against its `band.json` and its tables.
 *
 * @returns what is wrong, by file, empty when every lookup matches.
 */
export async function verifyBandLookups(
  duck: Database,
  bandDir: string,
  band: Pick<ParquetL2Band, 'lookups'>,
): Promise<string[]> {
  const tables = bandTableFiles(bandDir);
  const problems: string[] = [];
  for (const spec of PARQUET_L2_LOOKUPS) {
    const declared = band.lookups[spec.name] as LookupDescription | undefined;
    if (declared === undefined) {
      problems.push(`${spec.file}: not described in the band`);
      continue;
    }
    problems.push(
      ...(await verifyLookup(
        duck,
        spec,
        path.join(bandDir, spec.file),
        tables,
        declared,
      )),
    );
  }
  return problems;
}
