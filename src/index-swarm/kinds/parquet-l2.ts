/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `parquet-l2` artifact kind: bands of the ANS-104 data items (L2) a
 * declared selection takes, in Parquet (layout in
 * `src/lib/parquet-l2/layout.ts`), shared so a gateway can import one app's
 * data items instead of unbundling the chain for them.
 *
 * Checked as an L1 band is: digests against the signed publication, then
 * here the file set, each file's footer and schema against the layout and
 * the row counts the band declares (its lookup files' as its tables'), and its heights on the L1 grid. One
 * check more: every band of an index declares the same selection, in its
 * `band.json`, in the publication's metadata for it, and in the index's
 * `filter` when the publisher sets one. Checks of the rows themselves
 * belong to an importer. Installed bands go under `installed/<index>/`,
 * where `index-l2-import` (`L2_BAND_IMPORT_ENABLED`) verifies them row by
 * row and loads them into ClickHouse.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import {
  BandDescriptor,
  BandFile,
  IndexEntry,
} from '../../lib/index-publication.js';
import { checkParquetFile, openFooterReader } from '../../lib/parquet/check.js';
import {
  isL1BandRange,
  L1_SPAN,
  L1_SUB_SPAN,
  readPublisherFacts,
} from '../../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  bandFiles,
  bandTablesDigest,
  idHeightRange,
  MAX_BAND_FILE_BYTES,
  lookupsOf,
  PARQUET_L2_SCHEMAS,
  PARQUET_L2_TABLES,
  parseBandFile,
  ParquetL2Band,
  parseSelection,
  serializeSelection,
} from '../../lib/parquet-l2/layout.js';
import { sha256File } from '../../lib/sha256-file.js';
import {
  BandLifecycle,
  installBand,
  retireBand,
  sweepRetiredBands,
} from './lifecycle.js';
import {
  ArtifactKind,
  InstallRequest,
  InstalledSet,
  RetireRequest,
  SweepRequest,
} from './types.js';

export const PARQUET_L2_KIND = 'parquet-l2';

/** Every file name a band of any layout this build reads may hold. */
const KNOWN_FILES = new Set(PARQUET_L2_SCHEMAS.flatMap((s) => bandFiles(s)));

async function readBandFile(dir: string): Promise<ParquetL2Band> {
  const file = path.join(dir, BAND_FILE);
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat === undefined) {
    throw new Error(`Not a Parquet L2 band: ${file} is missing`);
  }
  if (stat.size > MAX_BAND_FILE_BYTES) {
    throw new Error(
      `${file} is ${stat.size} bytes, more than a band file holds`,
    );
  }
  return parseBandFile(await fs.readFile(file, 'utf8'));
}

/**
 * The one selection the signed publication declares for `band` and every
 * other band of its index (each band's `metadata.selection`), and for the
 * index itself when it has a `filter`, as one line of JSON.
 *
 * @throws when one of them declares none, or two disagree: an index of
 *   mixed selections is not one dataset, and none of its bands is taken.
 */
function offeredSelection(index: IndexEntry, band: BandDescriptor): string {
  const read = (raw: unknown, what: string) => {
    try {
      return serializeSelection(parseSelection(raw, what));
    } catch (error) {
      throw new Error(`Index ${index.name}: ${(error as Error).message}`);
    }
  };
  const selection = read(
    band.metadata?.selection,
    `band ${band.id}'s selection`,
  );
  const others = index.bands.map((other): [unknown, string] => [
    other.metadata?.selection,
    `band ${other.id}'s selection`,
  ]);
  if (index.filter !== undefined) others.unshift([index.filter, 'its filter']);
  for (const [raw, what] of others) {
    const other = read(raw, what);
    if (other !== selection) {
      throw new Error(
        `Index ${index.name} mixes selections: ${what} is ${other}, band ${band.id}'s ${selection}`,
      );
    }
  }
  return selection;
}

export class ParquetL2Kind implements ArtifactKind {
  readonly kind = PARQUET_L2_KIND;
  readonly optIn = true;
  readonly liveFile = BAND_FILE;
  private readonly log: Logger;
  private readonly lifecycle: BandLifecycle;

  constructor({ log }: { log: Logger }) {
    this.log = log.child({ class: 'ParquetL2Kind' });
    this.lifecycle = {
      log: this.log,
      label: 'Parquet L2',
      liveFile: this.liveFile,
    };
  }

