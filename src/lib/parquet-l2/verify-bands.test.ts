/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Database } from 'duckdb-async';

import { bandPublisherTag } from '../index-band/build.js';
import type { RootSourceFactory } from '../index-band/verify.js';
import { getSolanaAddress } from '../httpsig.js';
import {
  type IndexPublication,
  serializeIndexPublication,
  signIndexPublication,
} from '../index-publication.js';
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
import { writeL1Band } from '../../../test/parquet-l2-fixture.js';
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
  /** Names the band for this publisher instead of PUBLISHER. */
  publisher?: string;
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
  const id = l2BandId(band, bandPublisherTag(tamper.publisher ?? PUBLISHER));
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
        // 200 more items directly in the root, beside one nested item, each
        // at its own offset, so which were read tells samples apart.
        const direct = r.data_items[0];
        for (let i = 0; i < 200; i += 1) {
          const copy = [...direct];
          copy[0] = hash(`direct-${i}`);
          const off = 10_000 * (i + 1);
          copy.splice(
            LOC('root_parent_offset'),
            8,
            0,
            off,
            1200,
            off + 1100,
            off + 514,
            512,
            off + 2,
            512,
          );
          r.data_items.push(copy);
          r.tags.push([
            101,
            copy[0],
            0,
            Buffer.from('App-Name'),
            Buffer.from('ArDrive-App'),
          ]);
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
    // Another seed draws another sample (of 201 direct items, almost surely).
    const other = await run(8);
    assert.notDeepEqual(
      [...new Set(other.reads)].sort((x, y) => x - y),
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

  it('passes a band with items but no locations, with nothing to read on chain, when allowed', async () => {
    const dir = await fresh();
    const { id } = await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        for (const row of r.data_items) {
          for (const name of DATA_ITEM_LOCATION_COLUMNS) row[LOC(name)] = null;
        }
        r.parents = [];
      },
      band: (b) => {
        b.checks = { unlocated: { no_offsets: 2 } };
      },
    });
    const reads: number[] = [];
    const result = await verifyL2Bands(db, dir, {
      allowUnlocated: true,
      onchain: { perBand: 2, openRoot: strangerHeaders(reads) },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.onchain?.unlocatedBands, [id]);
    assert.equal(reads.length, 0);
  });
});

/** A fresh Ed25519 publisher key and its registered (base58) address. */
function publisherKey(): { privateKey: crypto.KeyObject; address: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, address: getSolanaAddress(publicKey) };
}

/** A publisher wallet as the registry holds one: a base58 address. */
const WALLET = getSolanaAddress(
  crypto.generateKeyPairSync('ed25519').publicKey,
);

