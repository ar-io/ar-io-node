/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BandDescriptor, IndexEntry } from '../../lib/index-publication.js';
import { openFooterReader } from '../../lib/parquet/check.js';
import type { ColumnSpec } from '../../lib/parquet/check.js';
import { writePublisherFacts } from '../../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  bandFiles,
  l2BandId,
  lookupsOf,
  PARQUET_L2_LOOKUPS,
  PARQUET_L2_TABLES,
  ParquetL2Band,
  ParquetL2Selection,
  serializeBandFile,
} from '../../lib/parquet-l2/layout.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { takesIndex } from '../subscriber.js';
import { ParquetL2Kind } from './parquet-l2.js';
import { createKindRegistry } from './registry.js';

const log = createTestLogger({ suite: 'ParquetL2Kind' });

const TAG = 'f5b1208c';
const SELECTION: ParquetL2Selection = {
  kind: 'ans104-data-items',
  tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
};
const OTHER: ParquetL2Selection = {
  kind: 'ans104-data-items',
  tag: {
    name: 'App-Name',
    valuePrefix: 'ArDrive',
    excludeValuePrefix: 'ArDrive-Test',
  },
};

/** Writes `rows` rows of a table, every column null, in the layout's types. */
async function writeTable(
  file: string,
  table: { columns: ColumnSpec[] },
  rows: number,
  override: Record<string, string> = {},
): Promise<void> {
  const db = await openFooterReader();
  try {
    const columns = table.columns
      .map((c) => `CAST(NULL AS ${override[c.name] ?? c.type}) AS "${c.name}"`)
      .join(', ');
    await db.exec(
      `COPY (SELECT ${columns} FROM range(${rows})) TO '${file}' (FORMAT PARQUET)`,
    );
  } finally {
    await db.close();
  }
}

/** A band's description, 3 rows a table and a lookup. */
const described = (
  heightRange: [number, number] = [0, 99_999],
  selection: ParquetL2Selection = SELECTION,
): ParquetL2Band => ({
  version: 1,
  schema: 'l2-1',
  heightRange,
  selection,
  tables: Object.fromEntries(
    PARQUET_L2_TABLES.map((t) => [
      t.name,
      { rows: 3, rowDigest: 'b'.repeat(64) },
    ]),
  ),
  lookups: Object.fromEntries(
    PARQUET_L2_LOOKUPS.map((l) => [
      l.name,
      { rows: 3, rowDigest: 'b'.repeat(64) },
    ]),
  ),
  createdAt: '2026-10-02T00:00:00.000Z',
});

/** The index entry a band was offered in, as the subscriber passes it. */
const indexOf = (
  ...bands: BandDescriptor[]
): IndexEntry & { filter?: unknown } => ({
  name: 'ardrive-l2',
  kind: 'parquet-l2',
  bands,
});

