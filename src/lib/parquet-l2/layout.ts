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
 * A band also carries lookup files ({@link lookupsOf}), as an `l1-3` band
 * does: Parquet derived from its tables and sorted by a key, so a reader
 * finds one data item, wallet or tag pair without scanning the band. Layout
 * `l2-2` adds two the band's publisher parameterises: `lookup_key.parquet`,
 * the heights at which each value of the band's **key tags** (`keyTags`,
 * such as ArDrive's `Drive-Id`) occurs, and `stats.parquet`, counts and
 * bytes per bucket of heights by each value of its **stat tags**
 * (`statTags`). They are described in `band.json` like the tables, and left
 * out of the band's id, which covers only the tables' rows and the
 * selection, so an `l2-1` band gains them in place under the same id.
 *
 * The kind that checks bands reads this module, and a builder that writes
 * them must, so the two cannot drift.
 */
import crypto from 'node:crypto';

import type { ColumnSpec } from '../parquet/check.js';
import { prefix64Sql, sha256_64Sql } from '../parquet/keys.js';
import {
  LookupDescription,
  LookupDigestOrder,
  LookupSpec,
  sqlPaths,
} from '../parquet/lookups.js';
import {
  BAND_FILE,
  MAX_BAND_FILE_BYTES,
  PARQUET_L1_LOOKUPS,
  type TableSpec,
} from '../parquet-l1/layout.js';

/** The description file and its size cap: the same as an L1 band's. */
export { BAND_FILE, MAX_BAND_FILE_BYTES };

/** The layout version a band is written with, in its `band.json`. */
export const PARQUET_L2_SCHEMA = 'l2-2';

/**
 * The versions a reader accepts, oldest first. `l2-2` keeps `l2-1`'s tables
 * and lookups and adds `lookup_key.parquet` and `stats.parquet`, with the
 * tag names they are derived for (`keyTags`, `statTags`) in `band.json`.
 */
export const PARQUET_L2_SCHEMAS = ['l2-1', 'l2-2'] as const;
export type ParquetL2Schema = (typeof PARQUET_L2_SCHEMAS)[number];

/** Whether a layout carries the key and stats files. */
export const hasDerivedTags = (schema: ParquetL2Schema): boolean =>
  schema === 'l2-2';

/** The most tag names `keyTags` or `statTags` may list. */
export const MAX_DERIVED_TAGS = 16;

/** Heights per row of `stats.parquet`: about a day and a half of blocks. */
export const STATS_BUCKET_HEIGHTS = 1000;

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

/** UTF-8 byte order, the order the layout keeps tag names in. */
const byBytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * Parses a list of tag names a band's derived files are built for
 * (`keyTags`, `statTags`): at most {@link MAX_DERIVED_TAGS} strings under
 * the rules of a selection's, each once, in UTF-8 byte order. Canonical, so
 * every publisher of the same rows under the same names writes the same
 * `band.json`.
 *
 * @throws with a message naming what is wrong, starting with `label`.
 */
