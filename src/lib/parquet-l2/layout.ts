/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The layout of a `parquet-l2` band: the ANS-104 data items (L2) of one
 * height range that a declared selection takes, in Parquet, with their tags,
 * their owners' keys, and where each sits in its root transaction.
 *
 * Bands cover the same fixed heights as L1 bands ({@link isL1BandRange}). A
 * data item's height is its root transaction's, so an L2 band lies over the
 * L1 band of the same heights, and every publisher cuts at the same ones.
 *
 * What a band holds depends on its selection as well as on the chain: two
 * selections over the same heights hold different rows. So the selection is
 * part of the band's identity: declared in `band.json`, bound into the
 * band's id ({@link bandTablesDigest}), and the same for every band of an
 * index. The layout is generic: a selection names a tag and a value prefix,
 * and one app's data items are one selection among many.
 *
 * The kind that checks bands reads this module, and a builder that writes
 * them must, so the two cannot drift.
 */
import crypto from 'node:crypto';

import type { ColumnSpec } from '../parquet/check.js';
import {
  BAND_FILE,
  MAX_BAND_FILE_BYTES,
  type TableSpec,
} from '../parquet-l1/layout.js';

/** The description file and its size cap: the same as an L1 band's. */
export { BAND_FILE, MAX_BAND_FILE_BYTES };

/** The layout version a band is written with, in its `band.json`. */
export const PARQUET_L2_SCHEMA = 'l2-1';

/** The versions a reader accepts, oldest first. */
export const PARQUET_L2_SCHEMAS = ['l2-1'] as const;
export type ParquetL2Schema = (typeof PARQUET_L2_SCHEMAS)[number];

/** The kind of selection `l2-1` defines: data items picked by one tag. */
export const SELECTION_KIND = 'ans104-data-items';

/** The most UTF-8 bytes a selection's tag name or value prefix may hold. */
export const MAX_SELECTION_STRING_BYTES = 256;

/**
 * Which data items a band holds.
 *
 * An item is selected when one of its tags is named `tag.name`, byte for
 * byte (case counts), and has a value that starts with `tag.valuePrefix`
 * and not with `tag.excludeValuePrefix`, all compared as UTF-8 bytes.
 * `excludeValuePrefix` carves a narrower family back out of the values
 * `valuePrefix` takes, so it must extend it: one that doesn't would exclude
 * nothing, or everything, and only make two selections of the same items
 * look different.
 */
export interface ParquetL2Selection {
  kind: typeof SELECTION_KIND;
  tag: {
    name: string;
    valuePrefix: string;
    excludeValuePrefix?: string;
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function refuseUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Error(`${label}: unknown field ${JSON.stringify(key)}`);
    }
  }
}

