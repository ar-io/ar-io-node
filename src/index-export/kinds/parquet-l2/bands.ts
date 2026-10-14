/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * This publisher's live `parquet-l2` bands of one index, as published under
 * `<published>/<index name>/`: a readable `band.json` whose heights agree
 * with the directory's id, the publisher's tag in the id, and no other own
 * band superseding it (by the same rule as the sidecar's publication).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { supersededBands } from '../../../lib/index-publication.js';
import {
  BandPublisherFacts,
  INSTALLED_GENERATION_SEPARATOR,
  readPublisherFacts,
} from '../../../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  idHeightRange,
  MAX_BAND_FILE_BYTES,
  parseBandFile,
  ParquetL2Band,
  ParquetL2Selection,
  serializeSelection,
} from '../../../lib/parquet-l2/layout.js';
import { GridLayoutError } from '../root-tx/planner-grid.js';

export interface L2LiveBand {
  id: string;
  dir: string;
  from: number;
  to: number;
  band: ParquetL2Band;
  /** What only this publisher knows about it: what it replaces, when built and settled. */
  facts: BandPublisherFacts;
}

/** Every band of an index directory whose `band.json` reads, and whose id names its heights. */
export async function readL2BandDirectory(dir: string): Promise<L2LiveBand[]> {
  const found: L2LiveBand[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const id = name.split(INSTALLED_GENERATION_SEPARATOR)[0];
    if (id !== name) continue;
    const bandDir = path.join(dir, name);
    const file = path.join(bandDir, BAND_FILE);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat === undefined || stat.size > MAX_BAND_FILE_BYTES) continue;
    let band: ParquetL2Band;
    try {
      band = parseBandFile(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const named = idHeightRange(id);
    if (
      named === undefined ||
      named[0] !== band.heightRange[0] ||
      named[1] !== band.heightRange[1]
    ) {
      continue;
    }
    const facts =
      (await readPublisherFacts(bandDir).catch(() => undefined)) ?? {};
    found.push({
      id,
      dir: bandDir,
      from: band.heightRange[0],
      to: band.heightRange[1],
      band,
      facts,
    });
  }
  return found;
}

/**
 * This publisher's live bands of an index, by height. Every one must
 * declare the index's selection: an index whose selection changed is a new
 * index, under a new name, and a band of another selection here stops the
 * run (`grid_layout`).
 */
export async function deriveL2Bands(
  dir: string,
  publisher: string,
  selection: ParquetL2Selection,
): Promise<L2LiveBand[]> {
  const tag = bandPublisherTag(publisher);
  const own = (await readL2BandDirectory(dir)).filter(
    (band) => band.id.split('-')[3] === tag,
  );
  const superseded = supersededBands(
    own.map((band) => ({
      id: band.id,
      files: [],
      ...(band.facts.supersedes !== undefined
        ? { metadata: { supersedes: band.facts.supersedes } }
        : {}),
    })),
  );
  const live = own.filter((band) => !superseded.has(band.id));
  const wanted = serializeSelection(selection);
  const other = live.filter(
    (band) => serializeSelection(band.band.selection) !== wanted,
  );
  if (other.length > 0) {
    throw new GridLayoutError(
      `${dir} holds bands of another selection (${other
        .slice(0, 3)
        .map((band) => `${band.id}: ${serializeSelection(band.band.selection)}`)
        .join(
          '; ',
        )}), not ${wanted}: a changed selection is a new index, under a new name`,
    );
  }
  return live.sort((a, b) => a.from - b.from || a.to - b.to);
}
