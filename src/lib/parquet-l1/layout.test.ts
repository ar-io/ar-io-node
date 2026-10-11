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
import { describe, it } from 'node:test';

import {
  BAND_FILE,
  INSTALLED_GENERATION_SEPARATOR,
  readBandDirectory,
  bandFiles,
  bandTablesDigest,
  canonicalDataRoot,
  canonicalTxRoot,
  firstTagValue,
  lookupsCurrent,
  lookupsOf,
  PARQUET_L1_LOOKUPS,
  PARQUET_L1_SCHEMA,
  PARQUET_L1_SCHEMAS,
  PARQUET_L1_TABLES,
  parseBandFile,
  parsePublisherFile,
  PUBLISHER_FILE,
  bandSupersedes,
  bandTime,
  readPublisherFacts,
  serializeBandFile,
  tablesCurrent,
  writePublisherFacts,
} from './layout.js';
import { FORK_2_0 } from './chain.js';
import { GENERATION_SEPARATOR } from '../../index-swarm/subscriber.js';

const digest = 'a'.repeat(64);
/** A valid description of a band at `schema`, with its layout's lookups. */
const valid = (schema: string = PARQUET_L1_SCHEMA): any => ({
  version: 1,
  schema,
  heightRange: [0, 99_999],
  tables: Object.fromEntries(
    PARQUET_L1_TABLES.map((t) => [t.name, { rows: 5, rowDigest: digest }]),
  ),
  ...(schema === 'l1-3'
    ? {
        lookups: Object.fromEntries(
          PARQUET_L1_LOOKUPS.map((l) => [
            l.name,
            { rows: 7, rowDigest: digest },
          ]),
        ),
      }
    : {}),
  createdAt: '2026-10-02T00:00:00.000Z',
});

describe('parquet-l1 layout', () => {
  it('is a superset of the Parquet exporter’s columns', () => {
    const names = (table: string) =>
      PARQUET_L1_TABLES.find((t) => t.name === table)?.columns.map(
        (c) => c.name,
      ) ?? [];
    // The exporter's names (src/workers/parquet-exporter.ts), so tools that
    // read its files read these.
    for (const column of [
      'indep_hash',
      'height',
      'previous_block',
      'nonce',
      'hash',
      'block_timestamp',
      'tx_count',
      'block_size',
    ]) {
      assert.ok(names('blocks').includes(column), `blocks.${column}`);
    }
    for (const column of [
      'id',
      'height',
      'tag_index',
      'tag_name',
      'tag_value',
      'is_data_item',
    ]) {
      assert.ok(names('tags').includes(column), `tags.${column}`);
    }
    for (const column of [
      'id',
      'anchor',
      'owner_address',
      'data_root',
      'offset',
    ]) {
      assert.ok(
        names('transactions').includes(column),
        `transactions.${column}`,
      );
    }
  });

  it('names every file a band of each layout holds', () => {
    const tables = [
      BAND_FILE,
      'block_transactions.parquet',
      'blocks.parquet',
      'tags.parquet',
      'transactions.parquet',
      'wallets.parquet',
    ];
    assert.deepEqual(bandFiles('l1-1'), tables);
    assert.deepEqual(bandFiles('l1-2'), tables);
    assert.deepEqual(
      bandFiles('l1-3'),
      [
        ...tables,
        'lookup_tag.parquet',
        'lookup_tx_id.parquet',
        'lookup_wallet.parquet',
      ].sort(),
    );
  });

  it('declares lookups only from l1-3, each sorted by its key first', () => {
    assert.deepEqual(lookupsOf('l1-1'), []);
    assert.deepEqual(lookupsOf('l1-2'), []);
    assert.deepEqual(
      lookupsOf('l1-3').map((l) => l.name),
      ['tx_id', 'wallet', 'tag'],
    );
    for (const spec of PARQUET_L1_LOOKUPS) {
      const names = spec.columns.map((c) => c.name);
      // Every ordering column is a column, and the key column comes first.
      assert.ok(
        spec.orderBy.every((c) => names.includes(c)),
        spec.name,
      );
      assert.equal(spec.orderBy[0], names[0], spec.name);
      assert.equal(spec.columns[0].type, 'UBIGINT', spec.name);
    }
  });
});

