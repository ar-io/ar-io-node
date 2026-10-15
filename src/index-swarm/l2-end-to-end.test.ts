/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * L2 bands, from a publisher into a subscribing gateway's sidecar, over the
 * real /ar-io/indexes routes, with nothing standing in for anything but the
 * chain's gateway registry.
 *
 * The band is written here by hand rather than by `index-export`'s builder
 * (`src/index-export/kinds/parquet-l2/`, whose own tests check the bands it
 * writes pass this kind's checks), so that it can hold the cases this test
 * is about: a few data items of one selection, among them an item in
 * a nested bundle, one at two places in its root and one whose place is
 * unknown, each table in the layout's order and digested as an importer
 * reads it back. One gateway's sidecar publishes it as an index configured
 * with only a name and a kind; a second's subscribes and installs it, and
 * the rows it holds reproduce the band's digests.
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Database } from 'duckdb-async';
import express from 'express';

import { bandPublisherTag } from '../lib/index-band/build.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import { IndexPublication } from '../lib/index-publication.js';
import { openFooterReader } from '../lib/parquet/check.js';
import { RowDigest } from '../lib/parquet/digest.js';
import type { TableSpec } from '../lib/parquet-l1/layout.js';
import {
  BAND_FILE,
  bandFiles,
  DATA_ITEM_LOCATION_COLUMNS,
  l2BandId,
  orderByClause,
  PARQUET_L2_TABLES,
  ParquetL2Band,
  ParquetL2Selection,
  parseBandFile,
  serializeBandFile,
} from '../lib/parquet-l2/layout.js';
import { sha256File } from '../lib/sha256-file.js';
import { createIndexesRouter } from '../routes/indexes.js';
import { createTestLogger } from '../../test/test-logger.js';
import { PublishConfig } from './config.js';
import { createKindRegistry } from './kinds/registry.js';
import { subscriptionTotal } from './metrics.js';
import { Publisher } from './publisher.js';
import { StateStore } from './state.js';
import { GENERATION_SEPARATOR, Subscriber } from './subscriber.js';

const log = createTestLogger({ suite: 'L2 bands end to end' });

/** The band's heights: a tip band on the L1 grid. */
const FIRST = 1_900_000;
const BAND_TO = FIRST + 29;
const INDEX = 'ardrive-l2';
const SELECTION: ParquetL2Selection = {
  kind: 'ans104-data-items',
  tag: { name: 'App-Name', valuePrefix: 'ArDrive' },
};

const hash = (label: string) =>
  crypto.createHash('sha256').update(label).digest();

/** A value as a typed DuckDB literal. */
function literal(value: unknown, type: string): string {
  if (value === null) return `NULL::${type}`;
  if (Buffer.isBuffer(value)) return `from_hex('${value.toString('hex')}')`;
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'::${type}`;
  }
  return `${String(value)}::${type}`;
}

/** A table's rows and row digest, read back in the layout's order. */
async function digestTable(
  db: Database,
  file: string,
  spec: TableSpec,
): Promise<{ rows: number; rowDigest: string }> {
  const digest = new RowDigest(spec.columns);
  const rows = (await db.all(
    `SELECT * FROM read_parquet('${file}') ORDER BY ${orderByClause(spec)}`,
  )) as Array<Record<string, unknown>>;
  for (const row of rows) digest.add(spec.columns.map((c) => row[c.name]));
  return { rows: digest.rows, rowDigest: digest.hex() };
}

/**
 * The band's rows, in the layout's column order: four data items of the
 * selection, in two roots.
 */
