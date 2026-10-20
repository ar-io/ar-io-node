/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import * as l1 from '../parquet-l1/layout.js';
import {
  BAND_FILE,
  bandFiles,
  bandTablesDigest,
  DATA_ITEM_LOCATION_COLUMNS,
  idHeightRange,
  l2BandId,
  L2_BAND_ID_PATTERN,
  MAX_BAND_FILE_BYTES,
  orderByClause,
  PARQUET_L2_LOOKUPS,
  PARQUET_L2_SCHEMA,
  PARQUET_L2_TABLES,
  parseBandFile,
  parseSelection,
  serializeBandFile,
  serializeSelection,
} from './layout.js';

const digest = 'a'.repeat(64);
const selection = () => ({
  kind: 'ans104-data-items',
  tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
});
/** A valid description of a band. */
const valid = (): any => ({
  version: 1,
  schema: PARQUET_L2_SCHEMA,
  heightRange: [0, 99_999],
  selection: selection(),
  tables: Object.fromEntries(
    PARQUET_L2_TABLES.map((t) => [t.name, { rows: 5, rowDigest: digest }]),
  ),
  lookups: Object.fromEntries(
    PARQUET_L2_LOOKUPS.map((l) => [l.name, { rows: 4, rowDigest: digest }]),
  ),
  createdAt: '2026-10-02T00:00:00.000Z',
});
const TAG = 'f5b1208c';

describe('parquet-l2 layout', () => {
  it('names every file a band holds: its description, one per table and one per lookup', () => {
    assert.deepEqual(
      PARQUET_L2_TABLES.map((t) => t.name),
      ['data_items', 'tags', 'wallets', 'parents'],
    );
    assert.deepEqual(
      PARQUET_L2_LOOKUPS.map((l) => l.name),
      ['id', 'wallet', 'tag'],
    );
    assert.deepEqual(bandFiles('l2-1'), [
      BAND_FILE,
      'data_items.parquet',
      'lookup_id.parquet',
      'lookup_tag.parquet',
      'lookup_wallet.parquet',
      'parents.parquet',
      'tags.parquet',
      'wallets.parquet',
    ]);
  });

  it("keys its lookups as an l1-3 band's, and takes L1's tag lookup unchanged", () => {
    const l1Specs = new Map(l1.PARQUET_L1_LOOKUPS.map((s) => [s.name, s]));
    const shape = (s: (typeof PARQUET_L2_LOOKUPS)[number]) => ({
      file: s.file,
      columns: s.columns,
      orderBy: s.orderBy,
    });
    const [id, wallet, tag] = PARQUET_L2_LOOKUPS;
    assert.equal(tag, l1Specs.get('tag'));
    assert.deepEqual(shape(wallet), shape(l1Specs.get('wallet')!));
    assert.deepEqual(
      { ...shape(id), file: 'lookup_tx_id.parquet' },
      shape(l1Specs.get('tx_id')!),
    );
    for (const spec of PARQUET_L2_LOOKUPS) {
      assert.equal(spec.file, `lookup_${spec.name}.parquet`);
    }
  });

  it('shares the L1 band file and its cap', () => {
    assert.equal(BAND_FILE, l1.BAND_FILE);
    assert.equal(MAX_BAND_FILE_BYTES, l1.MAX_BAND_FILE_BYTES);
  });

  it('orders every table by its own columns', () => {
    for (const table of PARQUET_L2_TABLES) {
      const names = table.columns.map((c) => c.name);
      assert.ok(
        table.orderBy.every((c) => names.includes(c)),
        table.name,
      );
      assert.equal(new Set(names).size, names.length, table.name);
    }
  });

  it('places a data item with offsets that are all set or all null, last in the row', () => {
    const items = PARQUET_L2_TABLES[0];
    const tail = items.columns.slice(-DATA_ITEM_LOCATION_COLUMNS.length);
    assert.deepEqual(
      tail.map((c) => c.name),
      [...DATA_ITEM_LOCATION_COLUMNS],
    );
    assert.ok(tail.every((c) => c.type === 'UBIGINT'));
  });

  it('states the order whole: quoted, ascending, nulls last', () => {
    assert.equal(
      orderByClause(PARQUET_L2_TABLES[0]),
      '"height" ASC NULLS LAST, "block_transaction_index" ASC NULLS LAST, "id" ASC NULLS LAST, "root_parent_offset" ASC NULLS LAST, "offset" ASC NULLS LAST',
    );
  });
});

