/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A `parquet-l1` band's lookups: the layout's specs ({@link lookupsOf}) run
 * by the dataset-agnostic engine over the band's own table files. Shared by
 * the exporter, which writes them, and the verifier, which checks them, so
 * what is checked is what was written.
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
  lookupsOf,
  PARQUET_L1_SCHEMA,
  PARQUET_L1_TABLES,
  ParquetL1Band,
  ParquetL1Schema,
} from './layout.js';

/** A band directory's table files, by table name. */
export function bandTableFiles(bandDir: string): TableFiles {
  return Object.fromEntries(
    PARQUET_L1_TABLES.map((table) => [
      table.name,
      [path.join(bandDir, table.file)],
    ]),
  );
}

/**
 * Writes the lookups a layout declares for the band in `bandDir`, into
 * `outDir` (the band itself for a band being built, a staging directory for a
 * published band, whose files are moved in after). Returns their
 * descriptions, for `band.json`.
 */
export async function writeBandLookups(
  duck: Database,
  bandDir: string,
  outDir: string,
  schema: ParquetL1Schema = PARQUET_L1_SCHEMA,
): Promise<Record<string, LookupDescription>> {
  const tables = bandTableFiles(bandDir);
  const described: Record<string, LookupDescription> = {};
  for (const spec of lookupsOf(schema)) {
    described[spec.name] = await writeLookup(duck, spec, tables, outDir);
  }
  return described;
}

/**
 * Checks every lookup a band declares against its `band.json` and its tables.
 *
 * @returns what is wrong, by file, empty when every lookup matches.
 */
export async function verifyBandLookups(
  duck: Database,
  bandDir: string,
  band: ParquetL1Band,
): Promise<string[]> {
  const tables = bandTableFiles(bandDir);
  const problems: string[] = [];
  for (const spec of lookupsOf(band.schema)) {
    const declared = band.lookups?.[spec.name];
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
