/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import type { ClickHouseHeld } from './clickhouse-held.js';
import {
  bandIndexedAt,
  importPartitions,
  JOB_FILE,
  type L2ImportBlock,
  type L2ImportJob,
  L2ImportRefused,
  WRITTEN_FILE,
  writeClickHouseJob,
} from './import-clickhouse.js';
import { type ParquetL2Band, parseSelection } from './layout.js';

const id = (n: number) => Buffer.alloc(32, n);
const hexOf = (b: Buffer) => b.toString('hex').toUpperCase();
const ROOT = Buffer.alloc(32, 0xee);
const OWNER_LONG = Buffer.alloc(32, 0xa1);
const OWNER_SHORT = Buffer.alloc(32, 0xa2);

/** A `data_items` row; a location of undefined writes the item unlocated. */
interface Row {
  id: Buffer;
  height: number;
  bti?: number;
  owner?: Buffer;
  location?: {
    rpo: number;
    offset: number;
    size?: number;
    dataOffset?: number;
  };
}

const BAND: ParquetL2Band = {
  version: 1,
  schema: 'l2-2',
  heightRange: [100, 25099],
  selection: parseSelection({
    kind: 'ans104-data-items',
    tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
  }),
  keyTags: [],
  statTags: [],
  tables: {
    data_items: { rows: 0, rowDigest: '00' },
    tags: { rows: 0, rowDigest: '00' },
    wallets: { rows: 0, rowDigest: '00' },
    parents: { rows: 0, rowDigest: '00' },
  },
  lookups: {},
  createdAt: '2026-10-01T00:00:00.000Z',
};

const sqlBlob = (b: Buffer | undefined | null) =>
  b === undefined || b === null ? 'NULL' : `from_hex('${b.toString('hex')}')`;

async function writeBand(
  duck: Database,
  dir: string,
  rows: Row[],
  tags: Array<{ id: Buffer; height: number; index: number; name: string }>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const values = rows.map((r) => {
    const l = r.location;
    const n = (v: number | undefined) => (v === undefined ? 'NULL' : v);
    return `(${sqlBlob(r.id)}, ${r.height}, ${r.bti ?? 1}, ${sqlBlob(ROOT)}, ${sqlBlob(ROOT)},
      ${sqlBlob(r.owner ?? OWNER_LONG)}, NULL::BLOB, NULL::BLOB, 1, 100, 'text/plain', NULL::VARCHAR, 1,
      ${n(l?.rpo)}, ${n(l?.offset)}, ${l === undefined ? 'NULL' : (l.size ?? 200)},
      ${l === undefined ? 'NULL' : (l.dataOffset ?? l.offset + 100)},
      ${l === undefined ? 'NULL' : l.offset + 2}, ${l === undefined ? 'NULL' : 512},
      ${l === undefined ? 'NULL' : l.offset + 514}, ${l === undefined ? 'NULL' : 512})`;
  });
  await duck.exec(`
    COPY (SELECT * FROM (VALUES ${values.join(',')}) AS t(
      id, height, block_transaction_index, root_transaction_id, parent_id,
      owner_address, target, anchor, signature_type, data_size, content_type,
      content_encoding, tag_count, root_parent_offset, "offset", size,
      data_offset, owner_offset, owner_size, signature_offset, signature_size))
    TO '${path.join(dir, 'data_items.parquet')}' (FORMAT PARQUET)`);
  const tagValues = tags.map(
    (t) =>
      `(${t.height}::UBIGINT, ${sqlBlob(t.id)}, ${t.index}::USMALLINT, encode('${t.name}'), encode('ArDrive'))`,
  );
  await duck.exec(`
    COPY (SELECT * FROM (VALUES ${tagValues.join(',')}) AS t(height, id, tag_index, tag_name, tag_value))
    TO '${path.join(dir, 'tags.parquet')}' (FORMAT PARQUET)`);
  // A 512-byte RSA modulus and a 65-byte secp256k1 key... as stored: the
  // exporter keeps `owner` only for keys of 64 bytes or less.
  await duck.exec(`
    COPY (SELECT * FROM (VALUES
      (${sqlBlob(OWNER_LONG)}, ${sqlBlob(Buffer.alloc(512, 1))}),
      (${sqlBlob(OWNER_SHORT)}, ${sqlBlob(Buffer.alloc(33, 2))})
    ) AS t(address, public_modulus))
    TO '${path.join(dir, 'wallets.parquet')}' (FORMAT PARQUET)`);
}