function selectionString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    // A lone surrogate has no UTF-8 encoding: two different strings would
    // select by the same bytes.
    Buffer.from(value, 'utf8').toString('utf8') !== value ||
    Buffer.byteLength(value, 'utf8') > MAX_SELECTION_STRING_BYTES
  ) {
    throw new Error(
      `${label} must be a non-empty string of at most ${MAX_SELECTION_STRING_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

/**
 * Parses and checks a selection, from a `band.json`, a band's metadata or
 * an index's `filter`. A field this build doesn't know is refused, not
 * ignored: it could change which items a band holds.
 *
 * @throws with a message naming what is wrong, starting with `label`.
 */
export function parseSelection(
  raw: unknown,
  label = 'selection',
): ParquetL2Selection {
  if (!isObject(raw)) throw new Error(`${label} must be an object`);
  refuseUnknownKeys(raw, ['kind', 'tag'], label);
  if (raw.kind !== SELECTION_KIND) {
    throw new Error(`${label}.kind must be ${JSON.stringify(SELECTION_KIND)}`);
  }
  const tag = raw.tag;
  if (!isObject(tag)) throw new Error(`${label}.tag must be an object`);
  refuseUnknownKeys(
    tag,
    ['name', 'valuePrefix', 'excludeValuePrefix'],
    `${label}.tag`,
  );
  const name = selectionString(tag.name, `${label}.tag.name`);
  const valuePrefix = selectionString(
    tag.valuePrefix,
    `${label}.tag.valuePrefix`,
  );
  if (tag.excludeValuePrefix === undefined) {
    return { kind: SELECTION_KIND, tag: { name, valuePrefix } };
  }
  const excludeValuePrefix = selectionString(
    tag.excludeValuePrefix,
    `${label}.tag.excludeValuePrefix`,
  );
  if (
    excludeValuePrefix.length <= valuePrefix.length ||
    !excludeValuePrefix.startsWith(valuePrefix)
  ) {
    throw new Error(
      `${label}.tag.excludeValuePrefix must extend valuePrefix ${JSON.stringify(valuePrefix)}`,
    );
  }
  return {
    kind: SELECTION_KIND,
    tag: { name, valuePrefix, excludeValuePrefix },
  };
}

/** A selection with its keys in the declared order. */
function canonicalSelection(selection: ParquetL2Selection): ParquetL2Selection {
  const { name, valuePrefix, excludeValuePrefix } = selection.tag;
  return {
    kind: selection.kind,
    tag: {
      name,
      valuePrefix,
      ...(excludeValuePrefix !== undefined ? { excludeValuePrefix } : {}),
    },
  };
}

/**
 * A selection as one line of JSON, keys in the declared order: what a
 * band's id binds, and how two selections are compared.
 */
export function serializeSelection(selection: ParquetL2Selection): string {
  return JSON.stringify(canonicalSelection(selection));
}

const col = (name: string, type: string): ColumnSpec => ({ name, type });

/**
 * The columns of `data_items` that place an item in its root transaction,
 * as the gateway's bundle index does. Offsets and sizes are bytes into the
 * payload of the item's parent bundle; `root_parent_offset` is where that
 * payload starts in the root transaction's data, so an item starts at
 * `root_parent_offset + offset` there.
 *
 * All set, or all null: an unlocated item, known to be in its root
 * transaction but not where (an index built without offsets). A builder
 * never writes part of a location. The sidecar reads footers, not rows, so
 * this is the builder's to keep and an importer's to check.
 */
export const DATA_ITEM_LOCATION_COLUMNS = [
  'root_parent_offset',
  'offset',
  'size',
  'data_offset',
  'owner_offset',
  'owner_size',
  'signature_offset',
  'signature_size',
] as const;

/**
 * The tables of a band, in file order. Ids, addresses and root ids are 32
 * bytes; DuckDB reads them all as BLOB, so the width is for the builder to
 * keep and an importer to check.
 *
 * Every table's order ({@link orderByClause}) is total over the rows a
 * builder writes, so every publisher of the same rows digests them in the
 * same order and writes the same `rowDigest`.
 */
export const PARQUET_L2_TABLES: TableSpec[] = [
  {
    name: 'data_items',
    file: 'data_items.parquet',
    // One row per place an item sits in its root: the same item in two
    // bundles, or twice in one, is two rows. One unlocated row for a root
    // only when no place in it is known, so the order is total.
    orderBy: [
      'height',
      'block_transaction_index',
      'id',
      'root_parent_offset',
      'offset',
    ],
    columns: [
      // The item, and its root transaction's place on the chain: `height`
      // and `block_transaction_index` are the root's, the row of an L1
      // band's `block_transactions` that holds it.
      col('id', 'BLOB'),
      col('height', 'UBIGINT'),
      col('block_transaction_index', 'USMALLINT'),
      col('root_transaction_id', 'BLOB'),
      // The bundle it is directly in: its root transaction, or a nested
      // bundle described in `parents`.
      col('parent_id', 'BLOB'),
      // What it signs. `owner_address` is the SHA-256 of the owner's key
      // (in `wallets`). `target` and `anchor` are null when the item
      // carries none, never empty bytes. `signature_type` is null where
      // the source didn't record it.
      col('owner_address', 'BLOB'),
      col('target', 'BLOB'),
      col('anchor', 'BLOB'),
      col('signature_type', 'UTINYINT'),
      col('data_size', 'UBIGINT'),
      // From its own tags, as an L1 band takes them (`firstTagValue` in
      // the L1 layout): null when it has none.
      col('content_type', 'VARCHAR'),
      col('content_encoding', 'VARCHAR'),
      col('tag_count', 'INTEGER'),
      // Where it is: DATA_ITEM_LOCATION_COLUMNS, all set or all null.
      col('root_parent_offset', 'UBIGINT'),
      col('offset', 'UBIGINT'),
      col('size', 'UBIGINT'),
      col('data_offset', 'UBIGINT'),
      col('owner_offset', 'UBIGINT'),
      col('owner_size', 'UBIGINT'),
      col('signature_offset', 'UBIGINT'),
      col('signature_size', 'UBIGINT'),
    ],
  },
  {
    name: 'tags',
    file: 'tags.parquet',
    // Each item's tags once per height it sits at, however many places.
    orderBy: ['height', 'id', 'tag_index'],
    columns: [
      // Names and values in plaintext, as an L1 band's.
      col('height', 'UBIGINT'),
      col('id', 'BLOB'),
      col('tag_index', 'USMALLINT'),
      col('tag_name', 'BLOB'),
      col('tag_value', 'BLOB'),
    ],
  },
  {
    name: 'wallets',
    file: 'wallets.parquet',
    // The owners' keys as their items carry them: an RSA modulus for an
    // Arweave signature, the public key for others. SHA-256 of the key is
    // the address, an importer's check rather than the sidecar's.
    orderBy: ['address'],
    columns: [col('address', 'BLOB'), col('public_modulus', 'BLOB')],
  },
  {
    name: 'parents',
    file: 'parents.parquet',
    // Every nested bundle between a held item and its root transaction: a
    // data item that is itself a bundle, placed as `data_items` places an
    // item. Its payload starts at `root_parent_offset + data_offset` in
    // the root, the `root_parent_offset` of every item directly in it. A
    // root transaction is no row: an item directly in it has its id as
    // `parent_id` and a `root_parent_offset` of 0. A bundle nested in more
    // than one place is a row per place, so the order runs past the id.
    orderBy: ['id', 'root_transaction_id', 'root_parent_offset', 'offset'],
    columns: [
      col('id', 'BLOB'),
      col('root_transaction_id', 'BLOB'),
      col('root_parent_offset', 'UBIGINT'),
      col('offset', 'UBIGINT'),
      col('size', 'UBIGINT'),
      col('data_offset', 'UBIGINT'),
    ],
  },
];

/**
 * A table's order as SQL: its `orderBy` columns, quoted (`offset` is a
 * keyword), ascending, nulls last. The order rows are written and digested
 * in, stated whole, so no writer or reader relies on its engine's default
 * for nulls: an unlocated item sorts after the located rows of its id.
 */
export function orderByClause(table: TableSpec): string {
  return table.orderBy.map((c) => `"${c}" ASC NULLS LAST`).join(', ');
}

/**
 * What a band says about itself, in `band.json`. Only what its rows and its
 * selection determine, so every publisher of the same rows writes the same
 * file ({@link serializeBandFile}), the same torrent, and so one swarm. What
 * is the publisher's own, the bands this one replaces, is kept beside it in
 * `.publisher.json`, as beside an L1 band.
 */
export interface ParquetL2Band {
  version: 1;
  /** The version this band was written with, not the one we write. */
  schema: ParquetL2Schema;
  /** The heights the band covers, both included. */
  heightRange: [number, number];
  /** Which data items it holds: the same for every band of an index. */
  selection: ParquetL2Selection;
  /** Per table: rows, and a digest of the rows, independent of the Parquet bytes. */
  tables: Record<string, { rows: number; rowDigest: string }>;
  /**
   * What its builder checked, free-form and small: counts, say. Not part
   * of the band's id, so builders that check differently publish the same
   * id over different `band.json` files.
   */
  checks?: Record<string, unknown>;
  /** The time of the band's top block, as an L1 band's (`bandTime`). */
  createdAt: string;
}

/** The fields of a `band.json`, in the order they are written. */
const BAND_FIELDS = [
  'version',
  'schema',
  'heightRange',
  'selection',
  'tables',
  'checks',
  'createdAt',
] as const;

/** A JSON value with every object's keys sorted. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  }
  return value;
}

/**
 * A band's `band.json`, written the one way: fields and tables in the
 * layout's order, the selection's keys in its declared order, and the keys
 * of `checks` sorted. Two publishers of the same rows therefore write the
 * same bytes.
 */
export function serializeBandFile(band: ParquetL2Band): string {
  const canonical = {
    version: band.version,
    schema: band.schema,
    heightRange: [band.heightRange[0], band.heightRange[1]],
    selection: canonicalSelection(band.selection),
    tables: Object.fromEntries(
      PARQUET_L2_TABLES.map(({ name }) => [
        name,
        {
          rows: band.tables[name].rows,
          rowDigest: band.tables[name].rowDigest,
        },
      ]),
    ),
    ...(band.checks !== undefined ? { checks: sortedKeys(band.checks) } : {}),
    createdAt: band.createdAt,
  };
  return JSON.stringify(canonical, null, 2);
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** An instant as `Date#toISOString` writes it, the only form written. */
const isIsoTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/**
 * Parses and checks a `band.json`. A publisher's file comes from anywhere,
 * so every field is checked, a field the layout doesn't declare is refused,
 * and every table of the layout must be described.
 *
 * @throws with a message naming what is wrong.
 */
export function parseBandFile(text: string): ParquetL2Band {
  if (Buffer.byteLength(text, 'utf8') > MAX_BAND_FILE_BYTES) {
    throw new Error(
      `${BAND_FILE} is more than ${MAX_BAND_FILE_BYTES} bytes, more than a band file holds`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${BAND_FILE} is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${BAND_FILE} must be an object`);
  refuseUnknownKeys(raw, BAND_FIELDS, BAND_FILE);
  if (raw.version !== 1) throw new Error(`${BAND_FILE}: version must be 1`);
  if (!PARQUET_L2_SCHEMAS.includes(raw.schema as ParquetL2Schema)) {
    throw new Error(
      `${BAND_FILE}: schema ${JSON.stringify(raw.schema)} is not one of ` +
        PARQUET_L2_SCHEMAS.join(', '),
    );
  }
  const schema = raw.schema as ParquetL2Schema;
  const range = raw.heightRange;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !isCount(range[0]) ||
    !isCount(range[1]) ||
    range[1] < range[0]
  ) {
    throw new Error(`${BAND_FILE}: heightRange must be [from, to], from <= to`);
  }
  const selection = parseSelection(raw.selection, `${BAND_FILE}: selection`);
  if (!isObject(raw.tables)) {
    throw new Error(`${BAND_FILE}: tables must be an object`);
  }
  const described = raw.tables;
  const names = PARQUET_L2_TABLES.map((table) => table.name);
  for (const name of Object.keys(described)) {
    if (!names.includes(name)) {
      throw new Error(`${BAND_FILE}: unknown table ${JSON.stringify(name)}`);
    }
  }
  const tables: ParquetL2Band['tables'] = {};
  for (const name of names) {
    const entry = described[name];
    if (
      !isObject(entry) ||
      Object.keys(entry).some((key) => key !== 'rows' && key !== 'rowDigest') ||
      !isCount(entry.rows) ||
      typeof entry.rowDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.rowDigest)
    ) {
      throw new Error(
        `${BAND_FILE}: table ${name} needs rows and a 64-hex rowDigest, and nothing else`,
      );
    }
    tables[name] = { rows: entry.rows, rowDigest: entry.rowDigest };
  }
  if (raw.checks !== undefined && !isObject(raw.checks)) {
    throw new Error(`${BAND_FILE}: checks must be an object`);
  }
  if (!isIsoTime(raw.createdAt)) {
    throw new Error(
      `${BAND_FILE}: createdAt must be an ISO 8601 time, as toISOString writes it`,
    );
  }
  return {
    version: 1,
    schema,
    heightRange: [range[0], range[1]],
    selection,
    tables,
    ...(raw.checks !== undefined ? { checks: raw.checks } : {}),
    createdAt: raw.createdAt,
  };
}

/**
 * Every file a band of a layout holds, sorted: its description and one
 * Parquet file per table. Publisher, subscriber and verifier all take a
 * band's files from here, by the layout its `band.json` names.
 */
export function bandFiles(_schema: ParquetL2Schema): string[] {
  return [BAND_FILE, ...PARQUET_L2_TABLES.map((table) => table.file)].sort();
}

/**
 * A digest of what a band holds: its heights, its selection, and every
 * table's row count and row digest. Independent of the Parquet bytes, so
 * two publishers that wrote the same rows under the same selection agree on
 * it; the selection is bound in, so bands of two selections never do, even
 * where they hold the same rows (none, say). `checks` and `createdAt` are
 * left out.
 *
 * The band's id is taken from this ({@link l2BandId}).
 */
export function bandTablesDigest(band: ParquetL2Band): Buffer {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(band.heightRange))
    .update('\n')
    .update(serializeSelection(band.selection))
    .update('\n')
    .update(
      Object.keys(band.tables)
        .sort()
        .map((t) => `${t}:${band.tables[t].rows}:${band.tables[t].rowDigest}`)
        .join('\n'),
    )
    .digest();
}

/**
 * A band id: `l2-h<from>-<to>-<publisher tag>-<digest>`, the shape of an L1
 * band's. `h` for every band size, the publisher's 8-hex tag, and the first
 * 12 hex digits of {@link bandTablesDigest}.
 */
export const L2_BAND_ID_PATTERN =
  /^l2-h(\d{1,15})-(\d{1,15})-[0-9a-f]{8}-([0-9a-f]{12})$/;

/**
 * A band's id: its heights, its publisher, and a digest of its heights,
 * selection and rows.
 *
 * @param publisherTag the publisher's tag, as every band kind's id carries
 *   it: `bandPublisherTag(publisher)` in `src/lib/index-band/build.ts`.
 */
export function l2BandId(band: ParquetL2Band, publisherTag: string): string {
  if (!/^[0-9a-f]{8}$/.test(publisherTag)) {
    throw new Error(`Not a publisher tag: ${JSON.stringify(publisherTag)}`);
  }
  const digest = bandTablesDigest(band).toString('hex').slice(0, 12);
  const [from, to] = band.heightRange;
  return ['l2', `h${from}`, String(to), publisherTag, digest].join('-');
}

/**
 * The heights a band's id claims, or `undefined` if it is not a band id.
 * The id is whoever-published-it's, so it has to agree with the band it
 * names.
 */
export function idHeightRange(id: string): [number, number] | undefined {
  const m = L2_BAND_ID_PATTERN.exec(id);
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2])];
}
