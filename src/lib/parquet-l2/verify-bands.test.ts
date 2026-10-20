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
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import { bandPublisherTag } from '../index-band/build.js';
import type { RootSourceFactory } from '../index-band/verify.js';
import { RowDigest } from '../parquet/digest.js';
import {
  BAND_FILE,
  DATA_ITEM_LOCATION_COLUMNS,
  l2BandId,
  orderByClause,
  PARQUET_L2_TABLES,
  type ParquetL2Band,
  serializeBandFile,
} from './layout.js';
import { writeBandLookups } from './lookups.js';
import { L2BandsRefused, verifyL2Bands } from './verify-bands.js';

const LOC = (name: string) => 13 + DATA_ITEM_LOCATION_COLUMNS.indexOf(name);

/** A source whose every read is an Arweave-signed header of no item here. */
const strangerHeaders =
  (reads: number[], fail?: (offset: number) => unknown): RootSourceFactory =>
  () => ({
    read: async (offset: number, size: number) => {
      reads.push(offset);
      const error = fail?.(offset);
      if (error !== undefined) throw error;
      const header = Buffer.alloc(size);
      header.writeUInt16LE(1, 0);
      crypto.randomBytes(512).copy(header, 2);
      return header;
    },
    close: async () => undefined,
    isOpen: () => true,
  });

const PUBLISHER = 'publisher-wallet-for-tests-0000000000000000';
const SELECTION = {
  kind: 'ans104-data-items' as const,
  tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
};
const hash = (label: string) =>
  crypto.createHash('sha256').update(label).digest();

/** What a test changes in a band before it is written. */
interface Tamper {
  /** Edits the rows before writing (a broken builder). */
  rows?: (rows: Record<string, unknown[][]>) => void;
  /** Edits band.json after describing it (a lying publisher). */
  band?: (band: ParquetL2Band) => void;
  /** Writes the table in this order instead of the layout's. */
  unsorted?: string;
}

/**
 * Two items in each band: one directly in its root, one in a nested bundle
 * that `parents` describes. Arweave-signed (type 1): a 2-byte type, a
 * 512-byte signature, the 512-byte owner, then tags, then the payload.
 */
function rows(from: number, label: string): Record<string, unknown[][]> {
  const [root, nested] = [`${label}-root`, `${label}-nested`].map(hash);
  const [a, b] = [`${label}-a`, `${label}-b`].map(hash);
  const key = Buffer.concat([hash(`${label}-key`), Buffer.alloc(480, 7)]);
  const owner = crypto.createHash('sha256').update(key).digest();
  const at = (rpo: number, offset: number, size: number, payload: number) => [
    rpo,
    offset,
    size,
    offset + size - payload,
    offset + 514,
    512,
    offset + 2,
    512,
  ];
  const item = (
    id: Buffer,
    parent: Buffer,
    place: unknown[],
    dataSize: number,
  ) => [
    id,
    from + 1,
    0,
    root,
    parent,
    owner,
    null,
    null,
    1,
    dataSize,
    null,
    null,
    1,
    ...place,
  ];
  const nestedPayload = 3500;
  return {
    data_items: [
      item(a, root, at(0, 0, 1200, 100), 100),
      item(b, nested, at(nestedPayload, 0, 1300, 200), 200),
    ],
    tags: [
      [from + 1, a, 0, Buffer.from('App-Name'), Buffer.from('ArDrive-App')],
      [from + 1, b, 0, Buffer.from('App-Name'), Buffer.from('ArDrive-Web')],
    ],
    wallets: [[owner, key]],
    // The nested bundle, directly in the root: payload at 0 + 3500.
    parents: [[nested, root, 0, 2400, 4000, nestedPayload]],
  };
}

function literal(value: unknown, type: string): string {
  if (value === null) return `NULL::${type}`;
  if (Buffer.isBuffer(value)) return `from_hex('${value.toString('hex')}')`;
  return `${String(value)}::${type}`;
}

