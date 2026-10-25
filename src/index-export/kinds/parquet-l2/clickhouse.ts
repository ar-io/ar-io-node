/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The `parquet-l2` item source over a ClickHouse `transactions` table: this
 * gateway's own, or a peer indexer's.
 *
 * The table is a `ReplacingMergeTree(inserted_at)` keyed by `(height,
 * block_transaction_index, is_data_item, id)`, so every query reads it
 * `FINAL`: one row per key, the newest. Two keys can still hold one item at
 * one height (an item row filed under a wrong `block_transaction_index` and
 * the corrected one); the exporter assigns every row its root's position and
 * then keeps distinct rows, so those collapse.
 *
 * The selection is pushed down (`selectionClickHouse`), and each window's
 * nested bundles are read by id, level by level, up to their roots.
 */
import {
  CLICKHOUSE_EXPORT_SETTINGS,
  ClickHouseQuerier,
} from '../root-tx/sources/clickhouse.js';
import type { ParquetL2Selection } from '../../../lib/parquet-l2/layout.js';
import { selectionClickHouse } from '../../../lib/parquet-l2/selection.js';
import type {
  L2ItemSource,
  L2SourceRow,
  L2SourceWindow,
  RootPosition,
} from './source.js';

/** Heights per window, at most. */
export const CLICKHOUSE_L2_WINDOW_BLOCKS = 250;

/**
 * Items per window, at most: a window's items and their tags are held at
 * once, so a window that holds more is split, down to a single height.
 */
export const CLICKHOUSE_L2_WINDOW_ITEMS = 50_000;

/** Ids per lookup by id, well inside a URL's limit as query parameters. */
export const CLICKHOUSE_ID_CHUNK = 1000;

/** Nesting levels followed up from an item; deeper bundles stay unread. */
export const MAX_NESTING = 16;

const MAX_EXECUTION_SECONDS = 600;
const MEMORY_LIMIT_EXCEEDED = /\bCode: 241\b|MEMORY_LIMIT_EXCEEDED/;
const READONLY_PROFILE = /readonly mode|Cannot modify '\w+' setting/;

/**
 * The columns of a row, item or bundle. No alias names a column: ClickHouse
 * substitutes a SELECT alias into WHERE, so `hex(id) AS id` would turn the
 * id lookups into comparisons of hex with bytes.
 */
const ROW_COLUMNS = `
    hex(id) AS id_hex,
    hex(parent_id) AS parent_hex,
    hex(root_transaction_id) AS root_hex,
    height,
    "offset" AS item_offset,
    "size" AS item_size,
    data_offset,
    owner_offset,
    owner_size,
    signature_offset,
    signature_size,
    root_parent_offset,
    data_size,
    signature_type,
    hex(owner_address) AS owner_address_hex,
    hex(owner) AS owner_hex,
    hex(target) AS target_hex,
    hex(anchor) AS anchor_hex`;

/** A window's selected items, with their tags in order. */
export function itemsQuery(selection: ParquetL2Selection): {
  query: string;
  params: Record<string, string>;
} {
  const { condition, params } = selectionClickHouse(selection);
  return {
    query: `
  SELECT ${ROW_COLUMNS},
    arrayMap(t -> hex(t.1), tags) AS tag_names_hex,
    arrayMap(t -> hex(t.2), tags) AS tag_values_hex
  FROM transactions FINAL
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND is_data_item
    AND ${condition}`,
    params,
  };
}

/** How many selected items the heights hold: what the band size cap reads. */
export function countQuery(selection: ParquetL2Selection): {
  query: string;
  params: Record<string, string>;
} {
  const { condition, params } = selectionClickHouse(selection);
  return {
    query: `
  SELECT count() AS items
  FROM transactions FINAL
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND is_data_item
    AND ${condition}`,
    params,
  };
}

/**
 * A digest of every row a window's queries read, over the heights: the
 * selected items (every column the item query reads, `inserted_at`
 * included), every nested bundle row (a superset of the bundles above
 * them), and the L1 rows of their roots. Read without `FINAL`, as the
 * root-TX fingerprint is, so a row added, changed, merged away or expired
 * changes it; summed as well as XORed, so two identical rows don't cancel.
 */