describe('ParquetL2Kind', () => {
  let root: string;
  let band: string;
  let id: string;
  const kind = new ParquetL2Kind({ log });

  /** Rewrites band.json; returns the id the band now has. */
  const rewrite = async (next: ParquetL2Band): Promise<string> => {
    await fs.writeFile(path.join(band, BAND_FILE), serializeBandFile(next));
    return l2BandId(next, TAG);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-'));
    id = l2BandId(described(), TAG);
    band = path.join(root, id);
    await fs.mkdir(band);
    for (const table of [...PARQUET_L2_TABLES, ...PARQUET_L2_LOOKUPS]) {
      await writeTable(path.join(band, table.file), table, 3);
    }
    await rewrite(described());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is registered, and taken only from a subscription that names it', () => {
    const registered = createKindRegistry({ log }).get('parquet-l2');
    assert.ok(registered instanceof ParquetL2Kind);
    assert.equal(takesIndex({}, 'ardrive-l2', registered), false);
    assert.equal(
      takesIndex({ name: 'ardrive-l2' }, 'ardrive-l2', registered),
      true,
    );
  });

  it('describes a band: its files, heights, rows, selection and what it supersedes', async () => {
    await writePublisherFacts(band, { supersedes: ['l2-h0-99999-old'] });
    const descriptor = await kind.describe(band);
    assert.equal(descriptor.id, id);
    assert.deepEqual(descriptor.heightRange, [0, 99_999]);
    assert.equal(descriptor.records, 3);
    // The facts file is the publisher's, never one of the band's files.
    assert.deepEqual(
      descriptor.files.map((f) => f.name),
      bandFiles('l2-1'),
    );
    assert.ok(descriptor.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.deepEqual(descriptor.metadata, {
      schema: 'l2-1',
      selection: SELECTION,
      supersedes: ['l2-h0-99999-old'],
    });
  });

  it('validates a band of the layout, with or without the index naming its selection', async () => {
    const descriptor = await kind.describe(band);
    await kind.validate(descriptor, band, indexOf(descriptor));
    // A filter is compared as a selection, not as bytes.
    await kind.validate(descriptor, band, {
      ...indexOf(descriptor),
      filter: {
        tag: { valuePrefix: 'ArDrive', name: 'App-Name' },
        kind: 'ans104-data-items',
      },
    });
  });

  it('refuses another file set, a missing file or a size the publication didn’t sign', async () => {
    const descriptor = await kind.describe(band);
    const foreign = {
      ...descriptor,
      files: [
        ...descriptor.files,
        { name: 'extra.bin', size: 1, sha256: 'c'.repeat(64) },
      ],
    };
    await assert.rejects(
      kind.validate(foreign, band, indexOf(foreign)),
      /not Parquet L2 files/,
    );
    const escape = {
      ...descriptor,
      files: [
        ...descriptor.files,
        { name: '../escape.parquet', size: 1, sha256: 'c'.repeat(64) },
      ],
    };
    await assert.rejects(
      kind.validate(escape, band, indexOf(escape)),
      /not Parquet L2 files/,
    );
    const short = {
      ...descriptor,
      files: descriptor.files.filter((f) => f.name !== 'parents.parquet'),
    };
    await assert.rejects(
      kind.validate(short, band, indexOf(short)),
      /not the l2-1 files/,
    );
    await fs.rm(path.join(band, 'tags.parquet'));
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /missing tags\.parquet/,
    );
    await writeTable(
      path.join(band, 'tags.parquet'),
      PARQUET_L2_TABLES[1],
      5000,
    );
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /bytes, the publication says/,
    );
  });

  it('validates an l2-2 band with its key lookup and stats, and refuses it without them', async () => {
    const layout = {
      schema: 'l2-2' as const,
      keyTags: ['Drive-Id'],
      statTags: ['Content-Type'],
    };
    const next: ParquetL2Band = {
      ...described(),
      ...layout,
      lookups: Object.fromEntries(
        lookupsOf(layout).map((l) => [
          l.name,
          { rows: 3, rowDigest: 'b'.repeat(64) },
        ]),
      ),
    };
    for (const spec of lookupsOf(layout).slice(3)) {
      await writeTable(path.join(band, spec.file), spec, 3);
    }
    // The same rows: the same id.
    assert.equal(await rewrite(next), id);
    const descriptor = await kind.describe(band);
    assert.deepEqual(
      descriptor.files.map((f) => f.name),
      bandFiles('l2-2'),
    );
    assert.deepEqual(descriptor.metadata, {
      schema: 'l2-2',
      selection: SELECTION,
    });
    await kind.validate(descriptor, band, indexOf(descriptor));
    // A key lookup with other columns, or fewer rows than the band says.
    const key = lookupsOf(layout)[3];
    await writeTable(path.join(band, key.file), key, 2);
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /lookup_key\.parquet/,
    );
    await fs.rm(path.join(band, 'stats.parquet'));
    await assert.rejects(kind.describe(band), /lacks stats\.parquet/);
  });

  it('refuses a band.json of another layout', async () => {
    const descriptor = await kind.describe(band);
    const json = JSON.parse(
      await fs.readFile(path.join(band, BAND_FILE), 'utf8'),
    );
    await fs.writeFile(
      path.join(band, BAND_FILE),
      JSON.stringify({ ...json, schema: 'l1-3' }),
    );
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /schema "l1-3" is not one of l2-1/,
    );
    await assert.rejects(kind.describe(band), /schema "l1-3"/);
  });

  it('refuses heights the publication and the band file disagree on', async () => {
    const descriptor = await kind.describe(band);
    const other = { ...descriptor, heightRange: [0, 5] as [number, number] };
    await assert.rejects(
      kind.validate(other, band, indexOf(other)),
      /the publication says heights/,
    );
  });

  it('refuses heights off the L1 grid', async () => {
    for (const range of [
      [5, 99_999], // not on a boundary
      [100_000, 149_999], // neither a whole range nor a sub-range
      [100_000, 105_000], // past the end of its sub-range
    ] as Array<[number, number]>) {
      const next = await rewrite(described(range));
      const d = { ...(await kind.describe(band)), id: next };
      await assert.rejects(
        kind.validate(d, band, indexOf(d)),
        /are not a whole 100000-height range, a whole 5000-height sub-range, or a sub-range cut short/,
      );
    }
    // A whole sub-range and a tip are both fine.
    for (const range of [
      [100_000, 104_999],
      [100_000, 100_003],
    ] as Array<[number, number]>) {
      const next = await rewrite(described(range));
      const d = { ...(await kind.describe(band)), id: next };
      await kind.validate(d, band, indexOf(d));
    }
  });

  it('refuses an id that doesn’t name its heights, or its rows and selection', async () => {
    const descriptor = await kind.describe(band);
    for (const other of [
      'l2-h0-5-f5b1208c-0123456789ab',
      'l1-h0-99999-f5b1208c-0123456789ab',
      'l2-h0-99999-abc',
    ]) {
      const d = { ...descriptor, id: other };
      await assert.rejects(
        kind.validate(d, band, indexOf(d)),
        /doesn't name its heights \[0, 99999\]/,
        other,
      );
    }
    // Right heights, another digest: the id of a band of other rows.
    const d = { ...descriptor, id: `l2-h0-99999-${TAG}-0123456789ab` };
    await assert.rejects(
      kind.validate(d, band, indexOf(d)),
      /doesn't name its rows and selection/,
    );
    // The same rows under another selection are another band, so the id
    // written for this selection doesn't name a band that declares that one.
    await rewrite(described([0, 99_999], OTHER));
    const reselected = await kind.describe(band);
    assert.equal(reselected.id, descriptor.id);
    await assert.rejects(
      kind.validate(reselected, band, indexOf(reselected)),
      /doesn't name its rows and selection/,
    );
  });

  it('refuses a column of another type, or a row count the band file doesn’t say', async () => {
    const items = PARQUET_L2_TABLES[0];
    await writeTable(path.join(band, items.file), items, 3, {
      height: 'VARCHAR',
    });
    let descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /columns differ from the layout at 1: have "height VARCHAR", want "height UBIGINT"/,
    );
    // A nullable location column written as another type.
    await writeTable(path.join(band, items.file), items, 3, {
      offset: 'BIGINT',
    });
    descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /have "offset BIGINT", want "offset UBIGINT"/,
    );
    await writeTable(path.join(band, items.file), items, 7);
    descriptor = await kind.describe(band);
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /holds 7 rows, its band says 3/,
    );
  });

  it('refuses a missing lookup file, a lookup column of another type, or a lookup row count the band file doesn’t say', async () => {
    const descriptor = await kind.describe(band);
    // Without its lookups the file set is not the layout's.
    const bare = {
      ...descriptor,
      files: descriptor.files.filter((f) => !f.name.startsWith('lookup_')),
    };
    await assert.rejects(
      kind.validate(bare, band, indexOf(bare)),
      /not the l2-1 files/,
    );
    await fs.rm(path.join(band, 'lookup_tag.parquet'));
    await assert.rejects(
      kind.validate(descriptor, band, indexOf(descriptor)),
      /missing lookup_tag\.parquet/,
    );
    await assert.rejects(kind.describe(band), /lacks lookup_tag\.parquet/);
    const [id, wallet, tag] = PARQUET_L2_LOOKUPS;
    await writeTable(path.join(band, tag.file), tag, 3);

    await writeTable(path.join(band, wallet.file), wallet, 3, {
      role: 'INTEGER',
    });
    let current = await kind.describe(band);
    await assert.rejects(
      kind.validate(current, band, indexOf(current)),
      /have "role INTEGER", want "role UTINYINT"/,
    );
    await writeTable(path.join(band, wallet.file), wallet, 3);
    await writeTable(path.join(band, id.file), id, 4);
    current = await kind.describe(band);
    await assert.rejects(
      kind.validate(current, band, indexOf(current)),
      /holds 4 rows, its band says 3/,
    );
    // The band's id is its tables', whatever its lookups say.
    const recounted = described();
    recounted.lookups.id = { rows: 4, rowDigest: 'c'.repeat(64) };
    assert.equal(await rewrite(recounted), descriptor.id);
    current = await kind.describe(band);
    await kind.validate(current, band, indexOf(current));
  });

  describe('selection', () => {
    it('refuses a band whose band.json selects other items than the publication says', async () => {
      const descriptor = await kind.describe(band);
      const d = {
        ...descriptor,
        metadata: { ...descriptor.metadata, selection: OTHER },
      };
      await assert.rejects(
        kind.validate(d, band, indexOf(d)),
        /its band\.json selects .*"valuePrefix":"ArDrive"}}, the publication .*"excludeValuePrefix":"ArDrive-Test"/,
      );
    });

    it('refuses a band the publication declares no selection for', async () => {
      const descriptor = await kind.describe(band);
      const d = { ...descriptor, metadata: { schema: 'l2-1' } };
      await assert.rejects(
        kind.validate(d, band, indexOf(d)),
        new RegExp(
          `Index ardrive-l2: band ${d.id}'s selection must be an object`,
        ),
      );
    });

    it('refuses every band of an index that mixes selections', async () => {
      const descriptor = await kind.describe(band);
      const other: BandDescriptor = {
        id: `l2-h100000-104999-${TAG}-0123456789ab`,
        heightRange: [100_000, 104_999],
        files: descriptor.files,
        metadata: { schema: 'l2-1', selection: OTHER },
      };
      await assert.rejects(
        kind.validate(descriptor, band, indexOf(descriptor, other)),
        new RegExp(`mixes selections: band ${other.id}'s selection is`),
      );
    });

    it('refuses an index whose filter is another selection, or no selection at all', async () => {
      const descriptor = await kind.describe(band);
      await assert.rejects(
        kind.validate(descriptor, band, {
          ...indexOf(descriptor),
          filter: OTHER,
        }),
        /mixes selections: its filter is/,
      );
      // A root-TX index's filter is no selection.
      await assert.rejects(
        kind.validate(descriptor, band, {
          ...indexOf(descriptor),
          filter: { tags: [{ name: 'App-Name', value: 'ArDrive' }] },
        }),
        /Index ardrive-l2: its filter: unknown field "tags"/,
      );
    });
  });

  it('installs, retires and sweeps a band', async () => {
    const descriptor = await kind.describe(band);
    const target = path.join(root, 'installed', 'ardrive-l2', descriptor.id);
    let installed = await kind.install({
      band: descriptor,
      sourceDir: band,
      targetDir: target,
      current: {},
    });
    assert.ok(installed[descriptor.id] !== undefined);
    assert.deepEqual((await fs.readdir(target)).sort(), bandFiles('l2-1'));
    installed = await kind.retire({
      bandId: descriptor.id,
      dir: target,
      current: installed,
    });
    await assert.rejects(fs.stat(path.join(target, BAND_FILE)));
    installed = await kind.sweepRetired({
      current: installed,
      dirFor: () => target,
      graceMs: 0,
    });
    assert.deepEqual(installed, {});
    await assert.rejects(fs.stat(target));
  });
});
