/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createClient } from '@clickhouse/client';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import {
  ItemRow,
  newSourceStats,
  RecordSource,
  SourceStats,
  toBandRecord,
} from './rows.js';

/** Heights per query, so a dense range never becomes one huge GROUP BY. */
export const CLICKHOUSE_WINDOW_BLOCKS = 1000;

/** Seconds a query may run on the server. */
const MAX_EXECUTION_SECONDS = 600;

/**
 * Bounds on every query, so an export can't starve the gateway's own
 * ClickHouse use:
 *
 * - `readonly=2` refuses writes but, unlike 1, lets the query set the other
 *   limits. A user whose profile is `readonly=1` can't run these queries.
 * - a GROUP BY past 2 GB spills to disk rather than failing at 4 GB;
 * - a query is cancelled when the client disconnects (a stopped service).
 */
export const CLICKHOUSE_EXPORT_SETTINGS = {
  readonly: '2',
  max_threads: 2,
  max_memory_usage: '4000000000',
  max_bytes_before_external_group_by: '2000000000',
  max_execution_time: MAX_EXECUTION_SECONDS,
  priority: 10,
  cancel_http_readonly_queries_on_client_close: 1,
  output_format_json_quote_64bit_integers: 0,
} as const;

/** The part of `@clickhouse/client` this source uses, so tests can stand in. */
export interface ClickHouseQuerier {
  query(params: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, unknown>;
    abort_signal?: AbortSignal;
  }): Promise<{
    stream(): AsyncIterable<Array<{ text: string; json<T>(): T }>>;
  }>;
  close(): Promise<void>;
}

interface ExportRow {
  id: string;
  parent_id: string;
  root_transaction_id: string;
  height: number | string;
  item_offset: number | string;
  item_data_offset: number | string;
  item_size: number | string;
  root_parent_offset: number | string;
  parent_parent_id: string;
  parent_data_offset: number | string;
  parent_data_size: number | string;
  parent_root_parent_offset: number | string;
}

/**
 * One window's items, each with its parent: the latest version per id
 * (highest height, then position, then insert), and for items inside a
 * nested bundle, that bundle's row from the same window (it is in the same
 * root, so at the same height).
 */
export const CLICKHOUSE_WINDOW_QUERY = `
  SELECT
    hex(i.id) AS id,
    hex(i.parent_id) AS parent_id,
    hex(i.root_transaction_id) AS root_transaction_id,
    i.height AS height,
    i.item_offset AS item_offset,
    i.item_data_offset AS item_data_offset,
    i.item_size AS item_size,
    i.root_parent_offset AS root_parent_offset,
    hex(p.parent_id) AS parent_parent_id,
    p.data_offset AS parent_data_offset,
    p.data_size AS parent_data_size,
    p.root_parent_offset AS parent_root_parent_offset
  FROM (
    SELECT
      id,
      latest.1 AS parent_id,
      latest.2 AS root_transaction_id,
      latest.3 AS height,
      latest.4 AS item_offset,
      latest.5 AS item_data_offset,
      latest.6 AS item_size,
      latest.7 AS root_parent_offset
    FROM (
      SELECT
        id,
        argMax(
          (parent_id, root_transaction_id, height, "offset", data_offset,
           "size", root_parent_offset),
          (height, block_transaction_index, inserted_at)
        ) AS latest
      FROM transactions
      WHERE height >= {from:UInt32} AND height <= {to:UInt32}
        AND is_data_item
      GROUP BY id
    )
  ) AS i
  ANY LEFT JOIN (
    SELECT
      id,
      latest.1 AS parent_id,
      latest.2 AS data_offset,
      latest.3 AS data_size,
      latest.4 AS root_parent_offset
    FROM (
      SELECT
        id,
        argMax(
          (parent_id, data_offset, data_size, root_parent_offset),
          (height, block_transaction_index, inserted_at)
        ) AS latest
      FROM transactions
      WHERE height >= {from:UInt32} AND height <= {to:UInt32}
        AND is_data_item
        AND id IN (
          SELECT parent_id FROM transactions
          WHERE height >= {from:UInt32} AND height <= {to:UInt32}
            AND is_data_item AND parent_id != root_transaction_id
        )
      GROUP BY id
    )
  ) AS p ON p.id = i.parent_id`;

const hexId = (value: string): Buffer | undefined =>
  value.length > 0 ? Buffer.from(value, 'hex') : undefined;

/**
 * ClickHouse stores a missing number as 0, and none of these is 0 when
 * known: an item's offsets start past its bundle's header, sizes are
 * positive. (`root_parent_offset` is the exception, read as is.)
 */
const known = (value: number | string): number | undefined => {
  const number = Number(value);
  return number === 0 ? undefined : number;
};

const MEMORY_LIMIT_EXCEEDED = /\bCode: 241\b|MEMORY_LIMIT_EXCEEDED/;
const READONLY_PROFILE = /readonly mode|Cannot modify '\w+' setting/;