function bandRows(): Record<string, unknown[][]> {
  const [root1, root2, nested] = ['root-1', 'root-2', 'nested'].map(hash);
  const [a, b, c, d] = ['item-a', 'item-b', 'item-c', 'item-d'].map(hash);
  const key1 = Buffer.concat([hash('key-1'), Buffer.alloc(480, 1)]);
  const key2 = Buffer.concat([hash('key-2'), Buffer.alloc(480, 2)]);
  const [owner1, owner2] = [key1, key2].map((key) =>
    crypto.createHash('sha256').update(key).digest(),
  );
  // An item's place: offsets into its parent's payload, which starts at
  // `rootParentOffset` in the root. An Arweave-signed item: a 2-byte
  // signature type, a 512-byte signature, then the 512-byte owner.
  const at = (rootParentOffset: number, offset: number, size: number) => [
    rootParentOffset,
    offset,
    size,
    offset + 1100,
    offset + 514,
    512,
    offset + 2,
    512,
  ];
  const nowhere = DATA_ITEM_LOCATION_COLUMNS.map(() => null);
  // The nested bundle (in `parents`) sits directly in root 1, so at a
  // root_parent_offset of 0, and its payload starts at its data_offset.
  const nestedPayload = 0 + 3500;
  const item = (
    id: Buffer,
    height: number,
    index: number,
    root: Buffer,
    parent: Buffer,
    owner: Buffer,
    tags: { count: number; contentType?: string; contentEncoding?: string },
    place: unknown[],
  ) => [
    id,
    height,
    index,
    root,
    parent,
    owner,
    null,
    hash(`anchor-${id.toString('hex')}`),
    1,
    10,
    tags.contentType ?? null,
    tags.contentEncoding ?? null,
    tags.count,
    ...place,
  ];
  const tag = (
    height: number,
    id: Buffer,
    index: number,
    name: string,
    value: string,
  ) => [height, id, index, Buffer.from(name), Buffer.from(value)];
  return {
    data_items: [
      item(
        a,
        FIRST + 1,
        0,
        root1,
        root1,
        owner1,
        { count: 2, contentType: 'application/json' },
        at(0, 0, 1200),
      ),
      item(
        b,
        FIRST + 1,
        0,
        root1,
        nested,
        owner1,
        { count: 1 },
        at(nestedPayload, 0, 1300),
      ),
      // At two places in its root: a row for each.
      item(
        d,
        FIRST + 1,
        0,
        root1,
        root1,
        owner2,
        { count: 1 },
        at(0, 9000, 1200),
      ),
      item(
        d,
        FIRST + 1,
        0,
        root1,
        root1,
        owner2,
        { count: 1 },
        at(0, 5000, 1200),
      ),
      // Known to be in root 2, but not where.
      item(
        c,
        FIRST + 2,
        3,
        root2,
        root2,
        owner2,
        { count: 3, contentType: 'text/html', contentEncoding: 'gzip' },
        nowhere,
      ),
    ],
    tags: [
      tag(FIRST + 1, a, 0, 'App-Name', 'ArDrive-App'),
      tag(FIRST + 1, a, 1, 'Content-Type', 'application/json'),
      tag(FIRST + 1, b, 0, 'App-Name', 'ArDrive-Web'),
      tag(FIRST + 1, d, 0, 'App-Name', 'ArDrive-CLI'),
      tag(FIRST + 2, c, 0, 'App-Name', 'ArDrive-Sync'),
      tag(FIRST + 2, c, 1, 'Content-Type', 'text/html'),
      tag(FIRST + 2, c, 2, 'Content-Encoding', 'gzip'),
    ],
    wallets: [
      [owner1, key1],
      [owner2, key2],
    ],
    parents: [[nested, root1, 0, 2400, 4000, 3500]],
  };
}

/** Writes the band into `dir`, as a builder must, and describes it. */
async function writeBand(dir: string): Promise<ParquetL2Band> {
  await fs.mkdir(dir, { recursive: true });
  const rows = bandRows();
  const tables: ParquetL2Band['tables'] = {};
  const db = await openFooterReader();
  try {
    for (const spec of PARQUET_L2_TABLES) {
      const file = path.join(dir, spec.file);
      const values = rows[spec.name]
        .map(
          (row) =>
            `(${row.map((v, i) => literal(v, spec.columns[i].type)).join(', ')})`,
        )
        .join(', ');
      const names = spec.columns.map((c) => `"${c.name}"`).join(', ');
      await db.exec(
        `COPY (SELECT * FROM (VALUES ${values}) v(${names}) ORDER BY ${orderByClause(spec)}) TO '${file}' (FORMAT PARQUET)`,
      );
      tables[spec.name] = await digestTable(db, file, spec);
    }
  } finally {
    await db.close();
  }
  const band: ParquetL2Band = {
    version: 1,
    schema: 'l2-1',
    heightRange: [FIRST, BAND_TO],
    selection: SELECTION,
    tables,
    createdAt: '2026-10-14T00:00:00.000Z',
  };
  await fs.writeFile(path.join(dir, BAND_FILE), serializeBandFile(band));
  return band;
}

