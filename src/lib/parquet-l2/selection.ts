/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A `parquet-l2` selection applied: in JavaScript, to the rows a source
 * gives, as SQL a ClickHouse source pushes down, and as SQL DuckDB runs over
 * a band's `tags` to check every item is one the selection takes
 * (`index-l2-verify`). All follow the
 * layout's rule (`src/lib/parquet-l2/layout.ts`): an item is selected when
 * ONE of its tags is named `tag.name`, byte for byte, and has a value that
 * starts with `tag.valuePrefix` and not with `tag.excludeValuePrefix`, all
 * compared as UTF-8 bytes. Names and values are never decoded, so a value
 * that is not UTF-8 is compared as the bytes it is.
 */
import type { ParquetL2Selection } from './layout.js';

/** One tag of an item, as bytes. */
export interface ItemTag {
  name: Buffer;
  value: Buffer;
}

const startsWith = (value: Buffer, prefix: Buffer) =>
  value.length >= prefix.length &&
  value.subarray(0, prefix.length).equals(prefix);

/** A selection's strings as the bytes it compares. */
export function selectionBytes(selection: ParquetL2Selection): {
  name: Buffer;
  valuePrefix: Buffer;
  excludeValuePrefix?: Buffer;
} {
  const { name, valuePrefix, excludeValuePrefix } = selection.tag;
  return {
    name: Buffer.from(name, 'utf8'),
    valuePrefix: Buffer.from(valuePrefix, 'utf8'),
    ...(excludeValuePrefix !== undefined
      ? { excludeValuePrefix: Buffer.from(excludeValuePrefix, 'utf8') }
      : {}),
  };
}

/** A matcher for one selection, its strings encoded once. */
export function selectionMatcher(
  selection: ParquetL2Selection,
): (tags: readonly ItemTag[]) => boolean {
  const { name, valuePrefix, excludeValuePrefix } = selectionBytes(selection);
  return (tags) =>
    tags.some(
      (tag) =>
        tag.name.equals(name) &&
        startsWith(tag.value, valuePrefix) &&
        (excludeValuePrefix === undefined ||
          !startsWith(tag.value, excludeValuePrefix)),
    );
}

/** Whether an item with these tags is in the selection. */
export function selects(
  selection: ParquetL2Selection,
  tags: readonly ItemTag[],
): boolean {
  return selectionMatcher(selection)(tags);
}

/**
 * The selection as a ClickHouse condition on a `transactions` row, with its
 * parameters: one tag (the same tag) named exactly `name`, its value
 * starting with the prefix and not the excluded one, compared as bytes.
 * The strings travel hex-encoded and are compared after `unhex`, so no
 * escaping stands between the selection and the bytes compared.
 * `has(tag_names, …)` repeats the name test where the table's bloom filter
 * on `tag_names` can skip granules without it.
 */
export function selectionClickHouse(selection: ParquetL2Selection): {
  condition: string;
  params: Record<string, string>;
} {
  const { name, valuePrefix, excludeValuePrefix } = selectionBytes(selection);
  const exclude =
    excludeValuePrefix !== undefined
      ? ' AND NOT startsWith(v, unhex({l2_exclude:String}))'
      : '';
  return {
    condition:
      'has(tag_names, unhex({l2_name:String})) AND arrayExists((n, v) -> ' +
      'n = unhex({l2_name:String}) AND ' +
      `startsWith(v, unhex({l2_prefix:String}))${exclude}, ` +
      'tag_names, tag_values)',
    params: {
      l2_name: name.toString('hex'),
      l2_prefix: valuePrefix.toString('hex'),
      ...(excludeValuePrefix !== undefined
        ? { l2_exclude: excludeValuePrefix.toString('hex') }
        : {}),
    },
  };
}

/**
 * The selection as a DuckDB condition on one `tags` row (`tag_name`,
 * `tag_value`, both BLOB): the row's name is `tag.name` and its value starts
 * with the prefix and not the excluded one, as bytes. Prefixes are compared
 * on the values' hex, which starts with a prefix's hex exactly when the
 * bytes start with the prefix's bytes. The strings are inlined as hex, so
 * nothing in them is SQL. NULL for a NULL name or value: callers wrap it in
 * `coalesce(…, false)`.
 */
export function selectionDuckDb(selection: ParquetL2Selection): string {
  const { name, valuePrefix, excludeValuePrefix } = selectionBytes(selection);
  const hex = (b: Buffer) => b.toString('hex').toUpperCase();
  return (
    `(tag_name = from_hex('${hex(name)}') AND starts_with(hex(tag_value), '${hex(valuePrefix)}')` +
    (excludeValuePrefix !== undefined
      ? ` AND NOT starts_with(hex(tag_value), '${hex(excludeValuePrefix)}'))`
      : ')')
  );
}
