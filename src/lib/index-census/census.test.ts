/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createClient } from '@clickhouse/client';
import Sqlite from 'better-sqlite3';

import type { ClickHouseQuerier } from '../../index-export/kinds/root-tx/sources/clickhouse.js';
import {
  CENSUS_ID_CHUNK,
  ITEM_ROOTS_QUERY,
  ITEM_SEEN_QUERY,
  MAX_HEIGHT_QUERY,
  ROOT_COUNTS_QUERY,
  ROOT_HEIGHTS_QUERY,
  runCensus,
  ShortRoot,
} from './census.js';

const id = (seed: number) => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(seed, 0);
  buf[31] = 9;
  return buf;
};
const hex = (buf: Buffer) => buf.toString('hex').toUpperCase();
const b64 = (buf: Buffer) => buf.toString('base64url');

/** A `transactions` row (and, unless expired, its `transaction_ids` row). */
interface Row {
  id: Buffer;
  root: Buffer;
  height: number;
  isDataItem: boolean;
}

/**
 * The census fixture. Root ids are seeds 1-9, items 100+.
 *
 * - root 1 (h 1000): 2 items, both held: complete.
 * - root 2 (h 1000): 3 items, none imported: missing.
 * - root 3 (h 1001): 2 items, held under root 1 too... no: item 300 held
 *   under root 4 only (a duplicate), item 301 here.
 * - root 4 (h 1002): holds item 300 and its own item 400.
 * - root 5 (h 1003): 1 item that expired (transaction_ids only).
 * - root 6: never mined (no L1 row), 1 item held under root 4: duplicate.
 * - root 7 (h 5000): 1 item missing, outside a 0-2000 range.
 * - root 8 (h 1004): a bundle still being unbundled: in progress.
 * - root 9 (h 1005): a top-level bundle (2 items) holding a nested bundle
 *   (item 900, itself a bundle of 1 item, 902): 3 matched, all held.
 */
function fixture() {
  const rows: Row[] = [];
  const expiredIds: Array<{ id: Buffer; height: number }> = [];
  const l1 = (seed: number, height: number) =>
    rows.push({ id: id(seed), root: id(seed), height, isDataItem: false });
  const item = (seed: number, root: number, height: number) =>
    rows.push({ id: id(seed), root: id(root), height, isDataItem: true });
  l1(1, 1000);
  item(100, 1, 1000);
  item(101, 1, 1000);
  l1(2, 1000);
  l1(3, 1001);
  item(301, 3, 1001);
  l1(4, 1002);
  item(300, 4, 1002);
  item(400, 4, 1002);
  item(600, 4, 1002);
  l1(5, 1003);
  expiredIds.push({ id: id(500), height: 1003 });
  l1(7, 5000);
  l1(8, 1004);
  l1(9, 1005);
  item(900, 9, 1005);
  item(901, 9, 1005);
  item(902, 9, 1005);

  const db = new Sqlite(':memory:');
  db.exec(`
    CREATE TABLE bundles (
      id BLOB PRIMARY KEY, format_id INTEGER NOT NULL DEFAULT 0,
      unbundle_filter_id INTEGER, index_filter_id INTEGER,
      data_item_count INTEGER, matched_data_item_count INTEGER,
      first_queued_at INTEGER, last_queued_at INTEGER,
      last_unbundled_at INTEGER, last_fully_indexed_at INTEGER,
      root_transaction_id BLOB);
    CREATE TABLE bundle_data_items (
      id BLOB NOT NULL, parent_id BLOB NOT NULL, parent_index INTEGER NOT NULL,
      filter_id INTEGER NOT NULL, root_transaction_id BLOB NOT NULL,
      first_indexed_at INTEGER NOT NULL, last_indexed_at INTEGER NOT NULL,
      PRIMARY KEY (id, parent_id, parent_index, filter_id));
  `);
  const bundle = db.prepare(
    `INSERT INTO bundles (id, root_transaction_id, index_filter_id,
       matched_data_item_count, last_queued_at, last_unbundled_at,
       last_fully_indexed_at) VALUES (?, ?, 1, ?, ?, ?, ?)`,
  );
  const listItem = db.prepare(
    `INSERT INTO bundle_data_items VALUES (?, ?, 0, ?, ?, 1, 1)`,
  );
  const indexed = (seed: number, matched: number, items: number[]) => {
    bundle.run(id(seed), id(seed), matched, 1, 1, 1);
    // Listed twice under two filters: the census counts distinct ids.
    for (const seedItem of items) {
      listItem.run(id(seedItem), id(seed), 1, id(seed));
      listItem.run(id(seedItem), id(seed), 2, id(seed));
    }
  };
  indexed(1, 2, [100, 101]);
  indexed(2, 3, [200, 201, 202]);
  indexed(3, 2, [300, 301]);
  indexed(4, 3, [300, 400, 600]);
  indexed(5, 1, [500]);
  indexed(6, 1, [600]);
  indexed(7, 1, [700]);
  // Root 8: one bundle done, its nested bundle still pending.
  bundle.run(id(8), id(8), 1, 1, 1, 1);
  bundle.run(id(80), id(8), 1, 1, 1, null);
  // Root 9 and its nested bundle 900: matched counts sum to 3.
  bundle.run(id(9), id(9), 2, 1, 1, 1);
  bundle.run(id(900), id(9), 1, 1, 1, 1);
  listItem.run(id(900), id(9), 1, id(9));
  listItem.run(id(901), id(9), 1, id(9));
  listItem.run(id(902), id(900), 1, id(9));
  // A stalled bundle: queued two days ago, never unbundled.
  db.prepare(
    `INSERT INTO bundles (id, root_transaction_id, index_filter_id,
       last_queued_at) VALUES (?, ?, 1, ?)`,
  ).run(id(50), id(50), Math.floor(Date.now() / 1000) - 2 * 86_400);
  return { db, rows, expiredIds };
}