describe('L2 bands, from a publisher into a subscribing gateway', () => {
  let tempDir: string;
  let server: http.Server;
  let origin: string;
  let publishedDir: string;
  let band: ParquetL2Band;
  let bandId: string;
  let walletAddress: string;
  let observerAddress: string;
  let observer: crypto.KeyPairKeyObjectResult;

  const publish = (entry: PublishConfig) =>
    new Publisher({
      log,
      state: new StateStore({
        log,
        filePath: path.join(tempDir, 'gateway-a', 'indexes', 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      signer: {
        privateKey: observer.privateKey,
        keyId: observerAddress,
        wallet: walletAddress,
      },
      publish: [entry],
      publishedDir,
      blobsDir: path.join(publishedDir, 'blobs'),
      publicationFile: path.join(publishedDir, 'publication.json'),
      ttlMs: 86_400_000,
      supersedeGraceMs: 0,
    }).scanOnce();

  /** A gateway's sidecar, subscribed to the index; returns its installed bands. */
  const subscribe = async (gateway: string): Promise<string> => {
    await new Subscriber({
      log,
      state: new StateStore({
        log,
        filePath: path.join(tempDir, gateway, 'indexes', 'state.json'),
      }),
      kinds: createKindRegistry({ log }),
      registry: {
        lookup: async (w) =>
          w === walletAddress
            ? { wallet: w, observerAddress, url: origin, status: 'joined' }
            : undefined,
      },
      subscribe: [{ publisher: walletAddress, name: INDEX }],
      trustedPublishers: [],
      incomingDir: path.join(tempDir, gateway, 'indexes', 'incoming'),
      installedDir: path.join(tempDir, gateway, 'indexes', 'installed'),
      fetchTimeoutMs: 10_000,
      downloadConcurrency: 4,
      supersedeGraceMs: 0,
    }).pollOnce();
    return path.join(tempDir, gateway, 'indexes', 'installed', INDEX);
  };

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-e2e-'));
    publishedDir = path.join(tempDir, 'gateway-a', 'indexes', 'published');
    const wallet = crypto.generateKeyPairSync('ed25519');
    observer = crypto.generateKeyPairSync('ed25519');
    walletAddress = getSolanaAddress(wallet.publicKey);
    observerAddress = getSolanaAddress(observer.publicKey);

    // --- Gateway A builds a band and publishes it, by name and kind alone. ---
    const work = path.join(tempDir, 'work', 'band');
    band = await writeBand(work);
    bandId = l2BandId(band, bandPublisherTag(walletAddress));
    await fs.mkdir(path.join(publishedDir, INDEX), { recursive: true });
    await fs.rename(work, path.join(publishedDir, INDEX, bandId));
    await publish({ name: INDEX, kind: 'parquet-l2' });

    const app = express();
    app.use(createIndexesRouter({ log, publishedDir }));
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('offers the band with its selection in the signed publication', async () => {
    const document = JSON.parse(
      await fs.readFile(path.join(publishedDir, 'publication.json'), 'utf8'),
    ) as IndexPublication;
    const [index] = document.indexes;
    assert.equal(index.name, INDEX);
    assert.equal(index.kind, 'parquet-l2');
    assert.equal(index.filter, undefined);
    assert.equal(index.bands.length, 1);
    const [offered] = index.bands;
    assert.equal(offered.id, bandId);
    assert.deepEqual(offered.heightRange, [FIRST, BAND_TO]);
    assert.equal(offered.records, 5);
    assert.deepEqual(offered.metadata, {
      schema: 'l2-1',
      selection: SELECTION,
    });
  });

  it('installs the band under the name the sidecar gives it, byte for byte', async () => {
    const installed = await subscribe('gateway-b');
    const names = await fs.readdir(installed);
    assert.equal(names.length, 1);
    assert.ok(
      names[0].startsWith(`${bandId}${GENERATION_SEPARATOR}`),
      names[0],
    );
    const dir = path.join(installed, names[0]);
    assert.deepEqual((await fs.readdir(dir)).sort(), bandFiles('l2-1'));
    for (const name of bandFiles('l2-1')) {
      assert.equal(
        await sha256File(path.join(dir, name)),
        await sha256File(path.join(publishedDir, INDEX, bandId, name)),
        name,
      );
    }

    // What an importer reads back reproduces the band's digests, and keeps
    // the layout's rules: every place whole or absent.
    const declared = parseBandFile(
      await fs.readFile(path.join(dir, BAND_FILE), 'utf8'),
    );
    assert.deepEqual(declared, band);
    const db = await openFooterReader();
    try {
      for (const spec of PARQUET_L2_TABLES) {
        assert.deepEqual(
          await digestTable(db, path.join(dir, spec.file), spec),
          declared.tables[spec.name],
          spec.name,
        );
      }
      const all = (test: string) =>
        DATA_ITEM_LOCATION_COLUMNS.map((c) => `"${c}" ${test}`).join(' AND ');
      const [partial] = (await db.all(
        `SELECT COUNT(*) AS n FROM read_parquet('${path.join(dir, 'data_items.parquet')}')
         WHERE NOT ((${all('IS NULL')}) OR (${all('IS NOT NULL')}))`,
      )) as Array<{ n: bigint | number }>;
      assert.equal(Number(partial.n), 0);
    } finally {
      await db.close();
    }
  });

  it('takes nothing from an index whose filter selects other items than its bands', async () => {
    const refused = async () =>
      (await subscriptionTotal.get()).values
        .filter(
          (v) =>
            v.labels.publisher === walletAddress &&
            v.labels.index === INDEX &&
            v.labels.result === 'verify_failed',
        )
        .reduce((sum, v) => sum + v.value, 0);
    const before = await refused();
    await publish({
      name: INDEX,
      kind: 'parquet-l2',
      filter: {
        kind: 'ans104-data-items',
        tag: {
          name: 'App-Name',
          valuePrefix: 'ArDrive',
          excludeValuePrefix: 'ArDrive-Test',
        },
      },
    });
    const installed = await subscribe('gateway-c');
    assert.deepEqual(await fs.readdir(installed).catch(() => []), []);
    // Refused by the kind once its files were in, not lost on the way.
    assert.equal(await refused(), before + 1);
  });

  it('takes the band from an index whose filter is its selection', async () => {
    await publish({ name: INDEX, kind: 'parquet-l2', filter: SELECTION });
    const installed = await subscribe('gateway-d');
    assert.equal((await fs.readdir(installed)).length, 1);
  });
});
