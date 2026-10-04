/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { setImmediate } from 'node:timers/promises';
import Sqlite from 'better-sqlite3';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import {
  isNested,
  ItemRow,
  newSourceStats,
  ParentRow,
  RecordSource,
  SourceStats,
  toBandRecord,
} from './rows.js';

/** Rows read per statement: small, so no statement holds back a WAL checkpoint for long. */
export const SQLITE_BATCH_ROWS = 5000;

/** Parent ids per lookup, under SQLite's bound-variable limit. */
const PARENT_CHUNK = 500;

interface DataItemRow {
  id: Buffer;
  parent_id: Buffer;
  root_transaction_id: Buffer;
  height: number;
  block_transaction_index: number;
  offset: number | null;
  data_offset: number | null;
  size: number | null;
  root_parent_offset: number | null;
}

interface ParentDbRow {
  id: Buffer;
  parent_id: Buffer;
  data_offset: number | null;
  data_size: number | null;
  root_parent_offset: number | null;
}

const nullable = (value: number | null) => (value === null ? undefined : value);

/**
 * Exports a gateway's own data items from `bundles.db` `stable_data_items`,
 * opened read-only (from a `:ro` mount in compose). For gateways without
 * ClickHouse; on a ClickHouse gateway, SQLite holds only what import hasn't
 * taken yet, and the two are never combined.
 *
 * Rows are read in `(height, block_transaction_index, id)` order along the
 * table's index, a batch per statement, continuing after the last row read,
 * so a height with many items is never one long statement. A batch's nested
 * rows get their parents in a few primary-key lookups, and the event loop
 * runs between statements.
 */
export class SqliteRecordSource implements RecordSource {
  readonly rank = 0;
  readonly stats: SourceStats = newSourceStats();
  private readonly db: Sqlite.Database;
  private readonly batch: Sqlite.Statement;
  private readonly maxHeight: Sqlite.Statement;
  private readonly parentLookups = new Map<number, Sqlite.Statement>();

  constructor(
    readonly name: string,
    private readonly dbPath: string,
    private readonly batchRows = SQLITE_BATCH_ROWS,
  ) {
    try {
      this.db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
      this.batch = this.db.prepare(`
        SELECT id, parent_id, root_transaction_id, height,
          block_transaction_index, offset, data_offset, size,
          root_parent_offset
        FROM stable_data_items
        WHERE (height, block_transaction_index, id) > (?, ?, ?)
          AND height <= ?
        ORDER BY height, block_transaction_index, id
        LIMIT ?
      `);
      this.maxHeight = this.db.prepare(
        'SELECT MAX(height) AS height FROM stable_data_items',
      );
    } catch (error) {
      throw this.failure('opening', error);
    }
  }

  /** The highest stable height, or -1 when the table is empty. */
  async stableHeight(): Promise<number> {
    try {
      const row = this.maxHeight.get() as { height: number | null } | undefined;
      return row?.height ?? -1;
    } catch (error) {
      throw this.failure('reading its stable height', error);
    }
  }

  async *records(from: number, to: number): AsyncIterable<BandRecord> {
    // Just before the first row at `from`: every block_transaction_index
    // is at least 0.
    let after: [number, number, Buffer] = [from, -1, Buffer.alloc(0)];
    for (;;) {
      let raws: DataItemRow[];
      let parents: Map<string, ParentRow>;
      try {
        raws = this.batch.all(
          after[0],
          after[1],
          after[2],
          to,
          this.batchRows,
        ) as DataItemRow[];
        const rows = raws.map(toItemRow);
        parents = await this.parents(rows.filter(isNested));
        for (const row of rows) {
          if (isNested(row) && row.parentId !== undefined) {
            row.parent = parents.get(row.parentId.toString('hex'));
          }
          const record = toBandRecord(row, this.name, this.stats);
          if (record !== undefined) yield record;
        }
      } catch (error) {
        throw this.failure(`heights ${after[0]}-${to}`, error);
      }
      if (raws.length < this.batchRows) return;
      const last = raws[raws.length - 1];
      after = [last.height, last.block_transaction_index, last.id];
      await setImmediate();
    }
  }

  private async parents(rows: ItemRow[]): Promise<Map<string, ParentRow>> {
    const ids = [
      ...new Map(
        rows.flatMap((row) =>
          row.parentId !== undefined
            ? [[row.parentId.toString('hex'), row.parentId] as const]
            : [],
        ),
      ).values(),
    ];
    const found = new Map<string, ParentRow>();
    for (let at = 0; at < ids.length; at += PARENT_CHUNK) {
      const chunk = ids.slice(at, at + PARENT_CHUNK);
      let lookup = this.parentLookups.get(chunk.length);
      if (lookup === undefined) {
        lookup = this.db.prepare(
          `SELECT id, parent_id, data_offset, data_size, root_parent_offset
           FROM stable_data_items
           WHERE id IN (${chunk.map(() => '?').join(',')})`,
        );
        this.parentLookups.set(chunk.length, lookup);
      }
      for (const parent of lookup.all(...chunk) as ParentDbRow[]) {
        found.set(parent.id.toString('hex'), {
          parentId: parent.parent_id,
          dataOffset: nullable(parent.data_offset),
          dataSize: nullable(parent.data_size),
          rootParentOffset: nullable(parent.root_parent_offset),
        });
      }
      await setImmediate();
    }
    return found;
  }

  /** An error naming this source and its database, with a hint where one helps. */
  private failure(what: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /readonly|unable to open/i.test(message)
      ? ' (opened read-only: the -wal and -shm files must exist, so the gateway must be running, and be readable by this user)'
      : '';
    return new Error(
      `SQLite source ${this.name} (${this.dbPath}), ${what}: ${message}${hint}`,
    );
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}

function toItemRow(raw: DataItemRow): ItemRow {
  return {
    id: raw.id,
    parentId: raw.parent_id,
    rootTxId: raw.root_transaction_id,
    height: raw.height,
    isDataItem: true,
    offset: nullable(raw.offset),
    dataOffset: nullable(raw.data_offset),
    size: nullable(raw.size),
    rootParentOffset: nullable(raw.root_parent_offset),
  };
}
