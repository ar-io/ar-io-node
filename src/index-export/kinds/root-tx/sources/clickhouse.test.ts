/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { createClient } from '@clickhouse/client';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import {
  CLICKHOUSE_EXPORT_SETTINGS,
  ClickHouseQuerier,
  ClickHouseRecordSource,
} from './clickhouse.js';
import { REPAIRED_TAG } from './rows.js';

const id = (seed: number) => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(seed, 0);
  buf[31] = 7;
  return buf;
};
const hex = (buf: Buffer) => buf.toString('hex').toUpperCase();

/** A `transactions` row, as the fake and the real table hold it. */
interface TableRow {
  id: Buffer;
  parentId: Buffer;
  rootTxId: Buffer;
  height: number;
  isDataItem?: boolean;
  offset?: number;
  dataOffset?: number;
  size?: number;
  dataSize?: number;
  rootParentOffset?: number;
  /** Position in the block. */
  index?: number;
  /** Seconds; later wins among versions. */
  insertedAt?: number;
}

const collect = async (records: AsyncIterable<BandRecord>) => {
  const out: BandRecord[] = [];
  for await (const record of records) out.push(record);
  return out;
};

/**
 * Stands in for ClickHouse: records every query, and answers the source's
 * two queries from rows in memory with the same semantics (the window, data
 * items only, the latest version per id by height, position and insert
 * time, each item joined to its parent's latest version in the window).
 */
class FakeClickHouse implements ClickHouseQuerier {
  readonly queries: Array<{
    query: string;
    params: Record<string, unknown>;
    settings: Record<string, unknown>;
    signal?: AbortSignal;
  }> = [];
  closed = false;
  /** Windows (`from-to`) that fail for lack of memory, once each. */
  readonly outOfMemory = new Set<string>();
  /** Ends every window's response with this text in place of a row. */
  cutShortWith?: string;
  /** Fails every query with this message. */
  failWith?: string;

  constructor(private readonly table: TableRow[]) {}

  private latest(from: number, to: number): Map<string, TableRow> {
    const latest = new Map<string, TableRow>();
    for (const row of this.table) {
      if (row.height < from || row.height > to) continue;
      if (row.isDataItem === false) continue;
      const key = hex(row.id);
      const seen = latest.get(key);
      const rank = (r: TableRow) => [r.height, r.index ?? 0, r.insertedAt ?? 0];
      const [a, b] = [rank(row), seen === undefined ? undefined : rank(seen)];
      if (
        b === undefined ||
        a[0] > b[0] ||
        (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))
      ) {
        latest.set(key, row);
      }
    }
    return latest;
  }

  async query(params: Parameters<ClickHouseQuerier['query']>[0]) {
    const queryParams = params.query_params ?? {};
    this.queries.push({
      query: params.query,
      params: queryParams,
      settings: params.clickhouse_settings ?? {},
      signal: params.abort_signal,
    });
    if (this.failWith !== undefined) throw new Error(this.failWith);
    let rows: Record<string, unknown>[];
    let tail: string | undefined;
    if (params.query.includes('max(height)')) {
      rows = [{ height: Math.max(0, ...this.table.map((r) => r.height)) }];
    } else {
      const from = queryParams.from as number;
      const to = queryParams.to as number;
      if (this.outOfMemory.delete(`${from}-${to}`)) {
        throw new Error(
          'Code: 241. DB::Exception: Memory limit (for query) exceeded. (MEMORY_LIMIT_EXCEEDED)',
        );
      }
      const latest = this.latest(from, to);
      rows = [...latest.values()].map((row) => {
        const p = latest.get(hex(row.parentId));
        const nested = !row.parentId.equals(row.rootTxId);
        return {
          id: hex(row.id),
          parent_id: hex(row.parentId),
          root_transaction_id: hex(row.rootTxId),
          height: row.height,
          item_offset: row.offset ?? 0,
          item_data_offset: row.dataOffset ?? 0,
          item_size: row.size ?? 0,
          root_parent_offset: row.rootParentOffset ?? 0,
          parent_parent_id: nested && p !== undefined ? hex(p.parentId) : '',
          parent_data_offset: nested ? (p?.dataOffset ?? 0) : 0,
          parent_data_size: nested ? (p?.dataSize ?? 0) : 0,
          parent_root_parent_offset: nested ? (p?.rootParentOffset ?? 0) : 0,
        };
      });
      tail = this.cutShortWith;
    }
    return {
      async *stream() {
        // Two rows per batch, as a stream delivers them in chunks.
        for (let at = 0; at < rows.length; at += 2) {
          yield rows.slice(at, at + 2).map((row) => ({
            text: JSON.stringify(row),
            json: <T>() => row as T,
          }));
        }
        if (tail !== undefined) {
          yield [
            {
              text: tail,
              json: <T>(): T => JSON.parse(tail as string) as T,
            },
          ];
        }
      },
    };
  }

  async close() {
    this.closed = true;
  }
}

