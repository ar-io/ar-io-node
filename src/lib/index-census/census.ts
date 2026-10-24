/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The index census: does ClickHouse hold every data item the bundle indexer
 * says it indexed?
 *
 * The indexer unbundles into SQLite, the ClickHouse import exports the stable
 * rows and then prunes them from SQLite. Nothing afterwards checks that the
 * rows arrived, and a row that was pruned without being exported is gone from
 * both: the bundle stays `last_fully_indexed_at`, so nothing retries it, and
 * every index built from ClickHouse (and every gateway subscribed to one)
 * silently lacks the item.
 *
 * Two facts make the check possible without reading any bundle:
 *
 * - `bundles.matched_data_item_count` and `bundle_data_items` (the item ids of
 *   each bundle) are kept when the item rows are pruned;
 * - ClickHouse `transaction_ids` has no TTL, so an id that expired out of
 *   `transactions` is still listed there, while one that was never imported is
 *   in neither.
 *
 * Stage 1 compares, per root transaction, the indexer's item count with the
 * distinct ids ClickHouse holds under that root. Stage 2 takes only the roots
 * that come up short and looks up every item id, so each item is one of:
 *
 * - `here`: in `transactions` under this root;
 * - `elsewhere`: in `transactions` under another root only. The same item in
 *   two bundles is stored once, under the first one flushed
 *   (`ON CONFLICT DO NOTHING`), so the second bundle merely looks short;
 * - `expired`: in `transaction_ids` but not `transactions`: removed after
 *   import, by the TTL rules or otherwise;
 * - `missing`: in neither: never imported. Re-queuing the bundle restores it.
 *
 * Read-only on both databases.
 */
import type { ClickHouseQuerier } from '../../index-export/kinds/root-tx/sources/clickhouse.js';

/** Heights per stage 1 query. */
export const CENSUS_WINDOW_BLOCKS = 10_000;

/**
 * Ids per stage 2 query. They go as a query parameter, which ClickHouse caps
 * at `http_max_field_value_size` (128 KiB by default): a hex id with its
 * quoting is 67 bytes, so 1,000 is about 67 KB. 2,000 was refused.
 */
export const CENSUS_ID_CHUNK = 1_000;

/** Same bounds as the export, so a census can't starve the gateway. */
export const CENSUS_CLICKHOUSE_SETTINGS = {
  readonly: '2',
  max_threads: 2,
  max_memory_usage: '4000000000',
  max_bytes_before_external_group_by: '2000000000',
  max_execution_time: 600,
  priority: 10,
  cancel_http_readonly_queries_on_client_close: 1,
  output_format_json_quote_64bit_integers: 0,
} as const;

/**
 * Distinct item ids per root in a height window. The aliases are not column
 * names: an alias named like a column shadows it in WHERE, and an id check
 * written that way compares base64 to bytes and finds nothing.
 */
export const ROOT_COUNTS_QUERY = `
  SELECT hex(root_transaction_id) AS root_hex, uniqExact(id) AS item_count
  FROM transactions
  WHERE height >= {from:UInt32} AND height <= {to:UInt32} AND is_data_item
  GROUP BY root_transaction_id`;

/** The top height ClickHouse holds, for an open-ended range. */
export const MAX_HEIGHT_QUERY = 'SELECT max(height) AS top FROM transactions';

/** Heights of root transactions, by id. */
export const ROOT_HEIGHTS_QUERY = `
  SELECT hex(id) AS key_hex, min(height) AS root_height
  FROM transaction_ids
  WHERE id IN (SELECT unhex(arrayJoin({ids:Array(String)}))) AND NOT is_data_item
  GROUP BY id`;

/** Every height an item id was imported at, by id. */
export const ITEM_SEEN_QUERY = `
  SELECT hex(id) AS key_hex, groupUniqArray(height) AS seen_heights
  FROM transaction_ids
  WHERE id IN (SELECT unhex(arrayJoin({ids:Array(String)}))) AND is_data_item
  GROUP BY id`;

/**
 * The roots each item id is held under now. Read by primary key: the heights
 * come from `transaction_ids`, so this never scans for an id.
 */
export const ITEM_ROOTS_QUERY = `
  SELECT hex(id) AS key_hex, groupUniqArray(hex(root_transaction_id)) AS held_under
  FROM transactions
  WHERE height IN (SELECT arrayJoin({heights:Array(UInt32)}))
    AND id IN (SELECT unhex(arrayJoin({ids:Array(String)}))) AND is_data_item
  GROUP BY id`;

/** The read-only part of `better-sqlite3` the census uses. */
export interface CensusSqlite {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  };
}