describe('parseBandFile', () => {
  it('reads a valid band file', () => {
    const band = parseBandFile(
      JSON.stringify({ ...valid(), supersedes: ['l1-h0-99999-old'] }),
    );
    assert.deepEqual(band.heightRange, [0, 99_999]);
    assert.equal(band.tables.transactions.rows, 5);
    assert.deepEqual(band.supersedes, ['l1-h0-99999-old']);
  });

  it('reads a band written to an older layout, keeping its version', () => {
    const band = parseBandFile(JSON.stringify(valid('l1-1')));
    assert.equal(band.schema, 'l1-1');
    assert.notEqual(band.schema, PARQUET_L1_SCHEMA);
    assert.equal(band.lookups, undefined);
  });

  it('accepts every layout this build can read', () => {
    for (const schema of PARQUET_L1_SCHEMAS) {
      assert.equal(parseBandFile(JSON.stringify(valid(schema))).schema, schema);
    }
  });

  it('reads an l1-3 band’s lookups', () => {
    const band = parseBandFile(JSON.stringify(valid('l1-3')));
    assert.deepEqual(Object.keys(band.lookups ?? {}).sort(), [
      'tag',
      'tx_id',
      'wallet',
    ]);
    assert.equal(band.lookups?.tx_id.rows, 7);
  });

  it('keeps lookups out of the band’s id', () => {
    const withLookups = parseBandFile(JSON.stringify(valid('l1-3')));
    const without = parseBandFile(JSON.stringify(valid('l1-2')));
    assert.deepEqual(bandTablesDigest(withLookups), bandTablesDigest(without));
  });

  it('refuses anything malformed, naming what', () => {
    const refuse = (change: (band: any) => void, pattern: RegExp) => {
      const band: any = valid();
      change(band);
      assert.throws(() => parseBandFile(JSON.stringify(band)), pattern);
    };
    assert.throws(() => parseBandFile('{'), /not JSON/);
    assert.throws(() => parseBandFile('[]'), /must be an object/);
    refuse((b) => (b.version = 2), /version must be 1/);
    refuse((b) => (b.schema = 'l1-0'), /schema "l1-0" is not/);
    refuse((b) => (b.heightRange = [5, 4]), /heightRange/);
    refuse((b) => (b.heightRange = [0, 1.5]), /heightRange/);
    refuse((b) => (b.heightRange = [-1, 4]), /heightRange/);
    refuse((b) => (b.createdAt = 'yesterday'), /createdAt/);
    refuse(
      (b) => (b.tables.extra = { rows: 1, rowDigest: digest }),
      /unknown table "extra"/,
    );
    refuse((b) => delete b.tables.wallets, /table wallets needs/);
    refuse((b) => (b.tables.blocks.rowDigest = 'xyz'), /table blocks needs/);
    refuse((b) => (b.tables.blocks.rows = -1), /table blocks needs/);
    refuse((b) => (b.supersedes = 'one'), /supersedes must be a list/);
    refuse((b) => (b.supersedes = ['']), /supersedes must be a list/);
    // Lookups: exactly the layout's, and none before l1-3.
    refuse((b) => delete b.lookups, /layout l1-3 needs lookups/);
    refuse((b) => delete b.lookups.tag, /lookup tag needs/);
    refuse(
      (b) => (b.lookups.extra = { rows: 1, rowDigest: digest }),
      /unknown lookup "extra"/,
    );
    refuse((b) => (b.lookups.wallet.rowDigest = 'xyz'), /lookup wallet needs/);
    assert.throws(
      () =>
        parseBandFile(
          JSON.stringify({ ...valid('l1-2'), lookups: valid('l1-3').lookups }),
        ),
      /layout l1-2 has no lookups/,
    );
  });
});

describe('serializeBandFile', () => {
  /** Every object's keys in reverse, as another writer might order them. */
  const reversed = (value: any): any =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reversed(v)]),
        )
      : value;

  it('writes the same bytes whatever order the fields came in, and none of the publisher’s own', () => {
    const a = serializeBandFile(parseBandFile(JSON.stringify(valid())));
    const b = serializeBandFile(
      parseBandFile(
        JSON.stringify(
          reversed({ ...valid(), supersedes: ['l1-h0-99999-aaaaaaaa-1'] }),
        ),
      ),
    );
    assert.equal(a, b);
    assert.doesNotMatch(a, /supersedes/);
    assert.deepEqual(parseBandFile(a), parseBandFile(JSON.stringify(valid())));
  });

  it('writes tables and lookups in the layout’s order', () => {
    const json = JSON.parse(
      serializeBandFile(parseBandFile(JSON.stringify(reversed(valid())))),
    );
    assert.deepEqual(Object.keys(json), [
      'version',
      'schema',
      'heightRange',
      'tables',
      'lookups',
      'createdAt',
    ]);
    assert.deepEqual(
      Object.keys(json.tables),
      PARQUET_L1_TABLES.map((t) => t.name),
    );
    assert.deepEqual(
      Object.keys(json.lookups),
      PARQUET_L1_LOOKUPS.map((l) => l.name),
    );
  });

  it('writes an older layout without lookups', () => {
    const json = JSON.parse(
      serializeBandFile(parseBandFile(JSON.stringify(valid('l1-2')))),
    );
    assert.equal(json.lookups, undefined);
    assert.equal(json.schema, 'l1-2');
  });
});

