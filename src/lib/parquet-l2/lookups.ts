/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A `parquet-l2` band's lookups: the layout's specs for the band
 * ({@link lookupsOf}) run by the dataset-agnostic engine over the band's
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
  lookupsOf,
  PARQUET_L2_LOOKUP_DIGEST_ORDER,
  PARQUET_L2_SCHEMA,
  PARQUET_L2_TABLES,
  ParquetL2Band,
  ParquetL2LookupLayout,
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
 * Writes the lookups of the band in `bandDir`, from its tables, and returns
 * their descriptions, for `band.json`. The band's layout (the one written,
 * with no key or stat tags, unless given) says which; `only` names a
 * subset, as a derive adds the files an older layout lacks; `outDir` puts
 * them somewhere other than beside the tables.
 */
export async function writeBandLookups(
  duck: Database,
  bandDir: string,
  {
    layout = { schema: PARQUET_L2_SCHEMA, keyTags: [], statTags: [] },
    only,
    outDir = bandDir,
  }: {
    layout?: ParquetL2LookupLayout;
    only?: readonly string[];
    outDir?: string;
  } = {},
): Promise<Record<string, LookupDescription>> {
  const tables = bandTableFiles(bandDir);
  const described: Record<string, LookupDescription> = {};
  for (const spec of lookupsOf(layout)) {
    if (only !== undefined && !only.includes(spec.name)) continue;
    described[spec.name] = await writeLookup(duck, spec, tables, outDir, {
      order: PARQUET_L2_LOOKUP_DIGEST_ORDER,
    });
  }
  return described;
}

/**
 * Checks every lookup of a band against its `band.json` and its tables:
 * the files in `lookupsDir` (the band's directory unless given, as a
 * derive checks what it wrote before moving it in), `only` those named
 * when given.
 *
 * @returns what is wrong, by file, empty when every lookup matches.
 */
export async function verifyBandLookups(
  duck: Database,
  bandDir: string,
  band: Pick<ParquetL2Band, 'lookups'> & ParquetL2LookupLayout,
  {
    only,
    lookupsDir = bandDir,
  }: { only?: readonly string[]; lookupsDir?: string } = {},
): Promise<string[]> {
  const tables = bandTableFiles(bandDir);
  const problems: string[] = [];
  for (const spec of lookupsOf(band)) {
    if (only !== undefined && !only.includes(spec.name)) continue;
    const declared = band.lookups[spec.name] as LookupDescription | undefined;
    if (declared === undefined) {
      problems.push(`${spec.file}: not described in the band`);
      continue;
    }
    problems.push(
      ...(await verifyLookup(
        duck,
        spec,
        path.join(lookupsDir, spec.file),
        tables,
        declared,
        { order: PARQUET_L2_LOOKUP_DIGEST_ORDER },
      )),
    );
  }
  return problems;
}
