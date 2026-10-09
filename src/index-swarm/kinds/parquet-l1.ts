/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `parquet-l1` artifact kind: bands of the Arweave base layer (L1) in
 * Parquet (layout in `src/lib/parquet-l1/layout.ts`), shared so a new gateway
 * can import its L1 index instead of indexing the chain block by block.
 *
 * The sidecar checks bytes, not the chain: digests against the signed
 * publication, then here each file's footer and schema against the layout
 * and the row counts the band declares. Checks against the chain belong to
 * the importer, which has a node to ask. Installed bands go under
 * `installed/parquet-l1/` for the importer; the gateway itself reads none.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import { BandDescriptor, BandFile } from '../../lib/index-publication.js';
import { checkParquetFile, openFooterReader } from '../../lib/parquet/check.js';
import {
  BAND_FILE,
  bandFiles,
  isL1BandRange,
  L1_SPAN,
  L1_SUB_SPAN,
  lookupsOf,
  MAX_BAND_FILE_BYTES,
  PARQUET_L1_SCHEMAS,
  PARQUET_L1_TABLES,
  parseBandFile,
  ParquetL1Band,
} from '../../lib/parquet-l1/layout.js';
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

export const PARQUET_L1_KIND = 'parquet-l1';

/** Every file name a band of any layout this build reads may hold. */
const KNOWN_FILES = new Set(PARQUET_L1_SCHEMAS.flatMap((s) => bandFiles(s)));

async function readBandFile(dir: string): Promise<ParquetL1Band> {
  const file = path.join(dir, BAND_FILE);
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat === undefined) {
    throw new Error(`Not a Parquet L1 band: ${file} is missing`);
  }
  if (stat.size > MAX_BAND_FILE_BYTES) {
    throw new Error(
      `${file} is ${stat.size} bytes, more than a band file holds`,
    );
  }
  return parseBandFile(await fs.readFile(file, 'utf8'));
}

export class ParquetL1Kind implements ArtifactKind {
  readonly kind = PARQUET_L1_KIND;
  readonly optIn = true;
  readonly liveFile = BAND_FILE;
  private readonly log: Logger;
  private readonly lifecycle: BandLifecycle;

  constructor({ log }: { log: Logger }) {
    this.log = log.child({ class: 'ParquetL1Kind' });
    this.lifecycle = {
      log: this.log,
      label: 'Parquet L1',
      liveFile: this.liveFile,
    };
  }

  async describe(dir: string): Promise<BandDescriptor> {
    const band = await readBandFile(dir);
    const limit = pLimit(2);
    // The files of the layout the band says it is: a lookup file beside an
    // older band.json (a derive interrupted before its rename) is not yet
    // part of the band, and is left out.
    const files: BandFile[] = await Promise.all(
      bandFiles(band.schema).map((name) =>
        limit(async () => {
          const filePath = path.join(dir, name);
          const stat = await fs.stat(filePath).catch(() => undefined);
          if (stat === undefined) {
            throw new Error(`Parquet L1 band at ${dir} lacks ${name}`);
          }
          return {
            name,
            size: stat.size,
            sha256: await sha256File(filePath),
          };
        }),
      ),
    );
    return {
      id: path.basename(dir),
      heightRange: band.heightRange,
      records: band.tables.transactions.rows,
      files,
      metadata: {
        schema: band.schema,
        ...(band.supersedes !== undefined
          ? { supersedes: band.supersedes }
          : {}),
      },
    };
  }

  async validate(band: BandDescriptor, dir: string): Promise<void> {
    // Names from a remote publisher become file names on disk: only names a
    // layout knows, before anything is read.
    const names = band.files.map((file) => file.name).sort();
    const unknown = names.filter((name) => !KNOWN_FILES.has(name));
    if (unknown.length > 0 || !names.includes(BAND_FILE)) {
      throw new Error(
        `Band ${band.id} holds ${JSON.stringify(names)}, not Parquet L1 files`,
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

    const described = declared;
    const [from, to] = described.heightRange;
    if (
      band.heightRange !== undefined &&
      (band.heightRange[0] !== from || band.heightRange[1] !== to)
    ) {
      throw new Error(
        `Band ${band.id}: the publication says heights ${JSON.stringify(band.heightRange)}, its ${BAND_FILE} says [${from}, ${to}]`,
      );
    }
    // Every publisher cuts the chain at the same heights, and a band's id
    // names its own: anything else is not a band of this layout.
    if (!isL1BandRange(from, to)) {
      throw new Error(
        `Band ${band.id}: heights [${from}, ${to}] are not a whole ${L1_SPAN}-height range, a whole ${L1_SUB_SPAN}-height sub-range, or a sub-range cut short at the chain's top`,
      );
    }
    if (!band.id.startsWith(`l1-h${from}-${to}-`)) {
      throw new Error(
        `Band ${band.id}: its id doesn't name its heights [${from}, ${to}]`,
      );
    }

    const db = await openFooterReader();
    try {
      for (const table of PARQUET_L1_TABLES) {
        await checkParquetFile(db, path.join(dir, table.file), {
          columns: table.columns,
          rows: described.tables[table.name].rows,
        });
      }
      // Lookups get the same footer check: their columns as the layout
      // declares them, and the rows their band says.
      for (const spec of lookupsOf(described.schema)) {
        await checkParquetFile(db, path.join(dir, spec.file), {
          columns: spec.columns,
          rows: described.lookups?.[spec.name]?.rows,
        });
      }
    } finally {
      await db.close();
    }

    this.log.debug('Validated Parquet L1 band', {
      id: band.id,
      heightRange: described.heightRange,
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