describe('bandTime', () => {
  it('dates a band by its top block, in seconds', () => {
    assert.equal(bandTime(1_700_000_000), '2023-11-14T22:13:20.000Z');
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => bandTime(bad), Error, String(bad));
    }
  });
});

describe('the publisher’s facts beside a band', () => {
  it('reads none where there are none, and what was written where there are', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-facts-'));
    try {
      assert.equal(await readPublisherFacts(dir), undefined);
      const facts = {
        supersedes: ['l1-h0-99999-aaaaaaaa-000000000001'],
        builtAt: '2026-10-11T04:00:20.418Z',
      };
      await writePublisherFacts(dir, facts);
      assert.deepEqual(await readPublisherFacts(dir), facts);
      assert.deepEqual(await fs.readdir(dir), [PUBLISHER_FILE]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed facts file rather than half-read it', () => {
    for (const text of [
      'not json',
      '[]',
      '{"supersedes":"one"}',
      '{"supersedes":[""]}',
      '{"builtAt":"yesterday"}',
    ]) {
      assert.throws(() => parsePublisherFile(text), Error, text);
    }
  });

  it('takes what a band replaces from the facts, else from a band.json written before them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-facts-'));
    try {
      const older = parseBandFile(
        JSON.stringify({ ...valid(), supersedes: ['l1-old'] }),
      );
      assert.deepEqual(await bandSupersedes({ dir, band: older }), ['l1-old']);
      await writePublisherFacts(dir, { supersedes: ['l1-newer'] });
      assert.deepEqual(await bandSupersedes({ dir, band: older }), [
        'l1-newer',
      ]);
      const settled = parseBandFile(JSON.stringify(valid()));
      await writePublisherFacts(dir, {});
      assert.equal(await bandSupersedes({ dir, band: settled }), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readBandDirectory', () => {
  const ID = 'l1-h0-99999-f5b1208c-0123456789ab';
  const write = async (dir: string, name: string, band: object) => {
    await fs.mkdir(path.join(dir, name));
    await fs.writeFile(path.join(dir, name, BAND_FILE), JSON.stringify(band));
  };

  it('splits on the separator the sidecar installs bands under', () => {
    assert.equal(INSTALLED_GENERATION_SEPARATOR, GENERATION_SEPARATOR);
  });

  it('names a band the sidecar installed by its band id, as it names a published one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'band-dir-'));
    try {
      const other = 'l1-h100000-199999-f5b1208c-0123456789ab';
      await write(dir, `${ID}${GENERATION_SEPARATOR}aaaaaaaaaaaa`, valid());
      await write(dir, other, { ...valid(), heightRange: [100_000, 199_999] });
      const found = await readBandDirectory(dir);
      assert.deepEqual(found.map((b) => b.id).sort(), [ID, other]);
      const installed = found.find((b) => b.id === ID);
      assert.equal(
        path.basename(installed?.dir ?? ''),
        `${ID}${GENERATION_SEPARATOR}aaaaaaaaaaaa`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns one copy of a band held in two generations: the one changed last', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'band-dir-'));
    try {
      await write(dir, `${ID}${GENERATION_SEPARATOR}aaaaaaaaaaaa`, valid());
      await new Promise((resolve) => setTimeout(resolve, 50));
      await write(dir, `${ID}${GENERATION_SEPARATOR}bbbbbbbbbbbb`, {
        ...valid(),
        createdAt: '2026-10-11T00:00:00.000Z',
      });
      const found = await readBandDirectory(dir);
      assert.equal(found.length, 1);
      assert.equal(found[0].id, ID);
      assert.equal(
        path.basename(found[0].dir),
        `${ID}${GENERATION_SEPARATOR}bbbbbbbbbbbb`,
      );
      assert.equal(found[0].band.createdAt, '2026-10-11T00:00:00.000Z');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never lets a copy that disagrees with its id hide one that agrees, however new', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'band-dir-'));
    try {
      await write(dir, `${ID}${GENERATION_SEPARATOR}aaaaaaaaaaaa`, valid());
      await new Promise((resolve) => setTimeout(resolve, 50));
      await write(dir, `${ID}${GENERATION_SEPARATOR}bbbbbbbbbbbb`, {
        ...valid(),
        heightRange: [100_000, 199_999],
      });
      const found = await readBandDirectory(dir);
      assert.equal(found.length, 1);
      assert.equal(
        path.basename(found[0].dir),
        `${ID}${GENERATION_SEPARATOR}aaaaaaaaaaaa`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('canonicalTxRoot', () => {
  const root = Buffer.alloc(32, 7);

  it('drops a pre-fork tx_root, whatever a gateway stored', () => {
    // The field is not committed by a pre-fork block hash and cannot be
    // recomputed, so publishers hold different things: 32 bytes, nothing,
    // or the empty string an ar-io-node writes. All of them mean absent.
    for (const stored of [root, null, undefined, Buffer.alloc(0), '']) {
      assert.equal(canonicalTxRoot(0, stored), null);
      assert.equal(canonicalTxRoot(FORK_2_0 - 1, stored), null);
    }
  });

  it('keeps a tx_root from the fork up', () => {
    assert.deepEqual(canonicalTxRoot(FORK_2_0, root), root);
    assert.deepEqual(canonicalTxRoot(FORK_2_0 + 1_000_000, root), root);
    assert.deepEqual(canonicalTxRoot(FORK_2_0, new Uint8Array(root)), root);
  });

  it('keeps empty bytes from the fork up: a block with no transactions', () => {
    // Above the fork an empty tx_root is the real value, and every
    // publisher stores it, so normalising it would change rows for nothing.
    assert.deepEqual(
      canonicalTxRoot(FORK_2_0, Buffer.alloc(0)),
      Buffer.alloc(0),
    );
    assert.deepEqual(canonicalTxRoot(FORK_2_0, ''), Buffer.alloc(0));
    assert.equal(canonicalTxRoot(FORK_2_0, null), null);
    assert.equal(canonicalTxRoot(FORK_2_0, undefined), null);
  });
});

describe('tablesCurrent and lookupsCurrent', () => {
  it('counts l1-2 and l1-3 tables as current, or l1-1 confirmed identical', () => {
    const none = new Set<string>();
    assert.equal(tablesCurrent('l1-3', 'x', none), true);
    assert.equal(tablesCurrent('l1-2', 'x', none), true);
    assert.equal(tablesCurrent('l1-1', 'x', none), false);
    assert.equal(tablesCurrent('l1-1', 'x', new Set(['x'])), true);
    assert.equal(tablesCurrent('l1-1', 'x', new Set(['y'])), false);
  });

  it('counts lookups as current only at the current layout', () => {
    assert.equal(lookupsCurrent(PARQUET_L1_SCHEMA), true);
    assert.equal(lookupsCurrent('l1-2'), false);
    assert.equal(lookupsCurrent('l1-1'), false);
  });
});

describe('canonicalDataRoot', () => {
  const root = Buffer.alloc(32, 9);

  it('drops a format-1 data_root, which no header carries', () => {
    assert.equal(canonicalDataRoot(1, root), null);
    assert.equal(canonicalDataRoot(1, Buffer.alloc(0)), null);
    assert.equal(canonicalDataRoot(1, null), null);
  });

  it('keeps a format-2 data_root as signed, empty or not', () => {
    assert.deepEqual(canonicalDataRoot(2, root), root);
    assert.deepEqual(canonicalDataRoot(2, Buffer.alloc(0)), Buffer.alloc(0));
    assert.equal(canonicalDataRoot(2, null), null);
  });
});

describe('firstTagValue', () => {
  const tag = (index: number, name: string, value: string) => ({
    index,
    name: Buffer.from(name),
    value: Buffer.from(value),
  });

  it('takes the lowest-positioned match, wherever it sits in the list', () => {
    // Two Content-Type tags, as on lM58RgBOp1lV… (video/MP2T, then text/vtt).
    const tags = [
      tag(4, 'Content-Type', 'text/vtt'),
      tag(1, 'App-Name', 'x'),
      tag(0, 'Content-Type', 'video/MP2T'),
    ];
    assert.equal(firstTagValue(tags, 'Content-Type'), 'video/MP2T');
  });

  it('compares names without case, and values as written', () => {
    assert.equal(
      firstTagValue([tag(2, 'content-encoding', 'UTF-8')], 'Content-Encoding'),
      'UTF-8',
    );
  });

  it('is null when there is no such tag', () => {
    assert.equal(
      firstTagValue([tag(0, 'App-Name', 'x')], 'Content-Type'),
      null,
    );
    assert.equal(firstTagValue([], 'Content-Type'), null);
  });
});