/** Writes one band as a builder must (unless tampered) and names it. */
async function writeBand(
  db: Database,
  parent: string,
  from: number,
  to: number,
  tamper: Tamper = {},
): Promise<{ dir: string; id: string; band: ParquetL2Band }> {
  const data = rows(from, `band-${from}`);
  tamper.rows?.(data);
  const staging = await fs.mkdtemp(path.join(parent, '.staging-'));
  const tables: ParquetL2Band['tables'] = {};
  for (const spec of PARQUET_L2_TABLES) {
    const file = path.join(staging, spec.file);
    const names = spec.columns.map((c) => `"${c.name}"`).join(', ');
    // An empty table is written from one typed row of nulls, filtered out.
    const empty = data[spec.name].length === 0;
    const values = (empty ? [spec.columns.map(() => null)] : data[spec.name])
      .map(
        (row) =>
          `(${row.map((v, i) => literal(v, spec.columns[i].type)).join(', ')})`,
      )
      .join(', ');
    const order =
      tamper.unsorted === spec.name
        ? spec.columns.map((c) => `"${c.name}"`).join(' DESC, ') + ' DESC'
        : orderByClause(spec);
    await db.exec(
      `COPY (SELECT * FROM (VALUES ${values}) v(${names})${empty ? ' WHERE false' : ''} ORDER BY ${order}) TO '${file}' (FORMAT PARQUET)`,
    );
    const digest = new RowDigest(spec.columns);
    const read = (await db.all(
      `SELECT * FROM read_parquet('${file}') ORDER BY ${orderByClause(spec)}`,
    )) as Array<Record<string, unknown>>;
    for (const row of read) digest.add(spec.columns.map((c) => row[c.name]));
    tables[spec.name] = { rows: digest.rows, rowDigest: digest.hex() };
  }
  const band: ParquetL2Band = {
    version: 1,
    schema: 'l2-1',
    heightRange: [from, to],
    selection: SELECTION,
    tables,
    lookups: await writeBandLookups(db, staging),
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const id = l2BandId(band, bandPublisherTag(PUBLISHER));
  tamper.band?.(band);
  await fs.writeFile(path.join(staging, BAND_FILE), serializeBandFile(band));
  const dir = path.join(parent, id);
  await fs.rename(staging, dir);
  return { dir, id, band };
}

describe('verifyL2Bands', () => {
  let db: Database;
  let root: string;
  const fresh = async () => fs.mkdtemp(path.join(root, 'set-'));
  const failing = (result: Awaited<ReturnType<typeof verifyL2Bands>>) =>
    result.checks.filter((c) => !c.ok).map((c) => c.name);

  before(async () => {
    db = await Database.create(':memory:');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-verify-'));
  });
  after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('passes a sound set of bands, every check', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    await writeBand(db, dir, 200, 299);
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.deepEqual(failing(result), []);
    assert.equal(result.ok, true);
    assert.equal(result.bands, 2);
    assert.equal(result.items, 4);
    assert.deepEqual(result.heightRange, [100, 299]);
  });

  it("reads an installed band's directory (id~generation) as its id", async () => {
    const dir = await fresh();
    const { dir: band, id } = await writeBand(db, dir, 100, 199);
    await fs.rename(band, path.join(dir, `${id}~abc123def456`));
    assert.equal(
      (await verifyL2Bands(db, dir, { publisher: PUBLISHER })).ok,
      true,
    );
  });

  it('fails identity when band.json no longer matches the id it was published under', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      band: (b) => {
        b.tables.data_items.rows += 1;
      },
    });
    assert.ok(failing(await verifyL2Bands(db, dir)).includes('identity'));
  });

  it("fails identity for another publisher's band when the publisher is given", async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const result = await verifyL2Bands(db, dir, { publisher: 'someone-else' });
    assert.deepEqual(failing(result), ['identity']);
  });

  it('fails tables when a table is not in its order', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, { unsorted: 'data_items' });
    assert.ok(failing(await verifyL2Bands(db, dir)).includes('tables'));
  });

  it("fails tables when an owner's key does not hash to its address", async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.wallets[0][1] = Buffer.alloc(512, 9);
      },
    });
    assert.ok(failing(await verifyL2Bands(db, dir)).includes('tables'));
  });

  it('fails locations for a partial location, a bad layout, or a wrong data_size', async () => {
    const cases: Array<(r: Record<string, unknown[][]>) => void> = [
      (r) => {
        r.data_items[0][13 + DATA_ITEM_LOCATION_COLUMNS.indexOf('size')] = null;
      },
      (r) => {
        r.data_items[0][
          13 + DATA_ITEM_LOCATION_COLUMNS.indexOf('signature_offset')
        ] = 7;
      },
      (r) => {
        r.data_items[0][9] = 999; // data_size
      },
    ];
    for (const edit of cases) {
      const dir = await fresh();
      await writeBand(db, dir, 100, 199, { rows: edit });
      assert.deepEqual(failing(await verifyL2Bands(db, dir)), ['locations']);
    }
  });

  it('fails parents when a nested bundle is not described where the item says', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.parents = [];
      },
    });
    assert.deepEqual(failing(await verifyL2Bands(db, dir)), ['parents']);
  });

  it('fails lookups when a lookup file does not hold what its tables give', async () => {
    const dir = await fresh();
    const { dir: band } = await writeBand(db, dir, 100, 199);
    // Replace the id lookup with one derived from nothing.
    await db.exec(
      `COPY (SELECT * FROM read_parquet('${path.join(band, 'lookup_id.parquet')}') LIMIT 0) TO '${path.join(band, 'lookup_id.parquet')}.tmp' (FORMAT PARQUET)`,
    );
    await fs.rename(
      path.join(band, 'lookup_id.parquet.tmp'),
      path.join(band, 'lookup_id.parquet'),
    );
    assert.deepEqual(failing(await verifyL2Bands(db, dir)), ['lookups']);
  });

  it('refuses a set whose bands overlap or leave a hole', async () => {
    const overlap = await fresh();
    await writeBand(db, overlap, 100, 199);
    await writeBand(db, overlap, 150, 249);
    await assert.rejects(
      verifyL2Bands(db, overlap),
      (e: unknown) =>
        e instanceof L2BandsRefused && /overlap/.test((e as Error).message),
    );
    const hole = await fresh();
    await writeBand(db, hole, 100, 199);
    await writeBand(db, hole, 300, 399);
    await assert.rejects(verifyL2Bands(db, hole), /nothing covers height 200/);
  });

  it('checks only the bands inside --from/--to', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    await writeBand(db, dir, 300, 399);
    const result = await verifyL2Bands(db, dir, { from: 300 });
    assert.equal(result.bands, 1);
    assert.equal(result.ok, true);
  });

  it('reads sampled headers at root_parent_offset + offset, and fails a band whose headers are not its items', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    // Every read answers an Arweave-signed header with a random signature:
    // its SHA-256 is never the item's id, so every item read is wrong.
    const reads: number[] = [];
    const openRoot: RootSourceFactory = () => ({
      read: async (offset: number, size: number) => {
        reads.push(offset);
        const header = Buffer.alloc(size);
        header.writeUInt16LE(1, 0);
        crypto.randomBytes(512).copy(header, 2);
        return header;
      },
      close: async () => undefined,
      isOpen: () => true,
    });
    const result = await verifyL2Bands(db, dir, {
      onchain: { perBand: 2, openRoot },
    });
    assert.deepEqual(failing(result), ['onchain']);
    assert.equal(result.onchain?.wrong, 2);
    // Read at each item's place in the root: 0 + 0 for the item directly in
    // it, 3500 + 0 for the one in the nested bundle.
    assert.deepEqual(
      [...new Set(reads)].sort((x, y) => x - y),
      [0, 3500],
    );
  });

  it('counts a payload that starts past its item as a bad layout, not a crash', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        // offset + size - data_offset would underflow an unsigned 64-bit.
        r.data_items[0][LOC('data_offset')] = 99_999;
      },
    });
    assert.deepEqual(failing(await verifyL2Bands(db, dir)), ['locations']);
  });

  it('fails parents for a nested bundle whose payload does not start inside it', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        // Still where the item says its payload starts (0 + 3500), but the
        // bundle's own header would begin after it: another copy's offsets.
        r.parents[0][3] = 5000;
      },
    });
    const result = await verifyL2Bands(db, dir);
    assert.deepEqual(failing(result), ['parents']);
    assert.match(
      result.checks.find((c) => c.name === 'parents')!.failures![0].found,
      /payload does not start inside them/,
    );
  });

  it("leaves out a band its publisher's newer band replaces, and only its own", async () => {
    const dir = await fresh();
    const old = await writeBand(db, dir, 100, 199);
    const next = await writeBand(db, dir, 100, 249, {
      rows: (r) => {
        r.tags[0][4] = Buffer.from('ArDrive-Next');
      },
    });
    await fs.writeFile(
      path.join(next.dir, '.publisher.json'),
      JSON.stringify({ supersedes: [old.id] }),
    );
    const result = await verifyL2Bands(db, dir);
    assert.equal(result.ok, true);
    assert.equal(result.bands, 1);
    assert.deepEqual(result.superseded, [old.id]);

    // A claim on another publisher's band is no claim: the set overlaps.
    const foreign = await fresh();
    const theirs = await writeBand(db, foreign, 100, 199);
    const otherTag = theirs.id.replace(
      `-${bandPublisherTag(PUBLISHER)}-`,
      '-0badc0de-',
    );
    await fs.rename(theirs.dir, path.join(foreign, otherTag));
    const ours = await writeBand(db, foreign, 100, 249, {
      rows: (r) => {
        r.tags[0][4] = Buffer.from('ArDrive-Next');
      },
    });
    await fs.writeFile(
      path.join(ours.dir, '.publisher.json'),
      JSON.stringify({ supersedes: [otherTag] }),
    );
    await assert.rejects(verifyL2Bands(db, foreign), /overlap/);
  });

  it('samples nested items however rare, repeatably by seed', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        // 200 more items directly in the root, beside one nested item.
        const direct = r.data_items[0];
        for (let i = 0; i < 200; i += 1) {
          const copy = [...direct];
          copy[0] = hash(`direct-${i}`);
          r.data_items.push(copy);
        }
      },
    });
    const run = async (seed: number) => {
      const reads: number[] = [];
      const result = await verifyL2Bands(db, dir, {
        lookups: false,
        onchain: { perBand: 2, openRoot: strangerHeaders(reads), seed },
      });
      return { reads, result };
    };
    const first = await run(7);
    // perBand 2: one direct, one nested, never two direct.
    assert.ok(first.reads.includes(3500));
    assert.equal(first.result.onchain?.seed, 7);
    const again = await run(7);
    assert.deepEqual(
      [...new Set(again.reads)].sort((x, y) => x - y),
      [...new Set(first.reads)].sort((x, y) => x - y),
    );
  });

  it('reads past a missing chunk to the rest of its root', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    // Both items share a root; the nested one's chunk is gone. Its 404 is
    // its own: the item directly in the root is still read.
    const reads: number[] = [];
    const result = await verifyL2Bands(db, dir, {
      onchain: {
        perBand: 2,
        openRoot: strangerHeaders(reads, (offset) =>
          offset === 3500
            ? Object.assign(new Error('gone'), {
                response: { status: 404 },
                wholeRoot: false,
              })
            : undefined,
        ),
      },
    });
    assert.deepEqual(
      [...new Set(reads)].sort((x, y) => x - y),
      [0, 3500],
    );
    assert.equal(result.onchain?.unreadable, 1);
    assert.equal(result.onchain?.wrong, 1);
  });

  it('passes a band with items but no locations, with nothing to read on chain', async () => {
    const dir = await fresh();
    const { id } = await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        for (const row of r.data_items) {
          for (const name of DATA_ITEM_LOCATION_COLUMNS) row[LOC(name)] = null;
        }
        r.parents = [];
      },
    });
    const reads: number[] = [];
    const result = await verifyL2Bands(db, dir, {
      onchain: { perBand: 2, openRoot: strangerHeaders(reads) },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.onchain?.unlocatedBands, [id]);
    assert.equal(reads.length, 0);
  });
});