/** Answers the census's five queries from rows in memory. */
class FakeClickHouse implements ClickHouseQuerier {
  readonly queries: string[] = [];
  closed = false;

  constructor(
    private readonly rows: Row[],
    private readonly expiredIds: Array<{ id: Buffer; height: number }>,
  ) {}

  async query(params: {
    query: string;
    query_params?: Record<string, unknown>;
  }) {
    this.queries.push(params.query);
    const p = params.query_params ?? {};
    const ids = new Set((p.ids as string[] | undefined) ?? []);
    let out: object[];
    switch (params.query) {
      case MAX_HEIGHT_QUERY:
        out = [{ top: Math.max(...this.rows.map((r) => r.height)) }];
        break;
      case ROOT_COUNTS_QUERY: {
        const counts = new Map<string, Set<string>>();
        for (const r of this.rows) {
          if (!r.isDataItem) continue;
          if (r.height < (p.from as number) || r.height > (p.to as number)) {
            continue;
          }
          const set = counts.get(hex(r.root)) ?? new Set();
          set.add(hex(r.id));
          counts.set(hex(r.root), set);
        }
        out = [...counts].map(([root, set]) => ({
          root_hex: root,
          item_count: set.size,
        }));
        break;
      }
      case ROOT_HEIGHTS_QUERY:
        out = this.rows
          .filter((r) => !r.isDataItem && ids.has(hex(r.id)))
          .map((r) => ({ key_hex: hex(r.id), root_height: r.height }));
        break;
      case ITEM_SEEN_QUERY: {
        const seen = new Map<string, Set<number>>();
        const all = [
          ...this.rows.filter((r) => r.isDataItem),
          ...this.expiredIds,
        ];
        for (const r of all) {
          if (!ids.has(hex(r.id))) continue;
          const set = seen.get(hex(r.id)) ?? new Set();
          set.add(r.height);
          seen.set(hex(r.id), set);
        }
        out = [...seen].map(([key, set]) => ({
          key_hex: key,
          seen_heights: [...set],
        }));
        break;
      }
      case ITEM_ROOTS_QUERY: {
        const heights = new Set(p.heights as number[]);
        const under = new Map<string, Set<string>>();
        for (const r of this.rows) {
          if (!r.isDataItem || !ids.has(hex(r.id)) || !heights.has(r.height)) {
            continue;
          }
          const set = under.get(hex(r.id)) ?? new Set();
          set.add(hex(r.root));
          under.set(hex(r.id), set);
        }
        out = [...under].map(([key, set]) => ({
          key_hex: key,
          held_under: [...set],
        }));
        break;
      }
      default:
        throw new Error(`unexpected query: ${params.query}`);
    }
    return {
      async *stream() {
        yield out.map((row) => ({
          text: JSON.stringify(row),
          json: <T>() => row as T,
        }));
      },
    };
  }