/** ClickHouse as the importer sees it: rows held, by id. */
class MemoryHeld implements ClickHouseHeld {
  calls: Array<{ from: number; to: number; ids: number }> = [];
  constructor(
    public top: number | undefined,
    public rows: Array<{
      id: Buffer;
      height: number;
      bti: number;
      dataOffset: number;
      offset: number;
      rpo?: number;
      size?: number;
    }> = [],
  ) {}

  async topHeight() {
    return this.top;
  }

  async heldIn({
    from,
    to,
    idsFile,
    outFile,
  }: {
    from: number;
    to: number;
    idsFile: string;
    outFile: string;
  }) {
    const ids = new Set(
      (await fs.readFile(idsFile, 'utf8')).split('\n').filter((l) => l !== ''),
    );
    this.calls.push({ from, to, ids: ids.size });
    const lines = this.rows
      .filter((r) => ids.has(hexOf(r.id)) && r.height >= from && r.height <= to)
      .map((r) =>
        [
          hexOf(r.id),
          r.height,
          r.bti,
          hexOf(ROOT),
          hexOf(ROOT),
          hexOf(OWNER_LONG),
          100,
          r.offset,
          r.size ?? 200,
          r.dataOffset,
          r.offset + 2,
          512,
          r.offset + 514,
          512,
          r.rpo ?? 0,
        ].join('\t'),
      );
    await fs.writeFile(
      outFile,
      lines.length > 0 ? `${lines.join('\n')}\n` : '',
    );
  }
}

const blocksExcept = (missing: number[] = []) => ({
  *blocks(from: number, to: number): Iterable<L2ImportBlock> {
    for (let h = from; h <= to; h++) {
      if (missing.includes(h)) continue;
      yield {
        indepHash: Buffer.alloc(48, h % 256),
        height: h,
        previousBlock: h === 0 ? null : Buffer.alloc(48, (h - 1) % 256),
        nonce: Buffer.from('n'),
        hash: Buffer.from('h'),
        blockTimestamp: 1_700_000_000 + h,
        txCount: 3,
        blockSize: 1000,
      };
    }
  },
});

describe('importPartitions', () => {
  it('cuts a band into the auto-import grid, up to the ceiling', () => {
    assert.deepEqual(importPartitions([100, 25099], 30000, 10000), [
      [100, 9999],
      [10000, 19999],
      [20000, 25099],
    ]);
    assert.deepEqual(importPartitions([100, 25099], 15000, 10000), [
      [100, 9999],
      [10000, 15000],
    ]);
    assert.deepEqual(importPartitions([20000, 25099], 15000, 10000), []);
  });
});