export type ItemState = 'here' | 'elsewhere' | 'expired' | 'missing';

/**
 * What a short root is, by its worst item: `missing` if any item was never
 * imported, else `expired`, else `duplicate` (every absent item is held under
 * another root), else `complete` (the indexer's count was high: all its listed
 * items are here), or `unlisted` when bundles.db lists no item ids for it.
 */
export type RootClass =
  | 'missing'
  | 'expired'
  | 'duplicate'
  | 'complete'
  | 'unlisted';

export interface ShortRoot {
  /** Base64url. */
  root: string;
  /** The root transaction's height, or null when ClickHouse has no L1 row. */
  height: number | null;
  /** The indexer's matched item count, summed over the root's bundles. */
  expected: number;
  /** Distinct ids ClickHouse held under the root in stage 1. */
  heldUnderRoot: number;
  /** Item ids bundles.db lists for the root. */
  listed: number;
  here: number;
  elsewhere: number;
  expired: number;
  missing: number;
  class: RootClass;
}

export interface CensusResult {
  heightRange: [number, number];
  roots: {
    /** Roots whose every bundle is fully indexed, with matched items. */
    indexed: number;
    /** Of those, the roots in the range: complete plus short. */
    checked: number;
    /** With --roots, listed roots that are not (fully) indexed. */
    notIndexed: number;
    /**
     * Roots with a bundle not (yet) fully indexed, left out. Counted over the
     * whole of bundles.db (or the --roots list), not the height range: the
     * range is applied by root height, which these roots are not looked up
     * for. Bundles that never unbundle at all (data tagged Bundle-Format,
     * exhausted retries) keep their root here permanently.
     */
    inProgress: number;
    /** Indexed roots whose height is outside the range, left out. */
    outOfRange: number;
    complete: number;
    short: number;
    byClass: Record<RootClass, number>;
    /** Short roots with no L1 row in ClickHouse (e.g. never mined). */
    withoutL1Row: number;
  };
  items: {
    expected: number;
    here: number;
    elsewhere: number;
    expired: number;
    missing: number;
  };
  /** Missing items by height bucket start, short roots without a height under -1. */
  missingByHeight: Record<string, number>;
  /**
   * Bundles queued for unbundling that never were, with their retries
   * exhausted or abandoned: top-level ones and nested ones. Most are not
   * bundles at all (data tagged Bundle-Format, ANS-102 JSON bundles) or are
   * unseeded; this counts them, it does not judge them.
   */
  stalledBundles: { topLevel: number; nested: number };
}

export interface CensusOptions {
  bundles: CensusSqlite;
  clickhouse: ClickHouseQuerier;
  from?: number;
  to?: number;
  /** Check only these roots (base64url), skipping stage 1's full scan. */
  roots?: string[];
  windowBlocks?: number;
  idChunk?: number;
  bucketBlocks?: number;
  /** Called once per short root, as it is classified. */
  onShortRoot?: (root: ShortRoot) => void;
  log?: { info(message: string, meta?: Record<string, unknown>): void };
}

const toHex = (buf: Buffer) => buf.toString('hex').toUpperCase();
const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');
const b64ToHex = (b64: string) => {
  const buf = Buffer.from(b64, 'base64url');
  if (buf.length !== 32 || buf.toString('base64url') !== b64) {
    throw new Error(`not a transaction id: ${b64}`);
  }
  return toHex(buf);
};

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function rows<T>(
  clickhouse: ClickHouseQuerier,
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const result = await clickhouse.query({
    query,
    format: 'JSONEachRow',
    query_params: params,
    clickhouse_settings: { ...CENSUS_CLICKHOUSE_SETTINGS },
    abort_signal: AbortSignal.timeout(660_000),
  });
  const out: T[] = [];
  for await (const batch of result.stream()) {
    for (const line of batch) out.push(line.json<T>());
  }
  return out;
}

/**
 * Per root, the matched item count summed over its bundles, for roots whose
 * every bundle is fully indexed. A root with a bundle still in progress would
 * look short, so it is counted apart.
 */
