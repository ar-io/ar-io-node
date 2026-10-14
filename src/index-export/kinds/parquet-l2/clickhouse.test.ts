/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createClient } from '@clickhouse/client';

import {
  ARDRIVE,
  buildRoot,
  FixtureRoot,
  gatewayOf,
  MemoryL2Source,
  PUBLISHER,
  sourceRow,
  writeL1Band,
} from '../../../../test/parquet-l2-fixture.js';
import { bandPublisherTag } from '../../../lib/index-band/build.js';
import { l2BandId, serializeBandFile } from '../../../lib/parquet-l2/layout.js';
import {
  CLICKHOUSE_EXPORT_SETTINGS,
  ClickHouseQuerier,
} from '../root-tx/sources/clickhouse.js';
import { deriveL1Bands } from '../parquet-l1/kind.js';
import { ClickHouseL2Source, toSourceRow } from './clickhouse.js';
import { exportL2Band } from './export.js';
import { GatewayReads } from './gateway-reads.js';
import type { L2SourceRow, L2SourceWindow } from './source.js';

const id = (seed: number) => Buffer.alloc(32, seed);
const hex = (buf: Buffer) => buf.toString('hex').toUpperCase();

/** A row as the source's queries return it. */
const raw = (more: Record<string, unknown> = {}) => ({
  id_hex: hex(id(1)),
  parent_hex: hex(id(9)),
  root_hex: hex(id(9)),
  height: 1000,
  item_offset: 1000,
  item_size: 300,
  data_offset: 1200,
  owner_offset: 1067,
  owner_size: 65,
  signature_offset: 1002,
  signature_size: 65,
  root_parent_offset: 0,
  data_size: 100,
  signature_type: 3,
  owner_address_hex: hex(id(5)),
  owner_hex: '',
  target_hex: '',
  anchor_hex: '',
  ...more,
});

/** Records every query and answers it from `answer`. */
class FakeClickHouse implements ClickHouseQuerier {
  readonly queries: Array<{
    query: string;
    params: Record<string, unknown>;
    settings: Record<string, unknown>;
  }> = [];
  closed = false;

  constructor(
    private readonly answer: (
      query: string,
      params: Record<string, any>,
    ) => unknown[],
  ) {}