export function parseTagNames(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be a list`);
  if (raw.length > MAX_DERIVED_TAGS) {
    throw new Error(`${label} lists more than ${MAX_DERIVED_TAGS} tag names`);
  }
  const names = raw.map((name, i) => selectionString(name, `${label}[${i}]`));
  for (let i = 1; i < names.length; i++) {
    const order = byBytes(names[i - 1], names[i]);
    if (order === 0) {
      throw new Error(`${label} names ${JSON.stringify(names[i])} twice`);
    }
    if (order > 0) {
      throw new Error(`${label} must be in UTF-8 byte order`);
    }
  }
  return names;
}

/** Tag names as {@link parseTagNames} wants them: each once, in byte order. */
export function canonicalTagNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort(byBytes);
}

/** A list of tag names as a SQL list of BLOB literals, hex so no escaping stands between. */
const blobList = (names: readonly string[]) =>
  names
    .map((name) => `from_hex('${Buffer.from(name, 'utf8').toString('hex')}')`)
    .join(', ');

/** `column IN (names)` as SQL; no names, no rows. */
const tagNameIn = (column: string, names: readonly string[]) =>
  names.length === 0 ? 'false' : `${column} IN (${blobList(names)})`;

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
 * The lookups a band carries, derived from its own tables with the engine
 * and key encodings of an `l1-3` band's (`PARQUET_L1_LOOKUPS`), so one
 * reader serves both. Each file is sorted by its key in row groups of
 * 16,384, so a reader finds a key by reading the footer and one or two row
 * groups; a key is a pointer, confirmed against the bytes it came from.
 *
 * `data_items` holds a row per place an item sits; a lookup holds one per
 * item and height, however many places it sits at there.
 */
export const PARQUET_L2_LOOKUPS: LookupSpec[] = [
  {
    // A data item id's prefix, to the height its rows are at.
    name: 'id',
    file: 'lookup_id.parquet',
    columns: [col('id8', 'UBIGINT'), col('height', 'UBIGINT')],
    orderBy: ['id8', 'height'],
    derive: (t) =>
      `SELECT ${prefix64Sql('id')} AS id8, height
       FROM (SELECT DISTINCT id, height
             FROM read_parquet(${sqlPaths(t.data_items)}))`,
  },
  {
    // An address's prefix, to every item it signed (role 0) or that names
    // it as target (role 1), with its height and size: as an L1 band's.
    name: 'wallet',
    file: 'lookup_wallet.parquet',
    columns: [
      col('addr8', 'UBIGINT'),
      col('role', 'UTINYINT'),
      col('height', 'UBIGINT'),
      col('data_size', 'UBIGINT'),
    ],
    orderBy: ['addr8', 'height', 'role', 'data_size'],
    derive: (t) =>
      `WITH items AS (
         SELECT DISTINCT id, height, owner_address, target, data_size
         FROM read_parquet(${sqlPaths(t.data_items)}))
       SELECT ${prefix64Sql('owner_address')} AS addr8, 0::UTINYINT AS role, height, data_size
       FROM items
       WHERE owner_address IS NOT NULL
       UNION ALL
       SELECT ${prefix64Sql('target')} AS addr8, 1::UTINYINT AS role, height, data_size
       FROM items
       WHERE target IS NOT NULL AND octet_length(target) > 0`,
  },
  // Every (name, value) tag pair: an L1 band's lookup, unchanged. It reads
  // only `tags`' height, id, tag_name and tag_value, which L2's has, and
  // counts each item once per pair (`txs`) however many heights hold it.
  PARQUET_L1_LOOKUPS.find((spec) => spec.name === 'tag')!,
];

/**
 * `l2-2`'s key lookup: for each (name, value) pair of a band's key tags
 * (`keyTags`), the heights at which items carry it, with how many do at
 * each. A reader holding a key value (an ArDrive `Drive-Id`, a
 * `Parent-Folder-Id`) reads one or two row groups here, then only the row
 * groups of `tags` and `data_items` at those heights, however widely the
 * value's items are spread over the band: `lookup_tag` gives only the
 * first and last height, between which a wide drive costs the whole band.
 * The keys are those of `lookup_tag`, which maps them back to the bytes.
 */
export function keyLookup(keyTags: readonly string[]): LookupSpec {
  return {
    name: 'key',
    file: 'lookup_key.parquet',
    columns: [
      col('name8', 'UBIGINT'),
      col('val8', 'UBIGINT'),
      col('height', 'UBIGINT'),
      col('items', 'UBIGINT'),
    ],
    orderBy: ['name8', 'val8', 'height'],
    derive: (t) =>
      `SELECT name8, val8, height, count(*)::UBIGINT AS items
       FROM (SELECT DISTINCT ${sha256_64Sql('tag_name')} AS name8,
                             ${sha256_64Sql('tag_value')} AS val8, height, id
             FROM read_parquet(${sqlPaths(t.tags)})
             WHERE ${tagNameIn('tag_name', keyTags)})
       GROUP BY name8, val8, height`,
  };
}

/**
 * `l2-2`'s stats file: per {@link STATS_BUCKET_HEIGHTS} heights, how many
 * distinct items the band holds there and their bytes (`data_size`), in all
 * (a row with an empty `name` and `value`) and by each value of each of
 * the band's stat tags (`statTags`): an ArDrive `Entity-Type`,
 * `Content-Type` or `App-Name`. An item carrying a stat tag twice counts
 * under its first value. A question over the whole index (bytes a month,
 * uploads by app) is then answered from these small files alone. Rows are
 * sorted by bucket, so a reader takes a range of heights by row group.
 */
export function statsLookup(statTags: readonly string[]): LookupSpec {
  const bucket = `((height // ${STATS_BUCKET_HEIGHTS}) * ${STATS_BUCKET_HEIGHTS})::UBIGINT`;
  return {
    name: 'stats',
    file: 'stats.parquet',
    columns: [
      col('bucket', 'UBIGINT'),
      col('name', 'BLOB'),
      col('value', 'BLOB'),
      col('items', 'UBIGINT'),
      col('bytes', 'UBIGINT'),
    ],
    orderBy: ['bucket', 'name', 'value'],
    derive: (t) =>
      `WITH items AS (
         SELECT DISTINCT id, height, data_size
         FROM read_parquet(${sqlPaths(t.data_items)})),
       picked AS (
         SELECT height, id, tag_name AS name, arg_min(tag_value, tag_index) AS value
         FROM read_parquet(${sqlPaths(t.tags)})
         WHERE ${tagNameIn('tag_name', statTags)}
         GROUP BY height, id, tag_name)
       SELECT ${bucket} AS bucket, ''::BLOB AS name, ''::BLOB AS value,
              count(*)::UBIGINT AS items,
              coalesce(sum(data_size), 0)::UBIGINT AS bytes
       FROM items GROUP BY 1
       UNION ALL
       SELECT ${bucket} AS bucket, name, value,
              count(*)::UBIGINT AS items,
              coalesce(sum(data_size), 0)::UBIGINT AS bytes
       FROM items JOIN picked USING (height, id)
       GROUP BY 1, 2, 3`,
  };
}

/** What of a band the lookups it carries depend on. */
export type ParquetL2LookupLayout = Pick<
  ParquetL2Band,
  'schema' | 'keyTags' | 'statTags'
>;

/**
 * The lookups a band carries, by its layout: `l2-1`'s three, and under
 * `l2-2` the key lookup and stats for the tag names its `band.json` gives.
 */
export function lookupsOf(band: ParquetL2LookupLayout): LookupSpec[] {
  if (!hasDerivedTags(band.schema)) return PARQUET_L2_LOOKUPS;
  return [
    ...PARQUET_L2_LOOKUPS,
    keyLookup(band.keyTags ?? []),
    statsLookup(band.statTags ?? []),
  ];
}

/**
 * The order `l2-1` and `l2-2` lookup digests are taken in: `numeric`, the
 * spec's order by value, which is the files' own order, so a reader can
 * digest a lookup as it reads it. (An `l1-3` band's are taken in
 * `legacy-text` order.)
 */
export const PARQUET_L2_LOOKUP_DIGEST_ORDER: LookupDigestOrder = 'numeric';

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
  /**
   * `l2-2`: the tag names `lookup_key.parquet` is derived for, each once,
   * in UTF-8 byte order; empty for none. Absent under `l2-1`.
   */
  keyTags?: string[];
  /** `l2-2`: the tag names `stats.parquet` counts by, as `keyTags`. */
  statTags?: string[];
  /** Per table: rows, and a digest of the rows, independent of the Parquet bytes. */
  tables: Record<string, { rows: number; rowDigest: string }>;
  /**
   * Per lookup: rows, and a digest of the rows. Derived from the tables, so
   * not part of the band's id ({@link bandTablesDigest}).
   */
  lookups: Record<string, LookupDescription>;
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
  'keyTags',
  'statTags',
  'tables',
  'lookups',
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
 * A band's `band.json`, written the one way: fields, tables and lookups in
 * the layout's order, the selection's keys in its declared order, and the keys
 * of `checks` sorted. Two publishers of the same rows therefore write the
 * same bytes.
 */
export function serializeBandFile(band: ParquetL2Band): string {
  const derived = hasDerivedTags(band.schema);
  if (derived && (band.keyTags === undefined || band.statTags === undefined)) {
    throw new Error(`A ${band.schema} band names its keyTags and statTags`);
  }
  if (!derived && (band.keyTags !== undefined || band.statTags !== undefined)) {
    throw new Error(`A ${band.schema} band has no keyTags or statTags`);
  }
  const canonical = {
    version: band.version,
    schema: band.schema,
    heightRange: [band.heightRange[0], band.heightRange[1]],
    selection: canonicalSelection(band.selection),
    ...(derived
      ? {
          keyTags: canonicalTagNames(band.keyTags!),
          statTags: canonicalTagNames(band.statTags!),
        }
      : {}),
    tables: Object.fromEntries(
      PARQUET_L2_TABLES.map(({ name }) => [
        name,
        {
          rows: band.tables[name].rows,
          rowDigest: band.tables[name].rowDigest,
        },
      ]),
    ),
    lookups: Object.fromEntries(
      lookupsOf(band).map(({ name }) => [
        name,
        {
          rows: band.lookups[name].rows,
          rowDigest: band.lookups[name].rowDigest,
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
 * Parses what a `band.json` says of its tables, or of its lookups: exactly
 * `names`, each with rows and a row digest and nothing else.
 */
function parseDescriptions(
  raw: unknown,
  names: string[],
  what: 'table' | 'lookup',
): Record<string, LookupDescription> {
  if (!isObject(raw)) {
    throw new Error(`${BAND_FILE}: ${what}s must be an object`);
  }
  for (const name of Object.keys(raw)) {
    if (!names.includes(name)) {
      throw new Error(`${BAND_FILE}: unknown ${what} ${JSON.stringify(name)}`);
    }
  }
  const parsed: Record<string, LookupDescription> = {};
  for (const name of names) {
    const entry = raw[name];
    if (
      !isObject(entry) ||
      Object.keys(entry).some((key) => key !== 'rows' && key !== 'rowDigest') ||
      !isCount(entry.rows) ||
      typeof entry.rowDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.rowDigest)
    ) {
      throw new Error(
        `${BAND_FILE}: ${what} ${name} needs rows and a 64-hex rowDigest, and nothing else`,
      );
    }
    parsed[name] = { rows: entry.rows, rowDigest: entry.rowDigest };
  }
  return parsed;
}

/**
 * Parses and checks a `band.json`. A publisher's file comes from anywhere,
 * so every field is checked, a field the layout doesn't declare is refused,
 * and every table and lookup of the layout must be described.
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
  const derived = hasDerivedTags(schema);
  for (const field of ['keyTags', 'statTags'] as const) {
    if (!derived && raw[field] !== undefined) {
      throw new Error(`${BAND_FILE}: a ${schema} band has no ${field}`);
    }
    if (derived && raw[field] === undefined) {
      throw new Error(`${BAND_FILE}: a ${schema} band names its ${field}`);
    }
  }
  const tagNames = derived
    ? {
        keyTags: parseTagNames(raw.keyTags, `${BAND_FILE}: keyTags`),
        statTags: parseTagNames(raw.statTags, `${BAND_FILE}: statTags`),
      }
    : {};
  const names = PARQUET_L2_TABLES.map((table) => table.name);
  const tables = parseDescriptions(raw.tables, names, 'table');
  const lookups = parseDescriptions(
    raw.lookups,
    lookupsOf({ schema, ...tagNames }).map((spec) => spec.name),
    'lookup',
  );
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
    ...tagNames,
    tables,
    lookups,
    ...(raw.checks !== undefined ? { checks: raw.checks } : {}),
    createdAt: raw.createdAt,
  };
}

/**
 * Every file a band of a layout holds, sorted: its description, one Parquet
 * file per table, and one per lookup. Publisher, subscriber and verifier
 * all take a band's files from here, by the layout its `band.json` names.
 */
export function bandFiles(schema: ParquetL2Schema): string[] {
  return [
    BAND_FILE,
    ...PARQUET_L2_TABLES.map((table) => table.file),
    ...lookupsOf({ schema, keyTags: [], statTags: [] }).map(
      (spec) => spec.file,
    ),
  ].sort();
}

/**
 * A digest of what a band holds: its heights, its selection, and every
 * table's row count and row digest. Independent of the Parquet bytes, so
 * two publishers that wrote the same rows under the same selection agree on
 * it; the selection is bound in, so bands of two selections never do, even
 * where they hold the same rows (none, say). `lookups`, `keyTags`,
 * `statTags`, `checks` and `createdAt` are left out: lookups are derived
 * from the tables, so adding or changing them never changes a band's id.
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