/**
 * Exports data items from a ClickHouse `transactions` table: this gateway's
 * own, or a peer indexer's.
 *
 * The table is a `ReplacingMergeTree(inserted_at)`, so unmerged versions of a
 * row coexist, and an item re-bundled at a later height has a row at each.
 * Each window collapses per id to the latest row (by height, then position in
 * the block, then insert time), so it gives one record per id, the later
 * root, as the band merge would choose. An item re-bundled into another
 * window comes again from that window.
 *
 * A window that runs out of memory is retried as two halves, down to a
 * single block.
 */
export class ClickHouseRecordSource implements RecordSource {
  readonly rank = 0;
  readonly stats: SourceStats = newSourceStats();

  constructor(
    readonly name: string,
    private readonly client: ClickHouseQuerier,
    private readonly windowBlocks = CLICKHOUSE_WINDOW_BLOCKS,
  ) {}

  /**
   * One below the highest height in the table, or -1 when it is empty: the
   * top height may still be part way through an import.
   */
  async stableHeight(): Promise<number> {
    const rows = await this.rows<{ height: number | string }>(
      'SELECT max(height) AS height FROM transactions',
      'stable height',
    );
    const height = Number(rows[0]?.height ?? 0);
    return height > 0 ? height - 1 : -1;
  }

  async *records(from: number, to: number): AsyncIterable<BandRecord> {
    const pending: Array<[number, number]> = [];
    for (let start = from; start <= to; start += this.windowBlocks) {
      pending.push([start, Math.min(to, start + this.windowBlocks - 1)]);
    }
    while (pending.length > 0) {
      const [start, end] = pending.shift() as [number, number];
      let given = 0;
      try {
        for await (const record of this.window(start, end)) {
          given += 1;
          yield record;
        }
      } catch (error) {
        const message = (error as Error).message;
        // Out of memory before any row: split the window and go on.
        if (given === 0 && start < end && MEMORY_LIMIT_EXCEEDED.test(message)) {
          const middle = Math.floor((start + end) / 2);
          pending.unshift([start, middle], [middle + 1, end]);
          continue;
        }
        throw this.failure(`heights ${start}-${end}`, error);
      }
    }
  }

  private async *window(from: number, to: number): AsyncGenerator<BandRecord> {
    const result = await this.client.query({
      query: CLICKHOUSE_WINDOW_QUERY,
      format: 'JSONEachRow',
      query_params: { from, to },
      clickhouse_settings: { ...CLICKHOUSE_EXPORT_SETTINGS },
      abort_signal: deadline(),
    });
    for await (const batch of result.stream()) {
      for (const line of batch) {
        const raw = parseLine<ExportRow>(line);
        const parentParentId = hexId(raw.parent_parent_id);
        const row: ItemRow = {
          id: Buffer.from(raw.id, 'hex'),
          parentId: hexId(raw.parent_id),
          rootTxId: hexId(raw.root_transaction_id),
          height: Number(raw.height),
          isDataItem: true,
          offset: known(raw.item_offset),
          dataOffset: known(raw.item_data_offset),
          size: known(raw.item_size),
          rootParentOffset: Number(raw.root_parent_offset),
          // A parent missing from the join comes back empty.
          parent:
            parentParentId === undefined
              ? undefined
              : {
                  parentId: parentParentId,
                  dataOffset: known(raw.parent_data_offset),
                  dataSize: known(raw.parent_data_size),
                  rootParentOffset: Number(raw.parent_root_parent_offset),
                },
        };
        // Without a payload offset the item can't be placed.
        if (row.dataOffset === undefined) row.offset = undefined;
        const record = toBandRecord(row, this.name, this.stats);
        if (record !== undefined) yield record;
      }
    }
  }

  private async rows<T>(query: string, what: string): Promise<T[]> {
    try {
      const result = await this.client.query({
        query,
        format: 'JSONEachRow',
        clickhouse_settings: { ...CLICKHOUSE_EXPORT_SETTINGS },
        abort_signal: deadline(),
      });
      const rows: T[] = [];
      for await (const batch of result.stream()) {
        for (const line of batch) rows.push(parseLine<T>(line));
      }
      return rows;
    } catch (error) {
      throw this.failure(what, error);
    }
  }

  /** An error naming this source and what it was reading, with a hint where one helps. */
  private failure(what: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const hint = READONLY_PROFILE.test(message)
      ? ' (the ClickHouse user must be allowed to change settings: readonly=0 or 2, not 1)'
      : '';
    return new Error(
      `ClickHouse source ${this.name}, ${what}: ${message}${hint}`,
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

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

/** A client for a ClickHouse source, over HTTP keep-alive. */
export function createClickHouseQuerier({
  url,
  username,
  password,
}: {
  url: string;
  username: string;
  password: string;
}): ClickHouseQuerier {
  return createClient({
    url,
    username,
    password,
    keep_alive: { enabled: true },
    request_timeout: (MAX_EXECUTION_SECONDS + 30) * 1000,
  }) as unknown as ClickHouseQuerier;
}