  async close() {
    this.closed = true;
  }
}

const byRoot = (shorts: ShortRoot[]) => new Map(shorts.map((s) => [s.root, s]));

/** The checks every client must pass, fake or real. */
async function checkCensus(
  clickhouse: ClickHouseQuerier,
  bundles: Sqlite.Database,
) {
  const shorts: ShortRoot[] = [];
  const result = await runCensus({
    bundles,
    clickhouse,
    windowBlocks: 400,
    idChunk: 2,
    onShortRoot: (s) => shorts.push(s),
  });
  const roots = byRoot(shorts);

  assert.equal(roots.get(b64(id(1))), undefined, 'complete root not short');
  assert.deepEqual(
    { ...roots.get(b64(id(2))), root: undefined },
    {
      root: undefined,
      height: 1000,
      expected: 3,
      heldUnderRoot: 0,
      listed: 3,
      here: 0,
      elsewhere: 0,
      expired: 0,
      missing: 3,
      class: 'missing',
    },
  );
  const dup = roots.get(b64(id(3)))!;
  assert.equal(dup.class, 'duplicate');
  assert.equal(dup.here, 1);
  assert.equal(dup.elsewhere, 1);
  assert.equal(roots.get(b64(id(5)))!.class, 'expired');
  const unmined = roots.get(b64(id(6)))!;
  assert.equal(unmined.height, null);
  assert.equal(unmined.class, 'duplicate');
  assert.equal(roots.get(b64(id(7)))!.missing, 1);
  assert.equal(roots.get(b64(id(8))), undefined, 'in-progress root skipped');
  assert.equal(roots.get(b64(id(9))), undefined, 'nested counts sum');

  assert.equal(result.roots.indexed, 8);
  assert.equal(result.roots.inProgress, 1);
  assert.equal(result.roots.checked, 8);
  assert.equal(result.roots.complete, 3); // 1, 4 and 9
  assert.equal(result.roots.short, 5);
  assert.deepEqual(result.roots.byClass, {
    missing: 2,
    expired: 1,
    duplicate: 2,
    complete: 0,
    unlisted: 0,
  });
  assert.equal(result.roots.withoutL1Row, 1);
  assert.deepEqual(result.items, {
    expected: 16,
    here: 9,
    elsewhere: 2,
    expired: 1,
    missing: 4,
  });
  assert.deepEqual(result.missingByHeight, { '0': 4 });
  assert.deepEqual(result.stalledBundles, { topLevel: 1, nested: 0 });

  // A range leaves out root 7 (h 5000) and the root with no L1 row.
  const ranged: ShortRoot[] = [];
  const inRange = await runCensus({
    bundles,
    clickhouse,
    from: 0,
    to: 2000,
    idChunk: 2,
    onShortRoot: (s) => ranged.push(s),
  });
  assert.deepEqual(
    ranged.map((s) => s.root).sort(),
    [b64(id(2)), b64(id(3)), b64(id(5))].sort(),
  );
  assert.equal(inRange.roots.outOfRange, 2);
  assert.equal(inRange.roots.checked, 6);

  // --roots: each listed root checked by id, complete ones included.
  const listed: ShortRoot[] = [];
  const only = await runCensus({
    bundles,
    clickhouse,
    roots: [b64(id(1)), b64(id(2)), b64(id(8)), b64(id(42))],
    onShortRoot: (s) => listed.push(s),
  });
  assert.equal(byRoot(listed).get(b64(id(1)))!.class, 'complete');
  assert.equal(byRoot(listed).get(b64(id(1)))!.here, 2);
  assert.equal(byRoot(listed).get(b64(id(2)))!.missing, 3);
  assert.equal(only.roots.complete, 1);
  assert.equal(only.roots.inProgress, 1);
  assert.equal(only.roots.notIndexed, 1);
}