  async query(params: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, unknown>;
  }) {
    this.queries.push({
      query: params.query,
      params: params.query_params ?? {},
      settings: params.clickhouse_settings ?? {},
    });
    const rows = this.answer(params.query, params.query_params ?? {});
    return {
      stream: async function* () {
        yield rows.map((row) => ({
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

const collect = async (windows: AsyncIterable<L2SourceWindow>) => {
  const out: L2SourceWindow[] = [];
  for await (const window of windows) out.push(window);
  return out;
};

describe('ClickHouseL2Source', () => {
  it('reads rows as the exporter takes them: 0 unknown, empty bytes absent', () => {
    const row = toSourceRow({
      ...raw({
        item_size: 0,
        signature_type: 0,
        owner_hex: hex(id(6)),
        target_hex: '',
        anchor_hex: hex(id(7)),
        root_parent_offset: 0,
        data_size: 0,
      }),
      tag_names_hex: [hex(Buffer.from('App-Name'))],
      tag_values_hex: [hex(Buffer.from([0xff, 0x00]))],
    } as never);
    assert.deepEqual(row.id, id(1));
    assert.equal(row.size, undefined);
    assert.equal(row.signatureType, undefined);
    assert.deepEqual(row.owner, id(6));
    assert.equal(row.target, undefined);
    assert.deepEqual(row.anchor, id(7));
    // root_parent_offset and data_size as stored.
    assert.equal(row.rootParentOffset, 0);
    assert.equal(row.dataSize, 0);
    assert.deepEqual(row.tags, [
      { name: Buffer.from('App-Name'), value: Buffer.from([0xff, 0x00]) },
    ]);
    assert.throws(
      () =>
        toSourceRow({
          ...raw(),
          tag_names_hex: ['41'],
          tag_values_hex: [],
        } as never),
      /1 tag names and 0 values/,
    );
  });

  it('reads each window FINAL with the selection pushed down, then the bundles above its items level by level', async () => {
    const root = id(9);
    const outer = id(10);
    const inner = id(11);
    const fake = new FakeClickHouse((query, params) => {
      if (query.includes('arrayExists')) {
        return params.from === 1000
          ? [
              { ...raw(), tag_names_hex: [], tag_values_hex: [] },
              {
                ...raw({ id_hex: hex(id(2)), parent_hex: hex(inner) }),
                tag_names_hex: [],
                tag_values_hex: [],
              },
              {
                ...raw({ id_hex: hex(id(3)), parent_hex: hex(inner) }),
                tag_names_hex: [],
                tag_values_hex: [],
              },
            ]
          : [];
      }
      if (query.includes('AND is_data_item\n    AND id IN')) {
        const ids = params.ids as string[];
        return [
          ...(ids.includes(inner.toString('hex'))
            ? [raw({ id_hex: hex(inner), parent_hex: hex(outer) })]
            : []),
          ...(ids.includes(outer.toString('hex'))
            ? [raw({ id_hex: hex(outer), parent_hex: hex(root) })]
            : []),
        ];
      }
      return [];
    });
    const source = new ClickHouseL2Source('gw1', fake, 500);
    const windows = await collect(source.windows(1000, 1999, ARDRIVE));
    assert.deepEqual(
      windows.map((w) => [w.from, w.to, w.items.length, w.ancestors.length]),
      [
        [1000, 1499, 3, 2],
        [1500, 1999, 0, 0],
      ],
    );
    const items = fake.queries.filter((q) => q.query.includes('arrayExists'));
    assert.equal(items.length, 2);
    assert.match(items[0].query, /FROM transactions FINAL/);
    // ClickHouse puts a SELECT alias in place of a column of that name in
    // WHERE: none may name a column the conditions read.
    for (const query of fake.queries.map((q) => q.query)) {
      assert.doesNotMatch(
        query,
        /\bAS (id|parent_id|root_transaction_id|tag_names|tag_values|is_data_item)\b/,
      );
    }
    assert.deepEqual(items[0].params, {
      l2_name: Buffer.from('App-Name').toString('hex'),
      l2_prefix: Buffer.from('ArDrive').toString('hex'),
      l2_exclude: Buffer.from('ArDriver').toString('hex'),
      from: 1000,
      to: 1499,
    });
    assert.deepEqual(items[0].settings, { ...CLICKHOUSE_EXPORT_SETTINGS });
    // Each bundle asked for once: the inner one, then the outer one.
    const lookups = fake.queries.filter((q) => q.query.includes('id IN'));
    assert.deepEqual(
      lookups.map((q) => q.params.ids),
      [[inner.toString('hex')], [outer.toString('hex')]],
    );
    assert.match(lookups[0].query, /FROM transactions FINAL/);
  });

  it('splits a window that runs out of memory', async () => {
    let failed = false;
    const fake = new FakeClickHouse((query, params) => {
      if (
        query.includes('arrayExists') &&
        params.from === 0 &&
        params.to === 99 &&
        !failed
      ) {
        failed = true;
        throw new Error('Code: 241. DB::Exception: Memory limit exceeded');
      }
      return [];
    });
    const source = new ClickHouseL2Source('gw1', fake, 100);
    const windows = await collect(source.windows(0, 99, ARDRIVE));
    assert.deepEqual(
      windows.map((w) => [w.from, w.to]),
      [
        [0, 49],
        [50, 99],
      ],
    );
  });

  it("gives every position of a root among the table's L1 rows, and a block's time", async () => {
    const fake = new FakeClickHouse((query, params) => {
      if (query.includes('NOT is_data_item')) {
        return (params.ids as string[]).map((i, n) => ({
          id_hex: i.toUpperCase(),
          height: 1000 + n,
          block_transaction_index: n,
        }));
      }
      if (query.includes('block_timestamp')) {
        return params.height === 5 ? [{ n: 0, ts: 0 }] : [{ n: 3, ts: 1700 }];
      }
      return [];
    });
    const source = new ClickHouseL2Source('gw1', fake);
    const roots = Array.from({ length: 1500 }, (_, i) => {
      const buf = Buffer.alloc(32);
      buf.writeUInt32BE(i);
      return buf;
    });
    const positions = await source.rootPositions(roots, 1000, 2000);
    assert.equal(positions.length, 1500);
    assert.equal(
      fake.queries.filter((q) => q.query.includes('NOT is_data_item')).length,
      2,
    );
    assert.equal(await source.blockTime(6), 1700);
    assert.equal(await source.blockTime(5), undefined);
    await source.close();
    assert.equal(fake.closed, true);
  });

  it('names the source and the hint for a read-only profile in its errors', async () => {
    const fake = new FakeClickHouse(() => {
      throw new Error("Cannot modify 'max_threads' setting in readonly mode");
    });
    const source = new ClickHouseL2Source('gw1', fake);
    await assert.rejects(
      source.stableHeight(),
      /ClickHouse source gw1, stable height: .*readonly=0 or 2/,
    );
  });
});

/**
 * Against a real ClickHouse, when INDEX_EXPORT_TEST_CLICKHOUSE_URL names a
 * disposable one (it creates and drops a database): the SQL itself, which
 * the fake can only imitate, over the gateway's own schema.
 */
const realUrl = process.env.INDEX_EXPORT_TEST_CLICKHOUSE_URL;

describe(
  'ClickHouseL2Source against ClickHouse',
  {
    skip:
      realUrl === undefined
        ? 'INDEX_EXPORT_TEST_CLICKHOUSE_URL is not set'
        : false,
  },
  () => {
    const database = `index_export_l2_test_${process.pid}`;
    const auth = {
      url: realUrl,
      username: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_USER ?? 'default',
      password: process.env.INDEX_EXPORT_TEST_CLICKHOUSE_PASSWORD ?? '',
    };
    let r1: FixtureRoot;
    let r2: FixtureRoot;
    let rows: L2SourceRow[];
    let ancestors: L2SourceRow[];
    let dir: string;

    before(async () => {
      const tag = (name: string, value: string) => ({ name, value });
      r1 = await buildRoot(
        'ch-r1',
        [
          {
            name: 'n1',
            tags: [],
            nested: [
              {
                name: 'b1',
                tags: [
                  tag('App-Name', 'ArDrive-App'),
                  tag('Content-Type', 'x/y'),
                ],
              },
              { name: 'b2', tags: [tag('App-Name', 'ArDrive-Web')] },
            ],
          },
          { name: 'a1', tags: [tag('App-Name', 'ArDrive-App')] },
          {
            name: 'a2',
            tags: [tag('App-Name', 'Other'), tag('App-Name', 'ArDrive-CLI')],
          },
          { name: 'x1', tags: [tag('App-Name', 'ArDriver-Thing')] },
          { name: 'x2', tags: [tag('app-name', 'ArDrive-App')] },
        ],
        1100,
        2,
      );
      r2 = await buildRoot(
        'ch-r2',
        [{ name: 'c1', tags: [tag('App-Name', 'ArDrive-App')] }],
        1205,
        0,
      );
      rows = [
        ...['a1', 'a2', 'b1', 'b2'].map((n) => sourceRow(r1, n)),
        sourceRow(r2, 'c1'),
      ];
      ancestors = [sourceRow(r1, 'n1')];
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'parquet-l2-ch-'));

      const client = createClient(auth);
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
      const h = (buf: Buffer | undefined) =>
        buf === undefined ? "''" : `unhex('${buf.toString('hex')}')`;
      const value = (
        row: L2SourceRow,
        { bti = 0, insertedAt = 100, isDataItem = true } = {},
      ) =>
        `(${row.height}, ${bti}, ${isDataItem ? 1 : 0}, ${h(row.id)}, ${h(row.anchor)}, ${h(row.ownerAddress)}, ${h(row.target)}, 0, 0, ${row.dataSize ?? 0}, '', 0, ${h(row.parentId)}, ${1_600_000_000 + row.height}, ${row.offset ?? 0}, ${row.size ?? 0}, ${row.dataOffset ?? 0}, ${row.ownerOffset ?? 0}, ${row.ownerSize ?? 0}, ${h(row.owner)}, ${row.signatureOffset ?? 0}, ${row.signatureSize ?? 0}, ${row.signatureType ?? 0}, ${h(row.rootTxId)}, ${row.rootParentOffset ?? 0}, [${(row.tags ?? []).map((t) => `(${h(t.name)}, ${h(t.value)})`).join(', ')}], ${(row.tags ?? []).length}, toDateTime(${insertedAt}))`;
      const values = [
        ...rows.map((row) => value(row)),
        ...ancestors.map((row) => value(row)),
        // Not selected: the pushdown leaves them out.
        value(sourceRow(r1, 'x1')),
        value(sourceRow(r1, 'x2')),
        // a1 again under a wrong block position: one row once both carry
        // the root's.
        value(sourceRow(r1, 'a1'), { bti: 7 }),
        // An older version of b2 without offsets: FINAL keeps the newer.
        value(sourceRow(r1, 'b2', { offset: undefined }), { insertedAt: 50 }),
        // The roots, as L1 rows.
        value({ id: r1.id, height: 1100 } as L2SourceRow, {
          bti: 2,
          isDataItem: false,
        }),
        value({ id: r2.id, height: 1205 } as L2SourceRow, {
          bti: 0,
          isDataItem: false,
        }),
      ];
      await client.command({
        query: `INSERT INTO ${database}.transactions
          (height, block_transaction_index, is_data_item, id, anchor,
           owner_address, target, quantity, reward, data_size, content_type,
           format, parent_id, block_timestamp, "offset", "size", data_offset,
           owner_offset, owner_size, owner, signature_offset, signature_size,
           signature_type, root_transaction_id, root_parent_offset, tags,
           tags_count, inserted_at)
          VALUES ${values.join(', ')}`,
      });
      await client.close();
    });

    after(async () => {
      const client = createClient(auth);
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      await client.close();
      await fsp.rm(dir, { recursive: true, force: true });
    });

    const source = () =>
      new ClickHouseL2Source(
        'gw1',
        createClient({
          ...auth,
          database,
          keep_alive: { enabled: true },
        }) as unknown as ClickHouseQuerier,
        150,
      );

    it('gives the selected rows, their bundles and the roots, as the fixture holds them', async () => {
      const ch = source();
      try {
        const windows = await collect(ch.windows(1000, 1299, ARDRIVE));
        const items = windows.flatMap((w) => w.items);
        const names = (list: L2SourceRow[]) =>
          list.map((row) => row.id.toString('hex')).sort();
        // a1 twice (two keys), the rest once; x1 and x2 left out.
        assert.equal(items.length, 6);
        assert.deepEqual([...new Set(names(items))], names(rows));
        // The newer b2, with its offsets.
        const b2 = items.find((row) => row.id.equals(r1.items.get('b2')!.id))!;
        assert.equal(b2.offset, r1.items.get('b2')!.offset);
        assert.deepEqual(b2.tags, sourceRow(r1, 'b2').tags);
        assert.deepEqual(
          names(windows.flatMap((w) => w.ancestors)),
          names(ancestors),
        );
        const positions = await ch.rootPositions(
          [r1.id, r2.id, Buffer.alloc(32, 3)],
          1000,
          1299,
        );
        assert.deepEqual(
          positions
            .map((p) => [
              p.id.toString('hex'),
              p.height,
              p.blockTransactionIndex,
            ])
            .sort(),
          [
            [r1.id.toString('hex'), 1100, 2],
            [r2.id.toString('hex'), 1205, 0],
          ].sort(),
        );
        assert.equal(await ch.blockTime(1205), 1_600_001_205);
        assert.equal(await ch.blockTime(1206), undefined);
        assert.equal(await ch.stableHeight(), 1204);
      } finally {
        await ch.close();
      }
    });

    it('exports the same band as the same rows given directly', async () => {
      const l1 = path.join(dir, 'parquet-l1');
      await writeL1Band(l1, 0, 99_999, [r1, r2]);
      // To the top block the table has rows at, so its L1 rows can date it.
      const run = async (itemSource: ClickHouseL2Source | MemoryL2Source) =>
        exportL2Band({
          selection: ARDRIVE,
          from: 0,
          to: 1205,
          source: itemSource,
          l1Bands: await deriveL1Bands(l1, PUBLISHER),
          reads: new GatewayReads(gatewayOf([r1, r2]).openRoot, {
            maxReads: 100,
          }),
          workDir: path.join(dir, 'work'),
        });
      const ch = source();
      const fromCh = await run(ch);
      const direct = await run(new MemoryL2Source(rows, ancestors));
      // And with the roots from the table's own L1 rows.
      const viaRows = await exportL2Band({
        selection: ARDRIVE,
        from: 0,
        to: 1205,
        source: ch,
        l1Bands: [],
        reads: new GatewayReads(gatewayOf([r1, r2]).openRoot, {
          maxReads: 100,
        }),
        workDir: path.join(dir, 'work'),
      });
      try {
        const tag = bandPublisherTag(PUBLISHER);
        assert.equal(fromCh.band.tables.data_items.rows, 5);
        assert.equal(
          serializeBandFile(fromCh.band),
          serializeBandFile(direct.band),
        );
        assert.equal(l2BandId(fromCh.band, tag), l2BandId(direct.band, tag));
        assert.deepEqual(viaRows.band.tables, direct.band.tables);
        assert.equal(viaRows.stats.roots, 'clickhouse');
      } finally {
        await ch.close();
        for (const r of [fromCh, direct, viaRows]) {
          await fsp.rm(r.staging, { recursive: true, force: true });
        }
      }
    });
  },
);