describe('parseSelection', () => {
  it('reads a selection, with or without an exclusion', () => {
    assert.deepEqual(parseSelection(selection()), selection());
    const narrower = {
      kind: 'ans104-data-items',
      tag: {
        name: 'App-Name',
        valuePrefix: 'ArDrive',
        excludeValuePrefix: 'ArDrive-Test',
      },
    };
    assert.deepEqual(parseSelection(narrower), narrower);
  });

  it('refuses anything it does not declare, naming what', () => {
    const refuse = (change: (s: any) => void, pattern: RegExp) => {
      const s: any = selection();
      change(s);
      assert.throws(() => parseSelection(s), pattern);
    };
    assert.throws(() => parseSelection(null), /selection must be an object/);
    assert.throws(() => parseSelection([]), /selection must be an object/);
    refuse((s) => (s.kind = 'ans104-bundles'), /kind must be/);
    refuse((s) => (s.extra = 1), /unknown field "extra"/);
    refuse(
      (s) => (s.tag.valueSuffix = 'x'),
      /selection\.tag: unknown field "valueSuffix"/,
    );
    refuse((s) => (s.tag = 'App-Name'), /tag must be an object/);
    refuse((s) => (s.tag.name = ''), /tag\.name must be a non-empty string/);
    refuse((s) => (s.tag.name = 7), /tag\.name must be/);
    refuse((s) => delete s.tag.valuePrefix, /tag\.valuePrefix must be/);
    refuse((s) => (s.tag.excludeValuePrefix = null), /excludeValuePrefix must/);
    // An exclusion must narrow the selection, not empty it or miss it.
    refuse(
      (s) => (s.tag.excludeValuePrefix = 'ArDrive'),
      /must extend valuePrefix "ArDrive"/,
    );
    refuse((s) => (s.tag.excludeValuePrefix = 'Ar'), /must extend valuePrefix/);
    refuse(
      (s) => (s.tag.excludeValuePrefix = 'Turbo-Test'),
      /must extend valuePrefix/,
    );
  });

  it('bounds names and prefixes in UTF-8 bytes, and refuses one with no UTF-8', () => {
    const at = (value: string) => ({
      kind: 'ans104-data-items',
      tag: { name: 'App-Name', valuePrefix: value },
    });
    parseSelection(at('x'.repeat(256)));
    assert.throws(() => parseSelection(at('x'.repeat(257))), /at most 256/);
    // 129 characters, 258 bytes.
    assert.throws(() => parseSelection(at('é'.repeat(129))), /at most 256/);
    assert.throws(() => parseSelection(at('Ar\ud800')), /UTF-8/);
  });

  it('serializes one way, whatever order the keys came in', () => {
    const reordered = {
      tag: { valuePrefix: 'ArDrive', name: 'App-Name' },
      kind: 'ans104-data-items',
    };
    assert.equal(
      serializeSelection(parseSelection(reordered)),
      '{"kind":"ans104-data-items","tag":{"name":"App-Name","valuePrefix":"ArDrive"}}',
    );
    assert.equal(
      serializeSelection(parseSelection(reordered)),
      serializeSelection(parseSelection(selection())),
    );
  });
});