describe('writeClickHouseJob', () => {
  let duck: Database;
  let root: string;
  let bandDir: string;
  let jobsDir: string;
  let queueDir: string;
  let workDir: string;

  before(async () => {
    duck = await Database.create(':memory:');
  });
  after(async () => {
    await duck.close();
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-import-ch-'));
    bandDir = path.join(root, 'band');
    jobsDir = path.join(root, 'jobs');
    queueDir = path.join(jobsDir, 'queue');
    workDir = path.join(root, 'work');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const run = (held: ClickHouseHeld, ceiling: number, missing: number[] = []) =>
    writeClickHouseJob({
      duck,
      band: BAND,
      bandDir,
      bandId: 'l2-h100-25099-3078e8b8-000000000000',
      index: 'ardrive-l2',
      publisher: 'publisher-wallet',
      held,
      blocks: blocksExcept(missing),
      ceiling,
      jobsDir,
      workDir,
      now: new Date('2026-10-28T10:00:00Z'),
      partitionHeights: 10000,
      marginHeights: 10,
    });

  const read = async (job: L2ImportJob, table: string) =>
    duck.all(
      `SELECT * FROM read_parquet('${path.join(queueDir, job.job, table)}/data/*/*.parquet', hive_partitioning = false) ORDER BY height, ${table === 'blocks' ? 'indep_hash' : 'id'}`,
    );

  const rows: Row[] = [
    // A: unlocated at 120, located at 150. The located place is kept.
    { id: id(0xa), height: 120 },
    { id: id(0xa), height: 150, location: { rpo: 0, offset: 10 } },
    // B: twice in one root, and again later. The first place is kept.
    { id: id(0xb), height: 200, location: { rpo: 0, offset: 50 } },
    { id: id(0xb), height: 200, location: { rpo: 0, offset: 10 } },
    { id: id(0xb), height: 300, location: { rpo: 0, offset: 0 } },
    // C: nowhere located. Kept, with zeros.
    { id: id(0xc), height: 400 },
    // D: held at the same key, the same. E: held, differently.
    { id: id(0xd), height: 500, location: { rpo: 0, offset: 10 } },
    { id: id(0xe), height: 600, location: { rpo: 0, offset: 10 } },
    // F: held two heights on, in another root.
    { id: id(0xf), height: 700, location: { rpo: 0, offset: 10 } },
    // G, H: the second partition; H's owner key is short.
    { id: id(0x10), height: 15000, location: { rpo: 0, offset: 10 } },
    {
      id: id(0x11),
      height: 15001,
      owner: OWNER_SHORT,
      location: { rpo: 0, offset: 10 },
    },
    // I: the third partition, above a ceiling of 20000.
    { id: id(0x12), height: 24000, location: { rpo: 0, offset: 10 } },
  ];
  const tags = [
    { id: id(0xa), height: 120, index: 0, name: 'App-Name' },
    { id: id(0xa), height: 150, index: 0, name: 'App-Name' },
    { id: id(0xa), height: 150, index: 1, name: 'Second' },
    { id: id(0xd), height: 500, index: 0, name: 'App-Name' },
    { id: id(0x10), height: 15000, index: 0, name: 'App-Name' },
  ];
  const held = () =>
    new MemoryHeld(20000, [
      { id: id(0xd), height: 500, bti: 1, offset: 10, dataOffset: 110 },
      { id: id(0xe), height: 600, bti: 1, offset: 10, dataOffset: 999 },
      { id: id(0xf), height: 702, bti: 4, offset: 0, dataOffset: 100 },
    ]);

  it('keeps one place per item, leaves out what ClickHouse holds, and stops at the ceiling', async () => {
    await writeBand(duck, bandDir, rows, tags);
    const h = held();
    const outcome = await run(h, 20000);
    const job = outcome.job;
    assert.ok(job !== undefined);
    assert.deepEqual(outcome.conflictExamples, [hexOf(id(0xe))]);
    assert.deepEqual(job.conflictExamples, [hexOf(id(0xe))]);
    assert.deepEqual(job.counts, {
      bandRows: 12,
      otherPlacements: 3,
      aboveCeiling: 1,
      present: 2,
      conflicting: 1,
      elsewhere: 1,
      written: 5,
      unlocated: 1,
      tags: 3,
      blocks: 5,
    });
    assert.deepEqual(job.heightRange, [100, 20000]);
    assert.deepEqual(job.partitions, ['height=100-9999', 'height=10000-19999']);
    assert.equal(job.indexedAt, bandIndexedAt(BAND));
    // Two windows asked, each widened by the margin; the third is above
    // the ceiling and never asked.
    assert.deepEqual(
      h.calls.map((c) => [c.from, c.to]),
      [
        [90, 10009],
        [9990, 20009],
      ],
    );

    const tx = await read(job, 'transactions');
    assert.deepEqual(
      tx.map((r) => [(r.id as Buffer)[0], Number(r.height)]),
      [
        [0xa, 150],
        [0xb, 200],
        [0xc, 400],
        [0x10, 15000],
        [0x11, 15001],
      ],
    );
    const b = tx[1];
    assert.equal(Number(b.offset), 10, 'the first place in the root');
    const c = tx[2];
    assert.equal(Number(c.offset), 0);
    assert.equal(Number(c.data_offset), 0);
    assert.equal(Number(c.size), 0);
    for (const r of tx) {
      assert.equal(Number(r.indexed_at), job.indexedAt);
      assert.equal(r.is_data_item, true);
      assert.deepEqual(r.anchor, Buffer.alloc(0));
    }
    assert.equal(tx[3].owner, null, 'a 512-byte key is not kept');
    assert.deepEqual(tx[4].owner, Buffer.alloc(33, 2));

    const t = await read(job, 'tags');
    assert.deepEqual(
      t.map((r) => [
        (r.id as Buffer)[0],
        Number(r.height),
        Number(r.tag_index),
      ]),
      [
        [0xa, 150, 0],
        [0xa, 150, 1],
        [0x10, 15000, 0],
      ],
      "only the written items' tags, at the place kept",
    );

    const blocks = await read(job, 'blocks');
    assert.deepEqual(
      blocks.map((r) => Number(r.height)),
      [150, 200, 400, 15000, 15001],
    );

    const written = await duck.all(
      `SELECT height::INTEGER AS height FROM read_parquet('${path.join(queueDir, job.job, WRITTEN_FILE)}') ORDER BY height`,
    );
    assert.deepEqual(
      written.map((r) => r.height),
      [150, 200, 400, 15000, 15001],
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(queueDir, job.job, JOB_FILE), 'utf8'),
    );
    assert.deepEqual(manifest, JSON.parse(JSON.stringify(job)));
    assert.deepEqual(await fs.readdir(workDir), [], 'nothing left behind');
    assert.deepEqual(await fs.readdir(path.join(jobsDir, '.partial')), []);
  });

  it("writes the Parquet exporter's columns and types", async () => {
    await writeBand(duck, bandDir, rows, tags);
    const { job } = await run(held(), 20000);
    assert.ok(job !== undefined);
    const describe = async (table: string) =>
      (
        await duck.all(
          `DESCRIBE SELECT * FROM read_parquet('${path.join(queueDir, job.job, table)}/data/*/*.parquet', hive_partitioning = false)`,
        )
      ).map((r) => `${String(r.column_name)} ${String(r.column_type)}`);
    // parquet-exporter.ts, TYPED_SELECTS: what clickhouse-import reads.
    assert.deepEqual(await describe('transactions'), [
      'id BLOB',
      'indexed_at UBIGINT',
      'block_transaction_index USMALLINT',
      'is_data_item BOOLEAN',
      'target BLOB',
      'quantity DECIMAL(20,0)',
      'reward DECIMAL(20,0)',
      'anchor BLOB',
      'data_size UBIGINT',
      'content_type VARCHAR',
      'format UTINYINT',
      'height UBIGINT',
      'owner_address BLOB',
      'data_root BLOB',
      'parent BLOB',
      'offset UBIGINT',
      'size UBIGINT',
      'data_offset UBIGINT',
      'owner_offset UBIGINT',
      'owner_size UINTEGER',
      'owner BLOB',
      'signature_offset UBIGINT',
      'signature_size UINTEGER',
      'signature_type UINTEGER',
      'root_transaction_id BLOB',
      'root_parent_offset UBIGINT',
    ]);
    assert.deepEqual(await describe('tags'), [
      'height UBIGINT',
      'id BLOB',
      'tag_index USMALLINT',
      'indexed_at UBIGINT',
      'tag_name BLOB',
      'tag_value BLOB',
      'is_data_item BOOLEAN',
    ]);
    assert.deepEqual(await describe('blocks'), [
      'indep_hash BLOB',
      'height UBIGINT',
      'previous_block BLOB',
      'nonce BLOB',
      'hash BLOB',
      'block_timestamp INTEGER',
      'tx_count INTEGER',
      'block_size UBIGINT',
    ]);
  });

  it('refuses, and queues nothing, when the gateway lacks a block an item is at', async () => {
    await writeBand(duck, bandDir, rows, tags);
    await assert.rejects(run(held(), 20000, [400]), (error: Error) => {
      assert.ok(error instanceof L2ImportRefused);
      assert.match(error.message, /lacks blocks .*400/);
      return true;
    });
    assert.deepEqual(await fs.readdir(queueDir).catch(() => []), []);
    assert.deepEqual(await fs.readdir(workDir), []);
  });

  it('writes no job when ClickHouse holds every item', async () => {
    await writeBand(duck, bandDir, [rows[6]], [tags[3]]);
    const outcome = await run(held(), 20000);
    assert.equal(outcome.job, undefined);
    assert.equal(outcome.counts.present, 1);
    assert.equal(outcome.counts.written, 0);
    assert.deepEqual(await fs.readdir(queueDir).catch(() => []), []);
  });

  it('writes the same rows for the same band twice', async () => {
    await writeBand(duck, bandDir, rows, tags);
    const { job: first } = await run(held(), 20000);
    assert.ok(first !== undefined);
    const a = await read(first, 'transactions');
    await fs.rm(queueDir, { recursive: true });
    const { job: second } = await run(held(), 20000);
    assert.ok(second !== undefined);
    assert.deepEqual(await read(second, 'transactions'), a);
  });
});