const ROOT = id(100);
const PARENT = id(200);

/** A table exercising every rule; shared by the fake and the real tests. */
const fixture = (): TableRow[] => [
  // A top-level item, in two unmerged versions: the later insert wins.
  {
    id: id(1),
    parentId: ROOT,
    rootTxId: ROOT,
    height: 1500,
    offset: 64,
    dataOffset: 164,
    size: 1000,
    insertedAt: 1,
  },
  {
    id: id(1),
    parentId: ROOT,
    rootTxId: ROOT,
    height: 1500,
    offset: 64,
    dataOffset: 200,
    size: 1000,
    insertedAt: 2,
  },
  // Re-bundled: the later height wins, whatever was inserted last.
  {
    id: id(2),
    parentId: id(101),
    rootTxId: id(101),
    height: 1400,
    offset: 64,
    dataOffset: 164,
    size: 500,
    insertedAt: 9,
  },
  {
    id: id(2),
    parentId: id(102),
    rootTxId: id(102),
    height: 1600,
    offset: 64,
    dataOffset: 164,
    size: 500,
    insertedAt: 1,
  },
  // A parent bundle and a nested item with relative offsets and a zeroed
  // root_parent_offset.
  {
    id: PARENT,
    parentId: ROOT,
    rootTxId: ROOT,
    height: 1500,
    offset: 2000,
    dataOffset: 3000,
    size: 60000,
    dataSize: 50000,
  },
  {
    id: id(3),
    parentId: PARENT,
    rootTxId: ROOT,
    height: 1500,
    offset: 200,
    dataOffset: 300,
    size: 400,
  },
  // No offsets (stored as 0): root only.
  { id: id(4), parentId: ROOT, rootTxId: ROOT, height: 1500, size: 10 },
  // An L1 transaction: never exported.
  {
    id: id(5),
    parentId: Buffer.alloc(0),
    rootTxId: Buffer.alloc(0),
    height: 1500,
    isDataItem: false,
  },
  // Outside the window.
  { id: id(6), parentId: ROOT, rootTxId: ROOT, height: 999, size: 10 },
  // Two roots at one height: the later position in the block wins, however
  // the inserts went.
  {
    id: id(7),
    parentId: id(103),
    rootTxId: id(103),
    height: 1700,
    index: 5,
    offset: 64,
    dataOffset: 164,
    size: 300,
    insertedAt: 1,
  },
  {
    id: id(7),
    parentId: id(104),
    rootTxId: id(104),
    height: 1700,
    index: 2,
    offset: 64,
    dataOffset: 164,
    size: 300,
    insertedAt: 9,
  },
  // A size ClickHouse doesn't know (stored as 0): kept, without it.
  {
    id: id(8),
    parentId: ROOT,
    rootTxId: ROOT,
    height: 1500,
    offset: 128,
    dataOffset: 228,
  },
];