describe('parseBandFile', () => {
  it('reads a valid band file', () => {
    const band = parseBandFile(
      JSON.stringify({ ...valid(), checks: { signatures: 5 } }),
    );
    assert.deepEqual(band.heightRange, [0, 99_999]);
    assert.deepEqual(band.selection, selection());
    assert.equal(band.tables.data_items.rows, 5);
    assert.deepEqual(band.checks, { signatures: 5 });
  });

  it('refuses anything malformed, naming what', () => {
    const refuse = (change: (band: any) => void, pattern: RegExp) => {
      const band: any = valid();
      change(band);
      assert.throws(() => parseBandFile(JSON.stringify(band)), pattern);
    };
    assert.throws(() => parseBandFile('{'), /not JSON/);
    assert.throws(() => parseBandFile('[]'), /must be an object/);
    assert.throws(
      () => parseBandFile(' '.repeat(MAX_BAND_FILE_BYTES + 1)),
      /more than a band file holds/,
    );
    refuse((b) => (b.version = 2), /version must be 1/);
    refuse((b) => (b.schema = 'l1-3'), /schema "l1-3" is not one of l2-1/);
    refuse((b) => (b.heightRange = [5, 4]), /heightRange/);
    refuse((b) => (b.heightRange = [0, 1.5]), /heightRange/);
    refuse((b) => (b.heightRange = [-1, 4]), /heightRange/);
    // Only what the layout declares: not an L1 band's fields.
    refuse((b) => (b.supersedes = ['l2-old']), /unknown field "supersedes"/);
    // Every lookup, described as a table is.
    refuse((b) => delete b.lookups, /lookups must be an object/);
    refuse((b) => (b.lookups = []), /lookups must be an object/);
    refuse(
      (b) => (b.lookups.tx_id = { rows: 1, rowDigest: digest }),
      /unknown lookup "tx_id"/,
    );
    refuse((b) => delete b.lookups.wallet, /lookup wallet needs/);
    refuse((b) => (b.lookups.tag.rowDigest = 'xyz'), /lookup tag needs/);
    refuse((b) => (b.lookups.id.rows = -1), /lookup id needs/);
    refuse((b) => (b.lookups.id.extra = 1), /and nothing else/);
    refuse((b) => delete b.selection, /selection must be an object/);
    refuse((b) => (b.selection.tag.name = ''), /selection\.tag\.name/);
    refuse((b) => (b.tables = []), /tables must be an object/);
    refuse(
      (b) => (b.tables.extra = { rows: 1, rowDigest: digest }),
      /unknown table "extra"/,
    );
    refuse((b) => delete b.tables.parents, /table parents needs/);
    refuse((b) => (b.tables.tags.rowDigest = 'xyz'), /table tags needs/);
    refuse((b) => (b.tables.tags.rows = -1), /table tags needs/);
    refuse((b) => (b.tables.tags.rows = 2 ** 53), /table tags needs/);
    refuse((b) => (b.tables.tags.extra = 1), /and nothing else/);
    refuse((b) => (b.checks = ['ok']), /checks must be an object/);
    refuse((b) => (b.checks = null), /checks must be an object/);
    refuse((b) => (b.createdAt = 'yesterday'), /createdAt/);
    // A date that parses, but not in the one form a band is written in.
    refuse((b) => (b.createdAt = '2026-10-02'), /createdAt/);
    refuse((b) => delete b.createdAt, /createdAt/);
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

  it('writes the same bytes whatever order the fields came in', () => {
    const withChecks = {
      ...valid(),
      checks: { signatures: { verified: 5, skipped: 0 }, owners: 3 },
    };
    const a = serializeBandFile(parseBandFile(JSON.stringify(withChecks)));
    const b = serializeBandFile(
      parseBandFile(JSON.stringify(reversed(withChecks))),
    );
    assert.equal(a, b);
    assert.deepEqual(
      parseBandFile(a),
      parseBandFile(JSON.stringify(withChecks)),
    );
  });

  it('writes fields and tables in the layout’s order, and the keys of checks sorted', () => {
    const json = JSON.parse(
      serializeBandFile(
        parseBandFile(
          JSON.stringify(reversed({ ...valid(), checks: { b: 1, a: 2 } })),
        ),
      ),
    );
    assert.deepEqual(Object.keys(json), [
      'version',
      'schema',
      'heightRange',
      'selection',
      'tables',
      'lookups',
      'checks',
      'createdAt',
    ]);
    assert.deepEqual(Object.keys(json.selection), ['kind', 'tag']);
    assert.deepEqual(Object.keys(json.selection.tag), ['name', 'valuePrefix']);
    assert.deepEqual(
      Object.keys(json.tables),
      PARQUET_L2_TABLES.map((t) => t.name),
    );
    assert.deepEqual(
      Object.keys(json.lookups),
      PARQUET_L2_LOOKUPS.map((l) => l.name),
    );
    assert.deepEqual(Object.keys(json.checks), ['a', 'b']);
  });

  it('writes no checks when there are none', () => {
    const json = JSON.parse(
      serializeBandFile(parseBandFile(JSON.stringify(valid()))),
    );
    assert.equal(json.checks, undefined);
  });
});

describe('bandTablesDigest and the band id', () => {
  const band = () => parseBandFile(JSON.stringify(valid()));

  it('digests the heights, the selection and the tables’ rows, as documented', () => {
    const b = band();
    const expected = crypto
      .createHash('sha256')
      .update(
        '[0,99999]\n' +
          '{"kind":"ans104-data-items","tag":{"name":"App-Name","valuePrefix":"ArDrive"}}\n' +
          ['data_items', 'parents', 'tags', 'wallets']
            .map((t) => `${t}:5:${digest}`)
            .join('\n'),
      )
      .digest();
    assert.deepEqual(bandTablesDigest(b), expected);
  });

  it('binds the selection: the same rows under two selections are two bands', () => {
    const a = band();
    const b = band();
    b.selection = {
      ...b.selection,
      tag: { ...b.selection.tag, excludeValuePrefix: 'ArDrive-Test' },
    };
    assert.notDeepEqual(bandTablesDigest(a), bandTablesDigest(b));
    assert.notEqual(l2BandId(a, TAG), l2BandId(b, TAG));
  });

  it('leaves out lookups, checks and createdAt', () => {
    const a = band();
    const b = {
      ...band(),
      lookups: { id: { rows: 9, rowDigest: 'c'.repeat(64) } },
      checks: { x: 1 },
      createdAt: '2027-01-01T00:00:00.000Z',
    };
    assert.deepEqual(bandTablesDigest(a), bandTablesDigest(b));
  });

  it('names a band by its heights, publisher and digest', () => {
    const b = band();
    const id = l2BandId(b, TAG);
    assert.match(id, L2_BAND_ID_PATTERN);
    assert.equal(
      id,
      `l2-h0-99999-${TAG}-${bandTablesDigest(b).toString('hex').slice(0, 12)}`,
    );
    assert.deepEqual(idHeightRange(id), [0, 99_999]);
    assert.throws(() => l2BandId(b, 'publisher'), /Not a publisher tag/);
  });

  it('reads heights only from an l2 band id', () => {
    assert.deepEqual(
      idHeightRange('l2-h1900000-1904999-f5b1208c-0123456789ab'),
      [1_900_000, 1_904_999],
    );
    for (const id of [
      'l1-h0-99999-f5b1208c-0123456789ab',
      'l2-h0-99999-f5b1208c-0123456789a',
      'l2-h0-99999-F5B1208C-0123456789ab',
      'l2-0-99999-f5b1208c-0123456789ab',
      'l2-h0-99999-f5b1208c-0123456789ab~aaaaaaaaaaaa',
      // Heights in canonical decimals only: one band, one id.
      'l2-h0100-199-f5b1208c-0123456789ab',
      'l2-h100-0199-f5b1208c-0123456789ab',
      'l2-h00-99999-f5b1208c-0123456789ab',
    ]) {
      assert.equal(idHeightRange(id), undefined, id);
    }
  });
});