function indexedRoots(
  bundles: CensusSqlite,
  only?: Set<string>,
): { expected: Map<string, number>; inProgress: number } {
  const expected = new Map<string, number>();
  let inProgress = 0;
  const select = `
    SELECT root_transaction_id AS root,
           SUM(COALESCE(matched_data_item_count, 0)) AS matched,
           MIN(last_fully_indexed_at IS NOT NULL) AS all_indexed
    FROM bundles
    WHERE root_transaction_id IS NOT NULL`;
  const statement =
    only === undefined
      ? bundles.prepare(`${select} GROUP BY root_transaction_id`)
      : bundles.prepare(`${select} AND root_transaction_id = ?`);
  const take = (row: {
    root: Buffer | null;
    matched: number;
    all_indexed: number;
  }) => {
    if (row.root === null || !(row.matched > 0)) return;
    if (row.all_indexed !== 1) {
      inProgress++;
      return;
    }
    expected.set(toHex(row.root), row.matched);
  };
  if (only === undefined) {
    for (const row of statement.iterate()) take(row as never);
  } else {
    for (const hex of only) {
      for (const row of statement.all(Buffer.from(hex, 'hex'))) {
        take(row as never);
      }
    }
  }
  return { expected, inProgress };
}

/** Bundles queued, never unbundled, and not queued again for a day. */
function stalledBundles(bundles: CensusSqlite, nowSeconds: number) {
  const [row] = bundles
    .prepare(
      `SELECT
         SUM(CASE WHEN id = root_transaction_id THEN 1 ELSE 0 END) AS top_level,
         SUM(CASE WHEN id != root_transaction_id THEN 1 ELSE 0 END) AS nested
       FROM bundles
       WHERE index_filter_id IS NOT NULL
         AND last_unbundled_at IS NULL
         AND last_queued_at < ?`,
    )
    .all(nowSeconds - 86_400) as Array<{
    top_level: number | null;
    nested: number | null;
  }>;
  return { topLevel: row?.top_level ?? 0, nested: row?.nested ?? 0 };
}