/** What the fixture should export for heights 1000–1999. */
const checkExport = (records: BandRecord[]) => {
  const byId = new Map(records.map((r) => [hex(r.id), r]));
  assert.deepEqual(
    [...byId.keys()].sort(),
    [id(1), id(2), PARENT, id(3), id(4), id(7), id(8)].map(hex).sort(),
  );
  assert.ok(byId.get(hex(id(7)))?.rootTxId.equals(id(103)));
  assert.equal(byId.get(hex(id(8)))?.rootOffset, 128);
  assert.equal(byId.get(hex(id(8)))?.size, undefined);
  assert.equal(byId.get(hex(id(1)))?.rootDataOffset, 200);
  assert.ok(byId.get(hex(id(2)))?.rootTxId.equals(id(102)));
  assert.equal(byId.get(hex(id(2)))?.height, 1600);
  assert.equal(byId.get(hex(id(3)))?.rootOffset, 3200);
  assert.equal(byId.get(hex(id(3)))?.rootDataOffset, 3300);
  assert.equal(byId.get(hex(id(3)))?.sampleTag, REPAIRED_TAG);
  assert.equal(byId.get(hex(id(4)))?.rootOffset, undefined);
  for (const record of records) assert.equal(record.rank, undefined);
};

describe('ClickHouseRecordSource', () => {
  it('exports a window collapsed per id, with the repair, from a fake', async () => {
    const fake = new FakeClickHouse(fixture());
    const source = new ClickHouseRecordSource('gw1', fake, 400);
    const records = await collect(source.records(1000, 1999));
    checkExport(records);
    assert.equal(source.stats.repaired, 1);
    assert.equal(source.stats.rootOnly, 1);
    for (const record of records) assert.equal(record.source, 'gw1');
  });

  it('queries in windows covering exactly the range asked for', async () => {
    const fake = new FakeClickHouse([]);
    const source = new ClickHouseRecordSource('gw1', fake, 400);
    await collect(source.records(1000, 1999));
    assert.deepEqual(
      fake.queries.map((q) => [q.params.from, q.params.to]),
      [
        [1000, 1399],
        [1400, 1799],
        [1800, 1999],
      ],
    );
  });

  it('sends the collapse, the join, the bounds and the limits with every query', async () => {
    const fake = new FakeClickHouse(fixture());
    const source = new ClickHouseRecordSource('gw1', fake, 1000);
    await collect(source.records(1000, 1999));
    await source.stableHeight();
    assert.equal(fake.queries.length, 2, 'one per window, and the max');
    const [items] = fake.queries;
    assert.match(
      items.query,
      /argMax\(\s*\(parent_id, root_transaction_id, height/,
    );
    assert.match(
      items.query,
      /\(height, block_transaction_index, inserted_at\)/,
    );
    assert.match(items.query, /GROUP BY id/);
    assert.match(items.query, /ANY LEFT JOIN/);
    assert.match(
      items.query,
      /height >= \{from:UInt32\} AND height <= \{to:UInt32\}/,
    );
    assert.match(items.query, /AND is_data_item/);
    assert.deepEqual(items.params, { from: 1000, to: 1999 });
    for (const query of fake.queries) {
      assert.deepEqual(query.settings, { ...CLICKHOUSE_EXPORT_SETTINGS });
      assert.ok(query.signal !== undefined, 'every query has a deadline');
      assert.doesNotMatch(query.query, /\b(INSERT|ALTER|DROP|DELETE)\b/i);
    }
  });

  it('splits a window that runs out of memory, and gives the same records', async () => {
    const fake = new FakeClickHouse(fixture());
    fake.outOfMemory.add('1000-1999');
    fake.outOfMemory.add('1500-1999');
    const source = new ClickHouseRecordSource('gw1', fake, 1000);
    checkExport(await collect(source.records(1000, 1999)));
    assert.deepEqual(
      fake.queries.map((q) => [q.params.from, q.params.to]),
      [
        [1000, 1999],
        [1000, 1499],
        [1500, 1999],
        [1500, 1749],
        [1750, 1999],
      ],
    );
  });

  it('fails naming the source and window when a response is cut short', async () => {
    const fake = new FakeClickHouse(fixture());
    fake.cutShortWith = 'Code: 159. DB::Exception: Timeout exceeded';
    const source = new ClickHouseRecordSource('gw1', fake, 1000);
    await assert.rejects(
      collect(source.records(1000, 1999)),
      /ClickHouse source gw1, heights 1000-1999: .*isn't a row: Code: 159/,
    );
  });

  it('says what to change when the user is read-only', async () => {
    const fake = new FakeClickHouse([]);
    fake.failWith =
      "Code: 164. DB::Exception: Cannot modify 'max_threads' setting in readonly mode. (READONLY)";
    const source = new ClickHouseRecordSource('gw2', fake);
    await assert.rejects(
      source.stableHeight(),
      /ClickHouse source gw2, stable height: .*readonly=0 or 2, not 1/,
    );
  });

  it('reports one below the highest height, or -1 with none', async () => {
    assert.equal(
      await new ClickHouseRecordSource(
        'gw1',
        new FakeClickHouse(fixture()),
      ).stableHeight(),
      1699,
    );
    assert.equal(
      await new ClickHouseRecordSource(
        'gw1',
        new FakeClickHouse([]),
      ).stableHeight(),
      -1,
    );
  });

  it('closes its client', async () => {
    const fake = new FakeClickHouse([]);
    await new ClickHouseRecordSource('gw1', fake).close();
    assert.equal(fake.closed, true);
  });
});

/**
 * Against a real ClickHouse, when INDEX_EXPORT_TEST_CLICKHOUSE_URL names a
 * disposable one (it creates and drops a database): checks the SQL itself,
 * which the fake can only imitate.
 */
const realUrl = process.env.INDEX_EXPORT_TEST_CLICKHOUSE_URL;

describe(
  'ClickHouseRecordSource against ClickHouse',
  {
    skip:
      realUrl === undefined
        ? 'INDEX_EXPORT_TEST_CLICKHOUSE_URL is not set'
        : false,
  },
  () => {
    const database = `index_export_test_${process.pid}`;
    const admin = () =>
      createClient({
        url: realUrl,
        username: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_USER ?? 'default',
        password: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_PASSWORD ?? '',
      });

    before(async () => {
      const client = admin();
      await client.command({ query: `CREATE DATABASE ${database}` });
      const schema = fs
        .readFileSync('src/database/clickhouse/schema.sql', 'utf8')
        .split(';')
        .find((statement) =>
          statement.includes('CREATE TABLE IF NOT EXISTS transactions'),
        );
      assert.ok(schema !== undefined);
      await client.command({
        query: schema.replace(
          'CREATE TABLE IF NOT EXISTS transactions',
          `CREATE TABLE ${database}.transactions`,
        ),
      });
      const values = fixture().map((row) => {
        const h = (buf: Buffer) => `unhex('${buf.toString('hex')}')`;
        return `(${row.height}, ${row.index ?? 0}, ${row.isDataItem === false ? 0 : 1}, ${h(row.id)}, '', 0, 0, ${row.dataSize ?? 0}, '', 0, ${h(row.parentId)}, ${h(row.rootTxId)}, ${row.offset ?? 0}, ${row.size ?? 0}, ${row.dataOffset ?? 0}, ${row.rootParentOffset ?? 0}, toDateTime(${row.insertedAt ?? 0}))`;
      });
      await client.command({
        query: `INSERT INTO ${database}.transactions
          (height, block_transaction_index, is_data_item, id, anchor, quantity,
           reward, data_size, content_type, format, parent_id,
           root_transaction_id, "offset", "size", data_offset,
           root_parent_offset, inserted_at)
          VALUES ${values.join(', ')}`,
      });
      await client.close();
    });

    after(async () => {
      const client = admin();
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      await client.close();
    });

    it('exports the same records as the fake, without merging the table first', async () => {
      // As createClickHouseQuerier builds it, in the test database.
      const querier = createClient({
        url: realUrl,
        username: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_USER ?? 'default',
        password: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_PASSWORD ?? '',
        database,
        keep_alive: { enabled: true },
      }) as unknown as ClickHouseQuerier;
      const source = new ClickHouseRecordSource('gw1', querier, 400);
      try {
        checkExport(await collect(source.records(1000, 1999)));
        assert.equal(await source.stableHeight(), 1699);
      } finally {
        await source.close();
      }
    });
  },
);
