/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';
import { Database } from 'duckdb-async';

import { bandIndexedAt, L2ImportRefused } from './import-clickhouse.js';
import { readLedger } from './import-ledger.js';
import { forgetSqliteBand, importBandIntoSqlite } from './import-sqlite.js';
import { type ParquetL2Band, parseSelection } from './layout.js';

const SCHEMA = await fs.readFile(
  new URL('../../../test/bundles-schema.sql', import.meta.url),
  'utf8',
);

const id = (n: number) => Buffer.alloc(32, n);
const ROOT = Buffer.alloc(32, 0xee);
const OWNER = Buffer.alloc(32, 0xa1);
const NO_KEY_OWNER = Buffer.alloc(32, 0xa9);
const MODULUS = Buffer.alloc(512, 1);
const sha1 = (s: string) =>
  crypto.createHash('sha1').update(Buffer.from(s)).digest();

/** A `data_items` row; a location of undefined writes the item unlocated. */
interface Row {
  id: Buffer;
  height: number;
  bti?: number;
  owner?: Buffer;
  location?: { rpo: number; offset: number };
}

const BAND: ParquetL2Band = {
  version: 1,
  schema: 'l2-2',
  heightRange: [100, 199],
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
const INDEXED_AT = bandIndexedAt(BAND);

const sqlBlob = (b: Buffer | undefined | null) =>
  b === undefined || b === null ? 'NULL' : `from_hex('${b.toString('hex')}')`;

async function writeBand(
  duck: Database,
  dir: string,
  rows: Row[],
  tagsPerItem = 2,
  tagValue = 'ArDrive',
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const values = rows.map((r) => {
    const l = r.location;
    const at = (v: number) => (l === undefined ? 'NULL' : v);
    return `(${sqlBlob(r.id)}, ${r.height}, ${r.bti ?? 1}, ${sqlBlob(ROOT)}, ${sqlBlob(ROOT)},
      ${sqlBlob(r.owner ?? OWNER)}, NULL::BLOB, NULL::BLOB, 1, 100, 'text/plain', NULL::VARCHAR, ${tagsPerItem},
      ${at(l?.rpo ?? 0)}, ${at(l?.offset ?? 0)}, ${at(200)}, ${at((l?.offset ?? 0) + 1100)},
      ${at((l?.offset ?? 0) + 514)}, ${at(512)}, ${at((l?.offset ?? 0) + 2)}, ${at(512)})`;
  });
  await duck.exec(`
    COPY (SELECT * FROM (VALUES ${values.join(',')}) AS t(
      id, height, block_transaction_index, root_transaction_id, parent_id,
      owner_address, target, anchor, signature_type, data_size, content_type,
      content_encoding, tag_count, root_parent_offset, "offset", size,
      data_offset, owner_offset, owner_size, signature_offset, signature_size))
    TO '${path.join(dir, 'data_items.parquet')}' (FORMAT PARQUET)`);
  // Each item's tags once per height it sits at.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const r of rows) {
    const key = `${r.id.toString('hex')}:${r.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let i = 0; i < tagsPerItem; i++) {
      tags.push(
        `(${r.height}::UBIGINT, ${sqlBlob(r.id)}, ${i}::USMALLINT, encode('Tag-${i}'), encode('${tagValue}'))`,
      );
    }
  }
  await duck.exec(`
    COPY (SELECT * FROM (VALUES ${tags.join(',')}) AS t(height, id, tag_index, tag_name, tag_value))
    TO '${path.join(dir, 'tags.parquet')}' (FORMAT PARQUET)`);
  await duck.exec(`
    COPY (SELECT * FROM (VALUES (${sqlBlob(OWNER)}, ${sqlBlob(MODULUS)})) AS t(address, public_modulus))
    TO '${path.join(dir, 'wallets.parquet')}' (FORMAT PARQUET)`);
}

/** A row the gateway itself wrote, as its flush does. */
function gatewayRow(
  db: Sqlite.Database,
  {
    item,
    height,
    bti = 1,
    offset,
  }: { item: Buffer; height: number; bti?: number; offset: number },
) {
  db.prepare(
    `INSERT INTO stable_data_items (id, parent_id, root_transaction_id, height,
       block_transaction_index, anchor, owner_address, data_offset, data_size,
       tag_count, indexed_at, offset, size, owner_offset, owner_size,
       signature_offset, signature_size, root_parent_offset, stable_at)
     VALUES (?, ?, ?, ?, ?, x'', ?, ?, 100, 0, 1700000000, ?, 200, ?, 512, ?, 512, 0, 1700003600)`,
  ).run(
    item,
    ROOT,
    ROOT,
    height,
    bti,
    OWNER,
    offset + 1100,
    offset,
    offset + 514,
    offset + 2,
  );
}

describe('importBandIntoSqlite', () => {
  let duck: Database;
  let dir: string;
  let db: Sqlite.Database;

  before(async () => {
    duck = await Database.create(':memory:');
  });
  after(async () => {
    await duck.close();
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-sqlite-'));
    db = new Sqlite(':memory:');
    db.exec(SCHEMA);
  });
  afterEach(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = (
    overrides: Partial<Parameters<typeof importBandIntoSqlite>[0]> = {},
  ) =>
    importBandIntoSqlite({
      duck,
      db,
      band: BAND,
      bandDir: dir,
      bandId: 'l2-h100-199-test',
      index: 'ardrive-l2',
      publisher: 'publisher-wallet',
      ceiling: 199,
      hasBlock: () => true,
      accepted: [],
      yieldMs: 0,
      ...overrides,
    });

  const item = (n: number) =>
    db.prepare('SELECT * FROM stable_data_items WHERE id = ?').get(id(n)) as
      | Record<string, unknown>
      | undefined;
  const tagCount = (n: number) =>
    db
      .prepare(
        'SELECT COUNT(*) FROM stable_data_item_tags WHERE data_item_id = ?',
      )
      .pluck()
      .get(id(n)) as number;

  it('writes one located placement per item, with its tags and owner, marked with the band', async () => {
    await writeBand(duck, dir, [
      // Two placements: the earlier height is kept.
      { id: id(1), height: 120, location: { rpo: 0, offset: 5000 } },
      { id: id(1), height: 110, location: { rpo: 0, offset: 1000 } },
      { id: id(2), height: 130, location: { rpo: 64, offset: 0 } },
    ]);
    const { counts, heightRange } = await run();
    assert.deepEqual(heightRange, [100, 199]);
    assert.equal(counts.bandRows, 3);
    assert.equal(counts.otherPlacements, 1);
    assert.equal(counts.written, 2);
    assert.equal(counts.tags, 4);

    const one = item(1)!;
    assert.equal(one.height, 110);
    assert.equal(one.offset, 1000);
    assert.equal(one.signature_offset, 1002);
    assert.equal(one.data_offset, 2100);
    assert.equal(one.indexed_at, INDEXED_AT);
    assert.equal(one.stable_at, INDEXED_AT);
    assert.equal(one.signature, null);
    assert.deepEqual(one.anchor, Buffer.alloc(0));
    assert.deepEqual(one.target, Buffer.alloc(0));
    assert.equal(item(2)!.root_parent_offset, 64);

    assert.equal(tagCount(1), 2);
    const tag = db
      .prepare(
        `SELECT t.height, n.name FROM stable_data_item_tags t
         JOIN tag_names n ON n.hash = t.tag_name_hash
         WHERE t.data_item_id = ? AND t.data_item_tag_index = 0`,
      )
      .get(id(1)) as { height: number; name: Buffer };
    assert.equal(tag.height, 110);
    assert.equal(tag.name.toString(), 'Tag-0');
    assert.ok(
      db.prepare('SELECT 1 FROM tag_names WHERE hash = ?').get(sha1('Tag-1')),
    );
    assert.deepEqual(
      db
        .prepare('SELECT public_modulus FROM wallets WHERE address = ?')
        .pluck()
        .get(OWNER),
      MODULUS,
    );

    const ledger = readLedger(db, 'sqlite').get('l2-h100-199-test')!;
    assert.equal(ledger.heightTo, 199);
    assert.notEqual(ledger.completedAt, null);
  });

  it('skips unlocated items and those above the ceiling', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
      { id: id(2), height: 120 },
      { id: id(3), height: 190, location: { rpo: 0, offset: 0 } },
    ]);
    const { counts, heightRange } = await run({ ceiling: 150 });
    assert.deepEqual(heightRange, [100, 150]);
    assert.equal(counts.written, 1);
    assert.equal(counts.unlocated, 1);
    assert.equal(counts.aboveCeiling, 1);
    assert.equal(item(2), undefined);
    assert.equal(item(3), undefined);
    const ledger = db
      .prepare(
        "SELECT height_to, rows_unlocated FROM parquet_l2_imports WHERE target = 'sqlite'",
      )
      .get() as { height_to: number; rows_unlocated: number };
    assert.deepEqual(ledger, { height_to: 150, rows_unlocated: 1 });
  });

  it('keeps a row the gateway holds, counts how it differs, and adds no tags to it', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 1000 } },
      { id: id(2), height: 120, location: { rpo: 0, offset: 2000 } },
      { id: id(3), height: 130, location: { rpo: 0, offset: 3000 } },
    ]);
    gatewayRow(db, { item: id(1), height: 110, offset: 1000 });
    gatewayRow(db, { item: id(2), height: 120, offset: 9999 });
    gatewayRow(db, { item: id(3), height: 131, offset: 3000 });
    const { counts, conflictExamples } = await run();
    assert.equal(counts.written, 0);
    assert.equal(counts.present, 2);
    assert.equal(counts.conflicting, 1);
    assert.equal(counts.elsewhere, 1);
    assert.deepEqual(conflictExamples, [id(2).toString('hex').toUpperCase()]);
    assert.equal(item(2)!.offset, 9999);
    assert.equal(item(2)!.indexed_at, 1700000000);
    assert.equal(tagCount(1) + tagCount(2) + tagCount(3), 0);
    assert.deepEqual(
      db
        .prepare(
          "SELECT rows_present, rows_conflicting, rows_elsewhere FROM parquet_l2_imports WHERE target = 'sqlite'",
        )
        .get(),
      { rows_present: 2, rows_conflicting: 1, rows_elsewhere: 1 },
    );
  });

  it('writes the same rows twice as once, and knows its own rows the second time', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
      { id: id(2), height: 120, location: { rpo: 0, offset: 0 } },
    ]);
    await run();
    const before = db.prepare('SELECT * FROM stable_data_items').all();
    const { counts } = await run();
    assert.equal(counts.written, 0);
    assert.equal(counts.alreadyImported, 2);
    assert.equal(counts.present, 0);
    assert.deepEqual(
      db.prepare('SELECT * FROM stable_data_items').all(),
      before,
    );
    assert.equal(tagCount(1), 2);
    const ledger = db
      .prepare(
        "SELECT rows_imported, rows_present FROM parquet_l2_imports WHERE target = 'sqlite'",
      )
      .get();
    assert.deepEqual(ledger, { rows_imported: 2, rows_present: 0 });
  });

  it('refuses before writing anything when the gateway lacks a block the items are at', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
      { id: id(2), height: 120, location: { rpo: 0, offset: 0 } },
    ]);
    await assert.rejects(
      run({ hasBlock: (h) => h !== 120 }),
      (e: Error) => e instanceof L2ImportRefused && /120/.test(e.message),
    );
    assert.equal(item(1), undefined);
    assert.equal(readLedger(db, 'sqlite').size, 0);
  });

  it('refuses before writing anything when there is no room', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
    ]);
    await assert.rejects(
      run({
        checkRoom: async (items) => {
          assert.equal(items, 1);
          throw new L2ImportRefused('no room');
        },
      }),
      /no room/,
    );
    assert.equal(item(1), undefined);
  });

  it('commits in small transactions, the ledger in step, and carries on after a stop', async () => {
    const rows: Row[] = [];
    for (let n = 1; n <= 25; n++) {
      rows.push({
        id: id(n),
        height: 100 + n,
        location: { rpo: 0, offset: 0 },
      });
    }
    await writeBand(duck, dir, rows);
    const controller = new AbortController();
    let batches = 0;
    await assert.rejects(
      run({
        batchRows: 10,
        signal: controller.signal,
        log: {
          info: () => {
            batches += 1;
            if (batches === 1) controller.abort();
          },
        },
      }),
    );
    const written = db
      .prepare('SELECT COUNT(*) FROM stable_data_items')
      .pluck()
      .get();
    assert.equal(written, 10);
    const partial = db
      .prepare(
        "SELECT rows_imported, completed_at FROM parquet_l2_imports WHERE target = 'sqlite'",
      )
      .get();
    assert.deepEqual(partial, { rows_imported: 10, completed_at: null });

    const { counts } = await run({ batchRows: 10 });
    assert.equal(counts.written, 15);
    assert.equal(counts.alreadyImported, 10);
    const ledger = db
      .prepare(
        "SELECT rows_imported FROM parquet_l2_imports WHERE target = 'sqlite'",
      )
      .pluck()
      .get();
    assert.equal(ledger, 25);
  });

  it('closes a transaction once it has held the lock long enough', async () => {
    const rows: Row[] = [];
    for (let n = 1; n <= 6; n++) {
      rows.push({
        id: id(n),
        height: 100 + n,
        location: { rpo: 0, offset: 0 },
      });
    }
    await writeBand(duck, dir, rows);
    let clock = 0;
    let commits = 0;
    await run({
      batchMs: 2,
      // Each item costs 1 ms: a transaction closes after two.
      now: () => (clock += 1),
      sleep: async () => {
        commits += 1;
      },
      yieldMs: 1,
    });
    assert.ok(commits >= 3, `${commits} commits`);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM stable_data_items').pluck().get(),
      6,
    );
  });

  it('writes a tag value that is also a tag name into both tables', async () => {
    await writeBand(
      duck,
      dir,
      [
        { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
        { id: id(2), height: 120, location: { rpo: 0, offset: 0 } },
      ],
      2,
      'Tag-0',
    );
    await run();
    assert.ok(
      db.prepare('SELECT 1 FROM tag_names WHERE hash = ?').get(sha1('Tag-0')),
    );
    assert.ok(
      db.prepare('SELECT 1 FROM tag_values WHERE hash = ?').get(sha1('Tag-0')),
    );
    assert.equal(tagCount(1) + tagCount(2), 4);
  });

  it('counts an item written whose owner key the band lacks', async () => {
    await writeBand(duck, dir, [
      {
        id: id(1),
        height: 110,
        owner: NO_KEY_OWNER,
        location: { rpo: 0, offset: 0 },
      },
    ]);
    const { counts } = await run();
    assert.equal(counts.written, 1);
    assert.equal(counts.noOwnerKey, 1);
  });

  it('forgetting a band resets a republished band over its heights, whose rows went too', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
    ]);
    await run();
    // The same heights, republished with the same createdAt: it finds the
    // first band's rows its own and is recorded complete.
    await run({ bandId: 'l2-h100-199-republished' });
    // A band elsewhere keeps its ledger row.
    db.prepare(
      `INSERT INTO parquet_l2_imports (band_id, target, index_name, publisher,
         height_from, height_to, band_digest, started_at, completed_at)
       VALUES ('l2-h300-399-other', 'sqlite', 'ardrive-l2', 'p', 300, 399, x'00', 1, 2)`,
    ).run();
    const removed = await forgetSqliteBand({
      db,
      bandId: 'l2-h100-199-test',
      heightRange: [100, 199],
      indexedAt: INDEXED_AT,
      yieldMs: 0,
    });
    assert.deepEqual(removed.reset, ['l2-h100-199-republished']);
    assert.equal(item(1), undefined);
    assert.deepEqual(
      [...readLedger(db, 'sqlite').keys()],
      ['l2-h300-399-other'],
    );
    // The next run writes it again.
    const { counts } = await run({ bandId: 'l2-h100-199-republished' });
    assert.equal(counts.written, 1);
  });

  it('forgets exactly what the band wrote', async () => {
    await writeBand(duck, dir, [
      { id: id(1), height: 110, location: { rpo: 0, offset: 0 } },
      { id: id(2), height: 120, location: { rpo: 0, offset: 0 } },
    ]);
    gatewayRow(db, { item: id(2), height: 120, offset: 0 });
    // The gateway's own row at the band's indexed_at, flushed later.
    db.prepare(
      `INSERT INTO stable_data_items (id, parent_id, root_transaction_id, height,
         block_transaction_index, anchor, owner_address, data_offset, data_size,
         tag_count, indexed_at, stable_at)
       VALUES (?, ?, ?, 150, 1, x'', ?, 0, 1, 0, ?, ?)`,
    ).run(id(3), ROOT, ROOT, OWNER, INDEXED_AT, INDEXED_AT + 2400);
    await run();
    assert.ok(item(1) !== undefined);

    const removed = await forgetSqliteBand({
      db,
      bandId: 'l2-h100-199-test',
      heightRange: [100, 199],
      indexedAt: INDEXED_AT,
      batch: 1,
      yieldMs: 0,
    });
    assert.deepEqual(removed, { items: 1, tags: 2, reset: [] });
    assert.equal(item(1), undefined);
    assert.ok(item(2) !== undefined);
    assert.ok(item(3) !== undefined);
    assert.equal(readLedger(db, 'sqlite').size, 0);
  });
});