/** A signed publication listing these band directories as they are now. */
async function signedPublication(
  bandDirs: Array<{ dir: string; id: string }>,
  key: { privateKey: crypto.KeyObject; address: string },
  expiresAt = '2099-01-01T00:00:00Z',
  issuedAt = '2026-10-20T00:00:00Z',
): Promise<string> {
  const bands = [];
  for (const { dir, id } of bandDirs) {
    const files = [];
    for (const name of (await fs.readdir(dir))
      .filter((n) => !n.startsWith('.'))
      .sort()) {
      const bytes = await fs.readFile(path.join(dir, name));
      files.push({
        name,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
    bands.push({ id, files });
  }
  const publication: IndexPublication = {
    version: 1,
    publisher: WALLET,
    sequence: 3,
    previousManifestSha256: null,
    issuedAt,
    expiresAt,
    indexes: [{ name: 'ardrive-l2', kind: 'parquet-l2', bands }],
  };
  return serializeIndexPublication(
    signIndexPublication(publication, key.privateKey, key.address),
  );
}

/**
 * The fail-open reproductions of the index-l2-verify audits: each set of
 * bands here is wrong, and the verifier must say so (ok false, naming the
 * check), never pass it by omission.
 */
describe('verifyL2Bands fails closed', () => {
  let db: Database;
  let root: string;
  const fresh = async () => fs.mkdtemp(path.join(root, 'set-'));
  const failing = (result: Awaited<ReturnType<typeof verifyL2Bands>>) =>
    result.checks.filter((c) => !c.ok).map((c) => c.name);

  before(async () => {
    db = await Database.create(':memory:');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-verify-closed-'));
  });
  after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fails a row whose id, height, root and parent are NULL (audit S1)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.data_items.push(r.data_items[0].map(() => null));
      },
    });
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('required'), failing(result).join());
  });

  it('fails a located item whose data_size is NULL (audit S2)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.data_items[0][9] = null;
      },
    });
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('required'), failing(result).join());
  });

  it('fails a located nested item whose parent_id is NULL (audit S3)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.data_items[1][4] = null;
      },
    });
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('required'), failing(result).join());
  });

  it('fails tags of no item, outside the band, and an item the selection does not take (audit S4)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        r.tags[0][3] = Buffer.from('Evil');
        r.tags[0][4] = Buffer.from('x');
        r.tags.push([
          5000,
          hash('ghost'),
          0,
          Buffer.from('App-Name'),
          Buffer.from('ArDrive-Ghost'),
        ]);
      },
    });
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('consistency'), failing(result).join());
    assert.ok(failing(result).includes('selected'), failing(result).join());
  });

  it("fails an owner with no key the band doesn't own up to, and a wrong tag_count (audit S5)", async () => {
    for (const edit of [
      (r: Record<string, unknown[][]>) => {
        r.wallets = [];
      },
      (r: Record<string, unknown[][]>) => {
        r.data_items[0][12] = 99;
      },
    ]) {
      const dir = await fresh();
      await writeBand(db, dir, 100, 199, { rows: edit });
      const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
      assert.equal(result.ok, false);
      assert.ok(
        failing(result).includes('consistency'),
        failing(result).join(),
      );
    }
  });

  it('fails lookup files whose rows are not in their order (audit S7)', async () => {
    const dir = await fresh();
    const band = await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        // Enough distinct keys that a reversed file is out of order.
        const direct = r.data_items[0];
        for (let i = 0; i < 5; i += 1) {
          const copy = [...direct];
          copy[0] = hash(`more-${i}`);
          r.data_items.push(copy);
          r.tags.push([
            101,
            copy[0],
            0,
            Buffer.from('App-Name'),
            Buffer.from(`ArDrive-${i}`),
          ]);
        }
      },
    });
    for (const f of ['lookup_id.parquet', 'lookup_tag.parquet']) {
      const p = path.join(band.dir, f);
      const cols = (await db.all(
        `DESCRIBE SELECT * FROM read_parquet('${p}')`,
      )) as Array<{ column_name: string }>;
      await db.exec(
        `COPY (SELECT * FROM read_parquet('${p}') ORDER BY ${cols.map((c) => `"${c.column_name}" DESC`).join(', ')}) TO '${p}.x' (FORMAT PARQUET)`,
      );
      await fs.rename(`${p}.x`, p);
    }
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('lookups'), failing(result).join());
  });

  it('fails a band directory without band.json, at either end of the set (audit S8, T2)', async () => {
    for (const which of ['low', 'tip'] as const) {
      const dir = await fresh();
      const low = await writeBand(db, dir, 100, 199);
      const tip = await writeBand(db, dir, 200, 299);
      const gone = which === 'low' ? low : tip;
      await fs.rm(path.join(gone.dir, BAND_FILE));
      const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
      assert.equal(result.ok, false, which);
      const files = result.checks.find((c) => c.name === 'files');
      assert.ok(
        files?.failures?.some((f) => f.found.includes(path.basename(gone.dir))),
        JSON.stringify(result.checks),
      );
    }
  });

  it('honours no supersession claim over a band its claimant does not cover (audit S9)', async () => {
    const dir = await fresh();
    const low = await writeBand(db, dir, 100, 199);
    const tip = await writeBand(db, dir, 200, 299, {
      band: (b) => {
        b.tables.data_items.rows += 5;
      },
    });
    await fs.writeFile(
      path.join(low.dir, '.publisher.json'),
      JSON.stringify({ supersedes: [tip.id] }),
    );
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.deepEqual(result.superseded, []);
  });

  it('fails an unreadable .publisher.json rather than ignoring it', async () => {
    const dir = await fresh();
    const low = await writeBand(db, dir, 100, 199);
    await fs.writeFile(path.join(low.dir, '.publisher.json'), '{not json');
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
  });

  it('checks a band reached through a symlink (audit S10)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const elsewhere = await fresh();
    const tip = await writeBand(db, elsewhere, 200, 299, {
      band: (b) => {
        b.tables.data_items.rows += 5;
      },
    });
    await fs.symlink(tip.dir, path.join(dir, tip.id));
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.equal(result.bands, 2);
  });

  it('fails a table whose column types or columns are not the layout’s (audit S11)', async () => {
    const dir = await fresh();
    const band = await writeBand(db, dir, 100, 199);
    const p = path.join(band.dir, 'data_items.parquet');
    await db.exec(
      `COPY (SELECT * REPLACE (CAST(tag_count AS VARCHAR) AS tag_count, CAST(block_transaction_index AS BIGINT) AS block_transaction_index), 'junk' AS extra FROM read_parquet('${p}')) TO '${p}.x' (FORMAT PARQUET)`,
    );
    await fs.rename(`${p}.x`, p);
    const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('schema'), failing(result).join());
  });

  it('binds the bands to a signed publication only when given one, and fails bands it does not list (audit S12)', async () => {
    const key = publisherKey();
    const honest = await fresh();
    const original = await writeBand(db, honest, 100, 199, {
      publisher: WALLET,
    });
    const document = await signedPublication([original], key);
    // The honest band, bound.
    const bound = await verifyL2Bands(db, honest, {
      publication: { document, publisherKey: key.address },
    });
    assert.equal(bound.ok, true, JSON.stringify(bound.checks));
    assert.equal(bound.publisherBound, true);

    // Rows forged, band.json and id recomputed: internally consistent.
    const forged = await fresh();
    await writeBand(db, forged, 100, 199, {
      publisher: WALLET,
      rows: (r) => {
        r.tags[1][4] = Buffer.from('ArDrive-Forged');
      },
    });
    const unbound = await verifyL2Bands(db, forged, { publisher: WALLET });
    assert.equal(unbound.ok, true);
    assert.equal(unbound.publisherBound, false);
    assert.ok(unbound.skipped.includes('publication'));
    const refused = await verifyL2Bands(db, forged, {
      publication: { document, publisherKey: key.address },
    });
    assert.equal(refused.ok, false);
    assert.ok(failing(refused).includes('publication'));

    // Same id, a file changed: its digest is not the signed one.
    const lookup = path.join(original.dir, 'lookup_wallet.parquet');
    await fs.appendFile(lookup, Buffer.from([0]));
    const changed = await verifyL2Bands(db, honest, {
      publication: { document, publisherKey: key.address },
    });
    assert.equal(changed.ok, false);
    assert.ok(failing(changed).includes('publication'));

    // A publication signed by a key that is not the one named.
    await assert.rejects(
      verifyL2Bands(db, honest, {
        publication: { document, publisherKey: publisherKey().address },
      }),
      L2BandsRefused,
    );
  });

  it('repeats the on-chain sample exactly under one seed (audit T1)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        const direct = r.data_items[0];
        for (let i = 0; i < 200; i += 1) {
          const copy = [...direct];
          copy[0] = hash(`direct-${i}`);
          const off = 10_000 * (i + 1);
          copy.splice(
            13,
            8,
            0,
            off,
            1200,
            off + 1100,
            off + 514,
            512,
            off + 2,
            512,
          );
          r.data_items.push(copy);
          r.tags.push([
            101,
            copy[0],
            0,
            Buffer.from('App-Name'),
            Buffer.from('ArDrive-App'),
          ]);
        }
      },
    });
    const run = async () => {
      const reads: number[] = [];
      await verifyL2Bands(db, dir, {
        lookups: false,
        onchain: {
          perBand: 4,
          openRoot: strangerHeaders(reads),
          seed: 7,
          concurrency: 1,
        },
      });
      return reads.sort((a, b) => a - b).join(',');
    };
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) seen.add(await run());
    assert.equal(seen.size, 1, [...seen].join(' | '));
  });

  it('reports a band that vanishes mid-run as a failure, never a pass or a crash (audit T3)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const tip = await writeBand(db, dir, 200, 299);
    const result = await verifyL2Bands(db, dir, {
      publisher: PUBLISHER,
      // Deleted once the first band is done, before the second is read.
      progress: (done) => {
        if (done === 1) rmSync(tip.dir, { recursive: true, force: true });
      },
    });
    assert.equal(result.ok, false);
  });

  it('reports a table file deleted mid-run as a failure of its band (audit T4)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const tip = await writeBand(db, dir, 200, 299);
    const stream = db.stream.bind(db);
    (db as unknown as { stream: typeof db.stream }).stream = (
      sql: string,
      ...rest: unknown[]
    ) => {
      if (sql.includes(tip.dir) && sql.includes('tags.parquet')) {
        rmSync(path.join(tip.dir, 'tags.parquet'), { force: true });
      }
      return stream(sql, ...rest);
    };
    try {
      const result = await verifyL2Bands(db, dir, { publisher: PUBLISHER });
      assert.equal(result.ok, false);
    } finally {
      (db as unknown as { stream: typeof db.stream }).stream = stream;
    }
  });

  it('fails a band whose items are located nowhere unless told to allow it', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199, {
      rows: (r) => {
        for (const row of r.data_items) {
          for (const name of DATA_ITEM_LOCATION_COLUMNS) row[LOC(name)] = null;
        }
        r.parents = [];
      },
      band: (b) => {
        b.checks = { unlocated: { no_offsets: 2 } };
      },
    });
    const reads: number[] = [];
    const strict = await verifyL2Bands(db, dir, {
      onchain: { perBand: 2, openRoot: strangerHeaders(reads) },
    });
    assert.equal(strict.ok, false);
    assert.ok(failing(strict).includes('onchain'));
    const allowed = await verifyL2Bands(db, dir, {
      allowUnlocated: true,
      onchain: { perBand: 2, openRoot: strangerHeaders(reads) },
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.checks));
    assert.equal(reads.length, 0);
  });

  it('fails a band whose sampled roots are missing on chain (audit C, fabricated roots)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    // Every root is unknown to every node: what fabricated root ids get.
    const result = await verifyL2Bands(db, dir, {
      onchain: {
        perBand: 2,
        openRoot: strangerHeaders([], () =>
          Object.assign(new Error('gone'), {
            response: { status: 404 },
            wholeRoot: true,
          }),
        ),
      },
    });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('onchain'));
  });

  it('lists a band only partly inside --from/--to instead of dropping it silently', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const tip = await writeBand(db, dir, 200, 299);
    const result = await verifyL2Bands(db, dir, { from: 100, to: 250 });
    assert.deepEqual(result.partial, [tip.id]);
    assert.equal(result.bands, 1);
    // Heights 200-250 were asked for and are not checked.
    assert.equal(result.ok, false);
  });

  it('reports every check it did not run', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const result = await verifyL2Bands(db, dir, { lookups: false });
    assert.equal(result.ok, true);
    assert.ok(result.skipped.includes('lookups'));
    assert.ok(result.skipped.includes('onchain'));
    assert.ok(result.skipped.includes('publication'));
    assert.equal(result.publisherBound, false);
  });

  it('refuses a band id whose heights are not canonical decimals', async () => {
    const dir = await fresh();
    const band = await writeBand(db, dir, 100, 199);
    await fs.rename(
      band.dir,
      path.join(dir, band.id.replace('-h100-', '-h0100-')),
    );
    const result = await verifyL2Bands(db, dir);
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('identity'));
  });

  it('finds every root in an L1 index at the height and index its items give', async () => {
    const dir = await fresh();
    const { id } = await writeBand(db, dir, 100, 199);
    const root = hash('band-100-root');
    const at = { id: root, height: 101, blockTransactionIndex: 0 };
    const l1 = await fresh();
    await writeL1Band(l1, 100, 199, [at]);
    const found = await verifyL2Bands(db, dir, {
      l1: { bandsDir: l1, required: true },
    });
    assert.equal(found.ok, true, JSON.stringify(found.checks));
    assert.equal(found.mined?.checked, 1);
    assert.ok(!found.skipped.includes('mined'));

    // At another index of its block: not where its items say.
    const elsewhere = await fresh();
    await writeL1Band(elsewhere, 100, 199, [
      { ...at, blockTransactionIndex: 1 },
    ]);
    const moved = await verifyL2Bands(db, dir, {
      l1: { bandsDir: elsewhere, required: true },
    });
    assert.equal(moved.ok, false);
    assert.ok(failing(moved).includes('mined'));

    // Not covered: a failure when the index was named, else unchecked.
    const short = await fresh();
    await writeL1Band(short, 100, 150, [at]);
    const named = await verifyL2Bands(db, dir, {
      l1: { bandsDir: short, required: true },
    });
    assert.ok(failing(named).includes('mined'));
    const unchecked = await verifyL2Bands(db, dir, {
      l1: { bandsDir: short, required: false },
    });
    assert.equal(unchecked.ok, true);
    assert.deepEqual(unchecked.mined?.uncovered, [id]);
    assert.ok(unchecked.skipped.includes('mined'));
  });

  it('fails a band the publication lists in the range checked that the directory lacks (review 4)', async () => {
    const key = publisherKey();
    const dir = await fresh();
    const low = await writeBand(db, dir, 100, 199, { publisher: WALLET });
    const tip = await writeBand(db, dir, 200, 299, { publisher: WALLET });
    const document = await signedPublication([low, tip], key);
    await fs.rm(tip.dir, { recursive: true });
    const result = await verifyL2Bands(db, dir, {
      publication: { document, publisherKey: key.address },
    });
    assert.equal(result.ok, false);
    assert.ok(failing(result).includes('publication'));
    // Outside the range checked, it is not missed.
    const lower = await verifyL2Bands(db, dir, {
      to: 199,
      publication: { document, publisherKey: key.address },
    });
    assert.equal(lower.ok, true, JSON.stringify(lower.checks));
  });

  it('refuses an expired publication unless allowed, and reports its dates (review 5)', async () => {
    const key = publisherKey();
    const dir = await fresh();
    const band = await writeBand(db, dir, 100, 199, { publisher: WALLET });
    const document = await signedPublication(
      [band],
      key,
      '2020-01-01T00:00:00Z',
      '2019-12-31T00:00:00Z',
    );
    await assert.rejects(
      verifyL2Bands(db, dir, {
        publication: { document, publisherKey: key.address },
      }),
      /expired/,
    );
    const allowed = await verifyL2Bands(db, dir, {
      publication: { document, publisherKey: key.address, allowExpired: true },
    });
    assert.equal(allowed.publication?.expiresAt, '2020-01-01T00:00:00Z');
    assert.equal(allowed.publication?.issuedAt, '2019-12-31T00:00:00Z');
    assert.equal(allowed.publication?.expired, true);
    assert.equal(allowed.publication?.sequence, 3);
  });

  it('says in assurance when the publication key came from a registry (review 8)', async () => {
    const key = publisherKey();
    const dir = await fresh();
    const band = await writeBand(db, dir, 100, 199, { publisher: WALLET });
    const document = await signedPublication([band], key);
    const result = await verifyL2Bands(db, dir, {
      publication: {
        document,
        publisherKey: key.address,
        keyFrom: 'registry http://core:4000',
      },
    });
    assert.equal(result.publication?.keyFrom, 'registry http://core:4000');
    assert.ok(
      result.assurance.some((a) => a.includes('registry http://core:4000')),
      result.assurance.join(' | '),
    );
  });

  it('fails unlocated items its band.json does not declare, or too many of them (review 6)', async () => {
    const unlocate = (r: Record<string, unknown[][]>) => {
      for (const name of DATA_ITEM_LOCATION_COLUMNS) {
        r.data_items[0][LOC(name)] = null;
      }
    };
    const more = (r: Record<string, unknown[][]>) => {
      // 1,999 located items beside the one unlocated: a share of 0.0005.
      const direct = r.data_items[1];
      for (let i = 0; i < 1998; i += 1) {
        const copy = [...direct];
        copy[0] = hash(`more-${i}`);
        r.data_items.push(copy);
        r.tags.push([
          101,
          copy[0],
          0,
          Buffer.from('App-Name'),
          Buffer.from('ArDrive-App'),
        ]);
      }
    };
    // Undeclared: 1 unlocated, band.json says none.
    const undeclared = await fresh();
    await writeBand(db, undeclared, 100, 199, {
      rows: (r) => {
        unlocate(r);
        more(r);
      },
    });
    const a = await verifyL2Bands(db, undeclared);
    assert.equal(a.ok, false);
    assert.ok(failing(a).includes('located'), failing(a).join());
    assert.deepEqual(
      a.located.map(({ unlocated, declared }) => ({ unlocated, declared })),
      [{ unlocated: 1, declared: 0 }],
    );
    // Declared, and under the share: passes.
    const declared = await fresh();
    await writeBand(db, declared, 100, 199, {
      rows: (r) => {
        unlocate(r);
        more(r);
      },
      band: (b) => {
        b.checks = { unlocated: { no_offsets: 1 } };
      },
    });
    const b = await verifyL2Bands(db, declared);
    assert.equal(b.ok, true, JSON.stringify(b.checks));
    // Declared, but over the share (1 of 2): fails.
    const many = await fresh();
    await writeBand(db, many, 100, 199, {
      rows: unlocate,
      band: (band) => {
        band.checks = { unlocated: { no_offsets: 1 } };
      },
    });
    const c = await verifyL2Bands(db, many);
    assert.ok(failing(c).includes('located'), failing(c).join());
    const d = await verifyL2Bands(db, many, { maxUnlocatedShare: 0.6 });
    assert.equal(d.ok, true, JSON.stringify(d.checks));
  });

  it('fails a part of the requested range no band covers (review 7)', async () => {
    const dir = await fresh();
    await writeBand(db, dir, 100, 199);
    const r = await verifyL2Bands(db, dir, { from: 100, to: 250 });
    assert.equal(r.ok, false);
    assert.ok(failing(r).includes('coverage'), failing(r).join());
    const past = await verifyL2Bands(db, dir, { from: 50 });
    assert.ok(failing(past).includes('coverage'));
    const exact = await verifyL2Bands(db, dir, { from: 100, to: 199 });
    assert.equal(exact.ok, true);
  });
});