export async function runCensus(options: CensusOptions): Promise<CensusResult> {
  const {
    bundles,
    clickhouse,
    windowBlocks = CENSUS_WINDOW_BLOCKS,
    idChunk = CENSUS_ID_CHUNK,
    bucketBlocks = 100_000,
    log,
  } = options;

  const only =
    options.roots === undefined
      ? undefined
      : new Set(options.roots.map(b64ToHex));
  const { expected, inProgress } = indexedRoots(bundles, only);

  let to = options.to;
  if (to === undefined) {
    const [top] = await rows<{ top: number | string }>(
      clickhouse,
      MAX_HEIGHT_QUERY,
      {},
    );
    to = Number(top?.top ?? 0);
  }
  const from = options.from ?? 0;
  if (to < from) throw new Error(`--to ${to} is below --from ${from}`);

  // Stage 1: what ClickHouse holds under each root. With --roots, every listed
  // root goes to stage 2 instead, which counts the same thing by id.
  const held = new Map<string, number>();
  let candidates: string[];
  if (only === undefined) {
    for (let start = from; start <= to; start += windowBlocks) {
      const end = Math.min(start + windowBlocks - 1, to);
      for (const row of await rows<{
        root_hex: string;
        item_count: number | string;
      }>(clickhouse, ROOT_COUNTS_QUERY, { from: start, to: end })) {
        if (expected.has(row.root_hex)) {
          held.set(
            row.root_hex,
            (held.get(row.root_hex) ?? 0) + Number(row.item_count),
          );
        }
      }
      log?.info('Census stage 1', { from: start, to: end, roots: held.size });
    }
    candidates = [...expected.keys()].filter(
      (hex) => (held.get(hex) ?? 0) < (expected.get(hex) ?? 0),
    );
  } else {
    candidates = [...expected.keys()];
  }

  const result: CensusResult = {
    heightRange: [from, to],
    roots: {
      indexed: expected.size,
      checked: 0,
      notIndexed: 0,
      inProgress,
      outOfRange: 0,
      complete: 0,
      short: 0,
      byClass: {
        missing: 0,
        expired: 0,
        duplicate: 0,
        complete: 0,
        unlisted: 0,
      },
      withoutL1Row: 0,
    },
    items: { expected: 0, here: 0, elsewhere: 0, expired: 0, missing: 0 },
    missingByHeight: {},
    stalledBundles: stalledBundles(bundles, Math.floor(Date.now() / 1000)),
  };

  // Heights of the candidates, to apply the range and to report by height.
  const heights = new Map<string, number>();
  for (const part of chunks(candidates, idChunk)) {
    for (const row of await rows<{
      key_hex: string;
      root_height: number | string;
    }>(clickhouse, ROOT_HEIGHTS_QUERY, { ids: part })) {
      heights.set(row.key_hex, Number(row.root_height));
    }
  }

  const listItems = bundles.prepare(
    'SELECT DISTINCT id FROM bundle_data_items WHERE root_transaction_id = ?',
  );

  // Stage 2, a chunk of roots at a time: every listed item id, by id.
  const inRange = (hex: string) => {
    const height = heights.get(hex);
    if (height === undefined) {
      // No L1 row: kept only for an unbounded range, as it can't be placed.
      return options.from === undefined && options.to === undefined;
    }
    return height >= from && height <= to;
  };
  const shortRoots = candidates.filter(inRange);
  result.roots.outOfRange = candidates.length - shortRoots.length;
  if (only === undefined) {
    // Stage 1 read only the range, so a root it found complete has its items
    // in the range; one outside the range came up short and was dropped above.
    const short = new Set(candidates);
    for (const [hex, count] of expected) {
      if (short.has(hex)) continue;
      result.roots.complete++;
      result.items.expected += count;
      result.items.here += count;
    }
  }
  result.roots.checked = expected.size - result.roots.outOfRange;
  result.roots.notIndexed =
    only === undefined ? 0 : only.size - expected.size - inProgress;

  let rootBatch: string[] = [];
  const flush = async () => {
    const listed = new Map<string, string[]>();
    const allIds: string[] = [];
    for (const hex of rootBatch) {
      const ids = (
        listItems.all(Buffer.from(hex, 'hex')) as Array<{ id: Buffer }>
      ).map((row) => toHex(row.id));
      listed.set(hex, ids);
      // A loop, not push(...ids): a root with very many items would exceed
      // the engine's argument limit and throw a RangeError.
      for (const itemId of ids) allIds.push(itemId);
    }
    const unique = [...new Set(allIds)];
    const seen = new Map<string, number[]>();
    for (const part of chunks(unique, idChunk)) {
      for (const row of await rows<{
        key_hex: string;
        seen_heights: Array<number | string>;
      }>(clickhouse, ITEM_SEEN_QUERY, { ids: part })) {
        seen.set(row.key_hex, row.seen_heights.map(Number));
      }
    }
    const heldUnder = new Map<string, Set<string>>();
    const seenIds = [...seen.keys()];
    for (const part of chunks(seenIds, idChunk)) {
      const partHeights = [...new Set(part.flatMap((id) => seen.get(id)!))];
      for (const row of await rows<{
        key_hex: string;
        held_under: string[];
      }>(clickhouse, ITEM_ROOTS_QUERY, { ids: part, heights: partHeights })) {
        heldUnder.set(row.key_hex, new Set(row.held_under));
      }
    }

    for (const hex of rootBatch) {
      const ids = listed.get(hex)!;
      const counts: Record<ItemState, number> = {
        here: 0,
        elsewhere: 0,
        expired: 0,
        missing: 0,
      };
      for (const id of ids) {
        const under = heldUnder.get(id);
        if (under?.has(hex)) counts.here++;
        else if (under !== undefined && under.size > 0) counts.elsewhere++;
        else if (seen.has(id)) counts.expired++;
        else counts.missing++;
      }
      const cls: RootClass =
        ids.length === 0
          ? 'unlisted'
          : counts.missing > 0
            ? 'missing'
            : counts.expired > 0
              ? 'expired'
              : counts.elsewhere > 0
                ? 'duplicate'
                : 'complete';
      const height = heights.get(hex) ?? null;
      const short: ShortRoot = {
        root: hexToB64(hex),
        height,
        expected: expected.get(hex) ?? 0,
        heldUnderRoot: held.get(hex) ?? counts.here,
        listed: ids.length,
        ...counts,
        class: cls,
      };
      result.items.expected += short.expected;
      result.items.here += counts.here;
      result.items.elsewhere += counts.elsewhere;
      result.items.expired += counts.expired;
      result.items.missing += counts.missing;
      if (cls === 'complete') {
        result.roots.complete++;
      } else {
        result.roots.short++;
      }
      result.roots.byClass[cls]++;
      if (height === null) result.roots.withoutL1Row++;
      if (counts.missing > 0) {
        const bucket =
          height === null
            ? '-1'
            : String(Math.floor(height / bucketBlocks) * bucketBlocks);
        result.missingByHeight[bucket] =
          (result.missingByHeight[bucket] ?? 0) + counts.missing;
      }
      options.onShortRoot?.(short);
    }
    rootBatch = [];
  };

  let pendingIds = 0;
  for (const [index, hex] of shortRoots.entries()) {
    rootBatch.push(hex);
    pendingIds += expected.get(hex) ?? 0;
    if (pendingIds >= idChunk * 5) {
      await flush();
      pendingIds = 0;
      log?.info('Census stage 2', {
        roots: index + 1,
        of: shortRoots.length,
      });
    }
  }
  if (rootBatch.length > 0) await flush();
  return result;
}