export function fingerprintQuery(selection: ParquetL2Selection): {
  query: string;
  params: Record<string, string>;
} {
  const { condition, params } = selectionClickHouse(selection);
  const range = 'height >= {from:UInt32} AND height <= {to:UInt32}';
  return {
    query: `
  SELECT
    count() AS rows,
    toString(groupBitXor(h)) AS xor,
    toString(sumWithOverflow(h)) AS sum
  FROM (
    SELECT cityHash64(
      'item', id, parent_id, root_transaction_id, height,
      block_transaction_index, inserted_at, "offset", "size", data_offset,
      owner_offset, owner_size, signature_offset, signature_size,
      signature_type, root_parent_offset, data_size, owner_address, owner,
      target, anchor, tags
    ) AS h
    FROM transactions
    WHERE ${range} AND is_data_item AND ${condition}
    UNION ALL
    SELECT cityHash64(
      'bundle', id, parent_id, root_transaction_id, height,
      block_transaction_index, inserted_at, "offset", "size", data_offset,
      root_parent_offset, data_size
    ) AS h
    FROM transactions
    WHERE ${range} AND is_data_item
      AND id IN (
        SELECT parent_id FROM transactions
        WHERE ${range} AND is_data_item AND parent_id != root_transaction_id)
    UNION ALL
    SELECT cityHash64(
      'root', id, height, block_transaction_index, inserted_at
    ) AS h
    FROM transactions
    WHERE ${range} AND NOT is_data_item
      AND id IN (
        SELECT root_transaction_id FROM transactions
        WHERE ${range} AND is_data_item AND ${condition})
  )`,
    params,
  };
}

/** The distinct owners of the selected items of some heights. */
export function ownersQuery(selection: ParquetL2Selection): {
  query: string;
  params: Record<string, string>;
} {
  const { condition, params } = selectionClickHouse(selection);
  return {
    query: `
  SELECT DISTINCT hex(owner_address) AS owner_hex
  FROM transactions
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND is_data_item AND ${condition}`,
    params,
  };
}

/** Data item rows by id, within a window's heights. */
export const ROWS_BY_ID_QUERY = `
  SELECT ${ROW_COLUMNS}
  FROM transactions FINAL
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND is_data_item
    AND id IN (SELECT unhex(arrayJoin({ids:Array(String)})))`;

/** L1 rows by id: where each root sits. */
export const ROOT_POSITIONS_QUERY = `
  SELECT DISTINCT hex(id) AS id_hex, height, block_transaction_index
  FROM transactions FINAL
  WHERE height >= {from:UInt32} AND height <= {to:UInt32}
    AND NOT is_data_item
    AND id IN (SELECT unhex(arrayJoin({ids:Array(String)})))`;

export interface RawRow {
  id_hex: string;
  parent_hex: string;
  root_hex: string;
  height: number | string;
  item_offset: number | string;
  item_size: number | string;
  data_offset: number | string;
  owner_offset: number | string;
  owner_size: number | string;
  signature_offset: number | string;
  signature_size: number | string;
  root_parent_offset: number | string;
  data_size: number | string;
  signature_type: number | string;
  owner_address_hex: string;
  owner_hex: string;
  target_hex: string;
  anchor_hex: string;
  tag_names_hex?: string[];
  tag_values_hex?: string[];
}

const bytes = (hex: string): Buffer | undefined =>
  hex.length > 0 ? Buffer.from(hex, 'hex') : undefined;

/** ClickHouse stores a missing offset or size as 0, and none is 0 when known. */
const known = (value: number | string): number | undefined => {
  const number = Number(value);
  return number === 0 ? undefined : number;
};