describe('runCensus', () => {
  it('classifies every item of the short roots', async () => {
    const { db, rows, expiredIds } = fixture();
    await checkCensus(new FakeClickHouse(rows, expiredIds), db);
  });

  it('refuses an id that is not a transaction id', async () => {
    const { db, rows, expiredIds } = fixture();
    await assert.rejects(
      runCensus({
        bundles: db,
        clickhouse: new FakeClickHouse(rows, expiredIds),
        roots: ['not-an-id'],
      }),
      /not a transaction id/,
    );
  });

  it("keeps a chunk of ids under ClickHouse's 128 KiB field limit", () => {
    // As the client serializes an Array(String) parameter.
    const param = `[${Array.from({ length: CENSUS_ID_CHUNK }, (_, i) => `'${hex(id(i))}'`).join(',')}]`;
    assert.ok(param.length < 128 * 1024 * 0.75, `${param.length} bytes`);
  });

  it('never interpolates ids into SQL', async () => {
    const { db, rows, expiredIds } = fixture();
    const fake = new FakeClickHouse(rows, expiredIds);
    await runCensus({ bundles: db, clickhouse: fake });
    for (const query of fake.queries) {
      assert.ok(!/[0-9A-F]{64}/.test(query), 'no hex id in a query');
    }
  });
});

/**
 * Against a real ClickHouse, when INDEX_EXPORT_TEST_CLICKHOUSE_URL names a
 * disposable one (it creates and drops a database): checks the SQL itself,
 * which the fake can only imitate. An id check that silently matches nothing
 * (an alias shadowing a column, bytes compared with text) passes a fake and
 * fails here.
 */
const realUrl = process.env.INDEX_EXPORT_TEST_CLICKHOUSE_URL;

describe(
  'runCensus against ClickHouse',
  {
    skip:
      realUrl === undefined
        ? 'INDEX_EXPORT_TEST_CLICKHOUSE_URL is not set'
        : false,
  },
  () => {
    const database = `index_census_test_${process.pid}`;
    const connect = (db?: string) =>
      createClient({
        url: realUrl,
        username: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_USER ?? 'default',
        password: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_PASSWORD ?? '',
        database: db,
      });

    before(async () => {
      const client = connect();
      await client.command({ query: `CREATE DATABASE ${database}` });
      // Only the columns the census reads; the keys are the schema's.
      await client.command({
        query: `CREATE TABLE ${database}.transactions (
          id String, height UInt32, block_transaction_index UInt16,
          is_data_item Bool, root_transaction_id String)
          ENGINE = ReplacingMergeTree
          ORDER BY (height, block_transaction_index, is_data_item, id)`,
      });
      await client.command({
        query: `CREATE TABLE ${database}.transaction_ids (
          id String, height UInt32, block_transaction_index UInt16,
          is_data_item Bool)
          ENGINE = ReplacingMergeTree
          ORDER BY (id, height, block_transaction_index, is_data_item)`,
      });
      const { rows, expiredIds } = fixture();
      const h = (buf: Buffer) => `unhex('${buf.toString('hex')}')`;
      await client.command({
        query: `INSERT INTO ${database}.transactions VALUES ${rows
          .map(
            (r) =>
              `(${h(r.id)}, ${r.height}, 0, ${r.isDataItem ? 1 : 0}, ${h(r.root)})`,
          )
          .join(', ')}`,
      });
      await client.command({
        query: `INSERT INTO ${database}.transaction_ids VALUES ${[
          ...rows.map(
            (r) => `(${h(r.id)}, ${r.height}, 0, ${r.isDataItem ? 1 : 0})`,
          ),
          ...expiredIds.map((r) => `(${h(r.id)}, ${r.height}, 0, 1)`),
        ].join(', ')}`,
      });
      await client.close();
    });

    after(async () => {
      const client = connect();
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      await client.close();
    });

    it('classifies the fixture exactly as the fake does', async () => {
      const client = connect(database) as unknown as ClickHouseQuerier;
      try {
        await checkCensus(client, fixture().db);
      } finally {
        await client.close();
      }
    });
  },
);