  async describe(dir: string): Promise<BandDescriptor> {
    const band = await readBandFile(dir);
    const limit = pLimit(2);
    const files: BandFile[] = await Promise.all(
      bandFiles(band.schema).map((name) =>
        limit(async () => {
          const filePath = path.join(dir, name);
          const stat = await fs.stat(filePath).catch(() => undefined);
          if (stat === undefined) {
            throw new Error(`Parquet L2 band at ${dir} lacks ${name}`);
          }
          return {
            name,
            size: stat.size,
            sha256: await sha256File(filePath),
          };
        }),
      ),
    );
    // What the band replaces is this publisher's own, kept beside the band:
    // it goes in the signed publication, never in the band's files.
    const supersedes = (await readPublisherFacts(dir))?.supersedes;
    return {
      id: path.basename(dir),
      heightRange: band.heightRange,
      records: band.tables.data_items.rows,
      files,
      metadata: {
        schema: band.schema,
        // In the publication too, so a subscriber sees an index's selection
        // across its bands without fetching them.
        selection: band.selection,
        ...(supersedes !== undefined ? { supersedes } : {}),
      },
    };
  }

  async validate(
    band: BandDescriptor,
    dir: string,
    index: IndexEntry,
  ): Promise<void> {
    // Names from a remote publisher become file names on disk: only names a
    // layout knows, before anything is read.
    const names = band.files.map((file) => file.name).sort();
    const unknown = names.filter((name) => !KNOWN_FILES.has(name));
    if (unknown.length > 0 || !names.includes(BAND_FILE)) {
      throw new Error(
        `Band ${band.id} holds ${JSON.stringify(names)}, not Parquet L2 files`,
      );
    }
    // Then exactly the files of the layout its band.json names.
    const declared = await readBandFile(dir);
    const expected = bandFiles(declared.schema);
    if (
      names.length !== expected.length ||
      names.some((name, i) => name !== expected[i])
    ) {
      throw new Error(
        `Band ${band.id} holds ${JSON.stringify(names)}, not the ${declared.schema} files ${JSON.stringify(expected)}`,
      );
    }
    for (const file of band.files) {
      const stat = await fs
        .stat(path.join(dir, file.name))
        .catch(() => undefined);
      if (stat === undefined)
        throw new Error(`Band ${band.id} is missing ${file.name}`);
      if (stat.size !== file.size) {
        throw new Error(
          `Band ${band.id}: ${file.name} is ${stat.size} bytes, the publication says ${file.size}`,
        );
      }
    }

    const [from, to] = declared.heightRange;
    if (
      band.heightRange !== undefined &&
      (band.heightRange[0] !== from || band.heightRange[1] !== to)
    ) {
      throw new Error(
        `Band ${band.id}: the publication says heights ${JSON.stringify(band.heightRange)}, its ${BAND_FILE} says [${from}, ${to}]`,
      );
    }
    // The L1 grid: every publisher cuts at the same heights.
    if (!isL1BandRange(from, to)) {
      throw new Error(
        `Band ${band.id}: heights [${from}, ${to}] are not a whole ${L1_SPAN}-height range, a whole ${L1_SUB_SPAN}-height sub-range, or a sub-range cut short at the chain's top`,
      );
    }
    // A band's id names its heights and the digest of what it holds, the
    // selection included, so a band can't be served under another's id.
    const named = idHeightRange(band.id);
    if (named === undefined || named[0] !== from || named[1] !== to) {
      throw new Error(
        `Band ${band.id}: its id doesn't name its heights [${from}, ${to}]`,
      );
    }
    const digest = bandTablesDigest(declared).toString('hex').slice(0, 12);
    if (!band.id.endsWith(`-${digest}`)) {
      throw new Error(
        `Band ${band.id}: its id doesn't name its rows and selection (digest ${digest})`,
      );
    }
    const selection = serializeSelection(declared.selection);
    const offered = offeredSelection(index, band);
    if (selection !== offered) {
      throw new Error(
        `Band ${band.id}: its ${BAND_FILE} selects ${selection}, the publication ${offered}`,
      );
    }

    const db = await openFooterReader();
    try {
      for (const table of PARQUET_L2_TABLES) {
        await checkParquetFile(db, path.join(dir, table.file), {
          columns: table.columns,
          rows: declared.tables[table.name].rows,
        });
      }
      // Lookups get the same footer check: their columns as the layout
      // declares them (the key and stats files' by the band's tag names),
      // and the rows their band says.
      for (const spec of lookupsOf(declared)) {
        await checkParquetFile(db, path.join(dir, spec.file), {
          columns: spec.columns,
          rows: declared.lookups[spec.name].rows,
        });
      }
    } finally {
      await db.close();
    }

    this.log.debug('Validated Parquet L2 band', {
      id: band.id,
      heightRange: declared.heightRange,
      selection,
    });
  }

  async install(request: InstallRequest): Promise<InstalledSet> {
    return installBand(request, this.lifecycle);
  }

  async retire(request: RetireRequest): Promise<InstalledSet> {
    // Removing band.json takes the band out of an importer's view.
    return retireBand(request, this.lifecycle);
  }

  async sweepRetired(request: SweepRequest): Promise<InstalledSet> {
    return sweepRetiredBands(request, this.lifecycle);
  }
}