/** A ClickHouse row as the exporter reads it. */
export function toSourceRow(raw: RawRow): L2SourceRow {
  const row: L2SourceRow = {
    id: Buffer.from(raw.id_hex, 'hex'),
    height: Number(raw.height),
    rootParentOffset: Number(raw.root_parent_offset),
    dataSize: Number(raw.data_size),
  };
  const set = <K extends keyof L2SourceRow>(
    key: K,
    value: L2SourceRow[K] | undefined,
  ) => {
    if (value !== undefined) row[key] = value;
  };
  set('parentId', bytes(raw.parent_hex));
  set('rootTxId', bytes(raw.root_hex));
  set('offset', known(raw.item_offset));
  set('size', known(raw.item_size));
  set('dataOffset', known(raw.data_offset));
  set('ownerOffset', known(raw.owner_offset));
  set('ownerSize', known(raw.owner_size));
  set('signatureOffset', known(raw.signature_offset));
  set('signatureSize', known(raw.signature_size));
  // 0 is no signature type: the index didn't record one.
  set('signatureType', known(raw.signature_type));
  set('ownerAddress', bytes(raw.owner_address_hex));
  set('owner', bytes(raw.owner_hex));
  set('target', bytes(raw.target_hex));
  set('anchor', bytes(raw.anchor_hex));
  if (raw.tag_names_hex !== undefined) {
    const values = raw.tag_values_hex ?? [];
    if (values.length !== raw.tag_names_hex.length) {
      throw new Error(
        `ClickHouse gave item ${raw.id_hex} ${raw.tag_names_hex.length} tag names and ${values.length} values`,
      );
    }
    row.tags = raw.tag_names_hex.map((name, i) => ({
      name: Buffer.from(name, 'hex'),
      value: Buffer.from(values[i], 'hex'),
    }));
  }
  return row;
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/** A response cut short by a server error carries the error text in place of a row. */
function parseLine<T>(line: { text: string; json<U>(): U }): T {
  try {
    return line.json<T>();
  } catch {
    throw new Error(
      `ClickHouse returned a line that isn't a row: ${line.text.slice(0, 300)}`,
    );
  }
}

/** Gives up on a query a minute after the server should have stopped it. */
const deadline = () => AbortSignal.timeout((MAX_EXECUTION_SECONDS + 60) * 1000);

export class ClickHouseL2Source implements L2ItemSource {
  constructor(
    readonly name: string,
    private readonly client: ClickHouseQuerier,
    private readonly windowBlocks = CLICKHOUSE_L2_WINDOW_BLOCKS,
    private readonly windowItems = CLICKHOUSE_L2_WINDOW_ITEMS,
    /**
     * Where the table is, its URL's origin and path (`urlIdentity`): another
     * place is another source. Recorded and logged, so never credentials.
     */
    private readonly where = '',
  ) {}

  get identity(): string {
    return `clickhouse ${this.where}`.trim();
  }

  async fingerprint(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<string> {
    const { query, params } = fingerprintQuery(selection);
    const rows = await this.rows<{
      rows: number | string;
      xor: string;
      sum: string;
    }>(query, { ...params, from, to }, `fingerprint of heights ${from}-${to}`);
    const [row] = rows;
    if (rows.length !== 1 || row.xor === undefined || row.sum === undefined) {
      throw new Error(
        `ClickHouse source ${this.name}, fingerprint of heights ${from}-${to}: expected one row of rows, xor and sum`,
      );
    }
    return `rows ${Number(row.rows)} xor ${row.xor} sum ${row.sum}`;
  }

  async count(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<number> {
    const { query, params } = countQuery(selection);
    const rows = await this.rows<{ items: number | string }>(
      query,
      { ...params, from, to },
      `item count of heights ${from}-${to}`,
    );
    return Number(rows[0]?.items ?? 0);
  }

  async *owners(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<Buffer> {
    const { query, params } = ownersQuery(selection);
    const rows = await this.rows<{ owner_hex: string }>(
      query,
      { ...params, from, to },
      `owners at heights ${from}-${to}`,
    );
    for (const row of rows) yield Buffer.from(row.owner_hex, 'hex');
  }

  /**
   * One below the highest height in the table, or -1 when it is empty: the
   * top height may still be part way through an import.
   */
  async stableHeight(): Promise<number> {
    const rows = await this.rows<{ height: number | string }>(
      'SELECT max(height) AS height FROM transactions',
      {},
      'stable height',
    );
    const height = Number(rows[0]?.height ?? 0);
    return height > 0 ? height - 1 : -1;
  }

  async *windows(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): AsyncIterable<L2SourceWindow> {
    const pending: Array<[number, number]> = [];
    for (let start = from; start <= to; start += this.windowBlocks) {
      pending.push([start, Math.min(to, start + this.windowBlocks - 1)]);
    }
    while (pending.length > 0) {
      const [start, end] = pending.shift() as [number, number];
      let window: L2SourceWindow | undefined;
      try {
        window = await this.window(start, end, selection);
      } catch (error) {
        // Out of memory: split the window and go on.
        if (start < end && MEMORY_LIMIT_EXCEEDED.test(String(error))) {
          const middle = Math.floor((start + end) / 2);
          pending.unshift([start, middle], [middle + 1, end]);
          continue;
        }
        throw error;
      }
      // More items than a window holds: in halves, down to one height.
      if (window === undefined) {
        const middle = Math.floor((start + end) / 2);
        pending.unshift([start, middle], [middle + 1, end]);
        continue;
      }
      yield window;
    }
  }

  /** A window's items and bundles; undefined when it holds too many items to split no further. */
  private async window(
    from: number,
    to: number,
    selection: ParquetL2Selection,
  ): Promise<L2SourceWindow | undefined> {
    const { query, params } = itemsQuery(selection);
    const raw = await this.limitedRows<RawRow>(
      query,
      { ...params, from, to },
      `items at heights ${from}-${to}`,
      from < to ? this.windowItems : undefined,
    );
    if (raw === undefined) return undefined;
    const items = raw.map(toSourceRow);
    const ancestors: L2SourceRow[] = [];
    const asked = new Set<string>();
    const parentsOf = (rows: L2SourceRow[]) => {
      const ids = new Set<string>();
      for (const row of rows) {
        if (
          row.parentId === undefined ||
          row.rootTxId === undefined ||
          row.parentId.equals(row.rootTxId)
        ) {
          continue;
        }
        const hex = row.parentId.toString('hex');
        if (!asked.has(hex)) ids.add(hex);
      }
      return [...ids].sort();
    };
    let level = parentsOf(items);
    for (let depth = 0; depth < MAX_NESTING && level.length > 0; depth++) {
      const found: L2SourceRow[] = [];
      for (const ids of chunks(level, CLICKHOUSE_ID_CHUNK)) {
        for (const id of ids) asked.add(id);
        const rows = await this.rows<RawRow>(
          ROWS_BY_ID_QUERY,
          { from, to, ids },
          `nested bundles at heights ${from}-${to}`,
        );
        found.push(...rows.map(toSourceRow));
      }
      ancestors.push(...found);
      level = parentsOf(found);
    }
    return { from, to, items, ancestors };
  }

  async rootPositions(
    roots: Buffer[],
    from: number,
    to: number,
  ): Promise<RootPosition[]> {
    const out: RootPosition[] = [];
    const ids = [...new Set(roots.map((root) => root.toString('hex')))].sort();
    for (const chunk of chunks(ids, CLICKHOUSE_ID_CHUNK)) {
      const rows = await this.rows<{
        id_hex: string;
        height: number | string;
        block_transaction_index: number | string;
      }>(
        ROOT_POSITIONS_QUERY,
        { from, to, ids: chunk },
        `root transactions at heights ${from}-${to}`,
      );
      for (const row of rows) {
        out.push({
          id: Buffer.from(row.id_hex, 'hex'),
          height: Number(row.height),
          blockTransactionIndex: Number(row.block_transaction_index),
        });
      }
    }
    return out;
  }

  /** The block's time from any row at its height; undefined with none. */
  async blockTime(height: number): Promise<number | undefined> {
    const [row] = await this.rows<{ n: number | string; ts: number | string }>(
      'SELECT count() AS n, max(block_timestamp) AS ts FROM transactions WHERE height = {height:UInt32}',
      { height },
      `the time of block ${height}`,
    );
    if (row === undefined || Number(row.n) === 0 || Number(row.ts) <= 0) {
      return undefined;
    }
    return Number(row.ts);
  }

  /** A query's rows. */
  private async rows<T>(
    query: string,
    params: Record<string, unknown>,
    what: string,
  ): Promise<T[]> {
    return (await this.limitedRows<T>(query, params, what)) as T[];
  }

  /**
   * A query's rows; with `limit`, undefined once it returns more, the query
   * cancelled rather than read to the end.
   */
  private async limitedRows<T>(
    query: string,
    params: Record<string, unknown>,
    what: string,
    limit?: number,
  ): Promise<T[] | undefined> {
    const cancel = new AbortController();
    try {
      const result = await this.client.query({
        query,
        format: 'JSONEachRow',
        query_params: params,
        clickhouse_settings: { ...CLICKHOUSE_EXPORT_SETTINGS },
        abort_signal: AbortSignal.any([deadline(), cancel.signal]),
      });
      const rows: T[] = [];
      for await (const batch of result.stream()) {
        for (const line of batch) rows.push(parseLine<T>(line));
        if (limit !== undefined && rows.length > limit) {
          cancel.abort();
          return undefined;
        }
      }
      return rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = READONLY_PROFILE.test(message)
        ? ' (the ClickHouse user must be allowed to change settings: readonly=0 or 2, not 1)'
        : '';
      throw new Error(
        `ClickHouse source ${this.name}, ${what}: ${message}${hint}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
