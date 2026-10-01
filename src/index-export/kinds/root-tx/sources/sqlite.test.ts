/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import { REPAIRED_TAG } from './rows.js';
import { SqliteRecordSource } from './sqlite.js';

const id = (seed: number) => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(seed, 0);
  buf[31] = 1;
  return buf;
};

interface Item {
  id: Buffer;
  parentId: Buffer;
  rootTxId: Buffer;
  height: number;
  index?: number;
  offset?: number | null;
  dataOffset?: number;
  size?: number | null;
  dataSize?: number;
  rootParentOffset?: number | null;
}

const collect = async (records: AsyncIterable<BandRecord>) => {
  const out: BandRecord[] = [];
  for await (const record of records) out.push(record);
  return out;
};

describe('SqliteRecordSource', () => {
  let dir: string;
  let dbPath: string;
  let source: SqliteRecordSource | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-export-sqlite-'));
    dbPath = path.join(dir, 'bundles.db');
    const db = new Sqlite(dbPath);
    db.exec(fs.readFileSync('test/bundles-schema.sql', 'utf8'));
    db.close();
  });

  afterEach(async () => {
    await source?.close();
    source = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const insert = (items: Item[]) => {
    const db = new Sqlite(dbPath);
    const statement = db.prepare(`
      INSERT INTO stable_data_items (
        id, parent_id, root_transaction_id, height, block_transaction_index,
        anchor, owner_address, data_offset, data_size, tag_count, indexed_at,
        offset, size, root_parent_offset
      ) VALUES (?, ?, ?, ?, ?, x'00', x'00', ?, ?, 0, 0, ?, ?, ?)`);
    for (const item of items) {
      statement.run(
        item.id,
        item.parentId,
        item.rootTxId,
        item.height,
        item.index ?? 0,
        item.dataOffset ?? (item.offset ?? 64) + 100,
        item.dataSize ?? 1000,
        item.offset === undefined ? 64 : item.offset,
        item.size === undefined ? 1100 : item.size,
        item.rootParentOffset === undefined ? 0 : item.rootParentOffset,
      );
    }
    db.close();
  };

  const open = (batchRows?: number) =>
    (source = new SqliteRecordSource('sqlite', dbPath, batchRows));

  it('reports the highest height, or -1 when empty', async () => {
    assert.equal(await open().stableHeight(), -1);
    await source?.close();
    insert([
      { id: id(1), parentId: id(100), rootTxId: id(100), height: 10 },
      { id: id(2), parentId: id(100), rootTxId: id(100), height: 30 },
    ]);
    assert.equal(await open().stableHeight(), 30);
  });

  it('reads only the heights asked for, every row once, across batches within one height', async () => {
    const items: Item[] = [];
    // A heavy height: 25 items, read 4 at a time.
    for (let i = 0; i < 25; i++) {
      items.push({
        id: id(1000 + i),
        parentId: id(100),
        rootTxId: id(100),
        height: 20,
        index: i % 3,
      });
    }
    items.push(
      { id: id(1), parentId: id(101), rootTxId: id(101), height: 19 },
      { id: id(2), parentId: id(102), rootTxId: id(102), height: 21 },
      { id: id(3), parentId: id(103), rootTxId: id(103), height: 22 },
    );
    insert(items);

    const records = await collect(open(4).records(20, 21));
    const ids = records.map((r) => r.id.toString('hex')).sort();
    const expected = [
      ...items.filter((i) => i.height === 20 || i.height === 21),
    ]
      .map((i) => i.id.toString('hex'))
      .sort();
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, ids.length);
    for (const record of records) {
      assert.equal(record.source, 'sqlite');
      assert.equal(record.rootOffset, 64);
      assert.equal(record.rootDataOffset, 164);
      assert.equal(record.size, 1100);
    }
  });

  it('applies the three-way repair to nested rows', async () => {
    const root = id(100);
    const parent = id(200);
    insert([
      // The parent: a top-level bundle with its payload at 1,000.
      {
        id: parent,
        parentId: root,
        rootTxId: root,
        height: 50,
        offset: 500,
        dataOffset: 1000,
        dataSize: 50000,
      },
      // Relative (unbundled with #907's zero): repaired.
      {
        id: id(1),
        parentId: parent,
        rootTxId: root,
        height: 50,
        offset: 200,
        dataOffset: 300,
        size: 400,
      },
      // Absolute (on-demand): kept.
      {
        id: id(2),
        parentId: parent,
        rootTxId: root,
        height: 50,
        offset: 49800,
        dataOffset: 49900,
        size: 400,
      },
      // Either: root only.
      {
        id: id(3),
        parentId: parent,
        rootTxId: root,
        height: 50,
        offset: 2000,
        dataOffset: 2100,
        size: 400,
      },
      // A correct root_parent_offset: used as is.
      {
        id: id(4),
        parentId: parent,
        rootTxId: root,
        height: 50,
        offset: 200,
        dataOffset: 300,
        size: 400,
        rootParentOffset: 1000,
      },
    ]);
    const s = open(2);
    const records = new Map(
      (await collect(s.records(0, 100))).map((r) => [r.id.toString('hex'), r]),
    );
    assert.equal(records.get(id(1).toString('hex'))?.rootOffset, 1200);
    assert.equal(records.get(id(1).toString('hex'))?.sampleTag, REPAIRED_TAG);
    assert.equal(records.get(id(2).toString('hex'))?.rootOffset, 49800);
    assert.equal(records.get(id(3).toString('hex'))?.rootOffset, undefined);
    assert.ok(records.get(id(3).toString('hex'))?.rootTxId.equals(root));
    assert.equal(records.get(id(4).toString('hex'))?.rootOffset, 1200);
    assert.equal(records.get(id(4).toString('hex'))?.sampleTag, undefined);
    assert.equal(s.stats.repaired, 1);
    assert.deepEqual(s.stats.unrepaired, { ambiguous: 1 });
    assert.deepEqual(s.stats.dropped, {});
    // The parent bundle and its four items.
    assert.equal(s.stats.records, 5);
  });

  it('gives the root only for rows without offsets', async () => {
    insert([
      {
        id: id(1),
        parentId: id(100),
        rootTxId: id(100),
        height: 5,
        offset: null,
        size: null,
      },
    ]);
    const [record] = await collect(open().records(0, 10));
    assert.equal(record.rootOffset, undefined);
    assert.ok(record.rootTxId.equals(id(100)));
  });

  it('reads along the height index, with no sort and no scan', () => {
    insert([{ id: id(1), parentId: id(100), rootTxId: id(100), height: 5 }]);
    const db = new Sqlite(dbPath, { readonly: true });
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
          SELECT id FROM stable_data_items
          WHERE (height, block_transaction_index, id) > (?, ?, ?)
            AND height <= ?
          ORDER BY height, block_transaction_index, id
          LIMIT ?`,
        )
        .all(0, -1, Buffer.alloc(0), 10, 10) as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail).join('\n');
      assert.match(
        details,
        /USING (COVERING )?INDEX stable_data_items_height_block_transaction_index_id_idx/,
      );
      assert.doesNotMatch(details, /TEMP B-TREE/);
    } finally {
      db.close();
    }
  });

  it('names the source and database when it cannot open', () => {
    assert.throws(
      () => new SqliteRecordSource('sqlite', path.join(dir, 'missing.db')),
      (error: Error) =>
        error.message.includes('SQLite source sqlite') &&
        error.message.includes('missing.db') &&
        error.message.includes('gateway must be running'),
    );
  });

  it('opens the database read-only', async () => {
    insert([{ id: id(1), parentId: id(100), rootTxId: id(100), height: 5 }]);
    const s = open();
    // Writes through the source's own connection would throw; the file is
    // untouched after a read.
    const before = fs.statSync(dbPath).mtimeMs;
    await collect(s.records(0, 10));
    assert.equal(fs.statSync(dbPath).mtimeMs, before);
  });
});
