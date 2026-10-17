/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { default as request } from 'supertest';
import {
  DataItem,
  SolanaSigner,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
// @ts-expect-error bs58 v4 has no type declarations
import bs58 from 'bs58';

import { RootParentDataSource } from './root-parent-data-source.js';
import { Ans104OffsetSource } from './ans104-offset-source.js';
import { ReadThroughDataCache } from './read-through-data-cache.js';
import { CompositeRootTxIndex } from '../discovery/composite-root-tx-index.js';
import { Cdb64RootTxIndex } from '../discovery/cdb64-root-tx-index.js';
import { Cdb64Writer } from '../lib/cdb64.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { fromB64Url } from '../lib/encoding.js';
import { FsDataStore } from '../store/fs-data-store.js';
import { makeContiguousMetadataStore } from '../init/metadata-store.js';
import { createRawDataHandler } from '../routes/data/handlers.js';
import { RAW_DATA_PATH_REGEX } from '../constants.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataAttributesStore,
  ContiguousDataSource,
  Region,
} from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

/**
 * A gateway that has not indexed `payload`'s data item: the real HTTP handler,
 * read-through cache, root parent source, ANS-104 header parser and a CDB64
 * index that places the item, signed with `Content-Encoding: gzip`, in an L1
 * bundle. Only the chain itself is in memory.
 */
const serveBundledItem = async ({
  log,
  tempDir,
  payload,
  attributes,
  L1,
}: {
  log: ReturnType<typeof createTestLogger>;
  tempDir: string;
  payload: Buffer;
  attributes: Map<string, ContiguousDataAttributes>;
  L1: string;
}): Promise<{
  app: express.Express;
  item: DataItem;
  cdb: Cdb64RootTxIndex;
}> => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signer = new SolanaSigner(bs58.encode(Buffer.concat([seed, pub])));

  const item = createData(payload, signer, {
    tags: [
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Content-Encoding', value: 'gzip' },
    ],
  });
  const other = createData('another item', signer);
  const bundle = await bundleAndSignData([item, other], signer);
  const l1Bytes = bundle.getRaw();

  // First of two items: its header starts after the count and two index
  // entries.
  const itemOffset = 32 + 64 * 2;
  const itemSize = item.getRaw().length;
  const dataOffset = itemOffset + itemSize - payload.length;

  // A CDB64 index places the item in the L1 bundle; nothing indexes its tags.
  const cdbPath = path.join(tempDir, 'index.cdb');
  const writer = new Cdb64Writer(cdbPath);
  await writer.open();
  await writer.add(
    fromB64Url(item.id),
    encodeCdb64Value({
      rootTxId: fromB64Url(L1),
      rootDataItemOffset: itemOffset,
      rootDataOffset: dataOffset,
      dataItemSize: itemSize,
    }),
  );
  await writer.finalize();
  const cdb = new Cdb64RootTxIndex({ log, sources: [cdbPath], watch: false });

  // The chain: only the L1 transaction can be read, as with chunks.
  const chain: ContiguousDataSource = {
    async getData({
      id,
      region,
    }: {
      id: string;
      region?: Region;
    }): Promise<ContiguousData> {
      if (id !== L1) {
        throw new Error(`Request failed with status code 404 (${id})`);
      }
      const start = region?.offset ?? 0;
      const bytes = l1Bytes.subarray(
        start,
        region?.size !== undefined ? start + region.size : undefined,
      );
      return {
        stream: Readable.from([bytes]),
        size: bytes.length,
        verified: true,
        trusted: true,
        cached: false,
      };
    },
  };

  // The gateway's attribute store, empty for this item: no indexed tags.
  const store: ContiguousDataAttributesStore = {
    async getDataAttributes(id: string) {
      return attributes.get(id);
    },
    async setDataAttributes(id: string, update: any) {
      attributes.set(id, { ...(attributes.get(id) ?? {}), ...update });
    },
  } as ContiguousDataAttributesStore;

  const rootParent = new RootParentDataSource({
    log,
    dataSource: chain,
    dataAttributesStore: store,
    dataItemRootTxIndex: new CompositeRootTxIndex({ log, indexes: [cdb] }),
    ans104OffsetSource: new Ans104OffsetSource({ log, dataSource: chain }),
  });

  const cache = new ReadThroughDataCache({
    log,
    dataSource: rootParent,
    dataStore: new FsDataStore({ log, baseDir: path.join(tempDir, 'data') }),
    metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
    contiguousDataIndex: {
      getDataAttributes: async () => undefined,
      getDataParent: async () => undefined,
    } as any,
    dataAttributesStore: store,
    dataContentAttributeImporter: {
      queueDataContentAttributes: () => {},
    } as any,
  });

  const app = express();
  // The route the app registers, so the handler finds the ID where it looks.
  app.get(
    RAW_DATA_PATH_REGEX,
    createRawDataHandler({
      log,
      dataAttributesSource: store,
      dataSource: cache,
      dataBlockListValidator: {
        isIdBlocked: async () => false,
        isHashBlocked: async () => false,
      },
    }),
  );

  return { app, item, cdb };
};

/**
 * End to end over HTTP: a gzip-compressed page uploaded as a data item tagged
 * `Content-Encoding: gzip`, requested from a gateway that has not indexed it
 * (it does not unbundle its bundle). The gateway finds it through a CDB64
 * index, reads the item's signed header to serve it, and must label the
 * response `Content-Encoding: gzip` so browsers decode it, on the first
 * request and on cache hits after it, without any index of the item's tags.
 *
 * Every component on the path is real except storage of the chain itself:
 * the HTTP handler, the read-through cache writing to disk, the root parent
 * source, the ANS-104 header parser and a CDB64 index file.
 */
describe('bundled gzip-encoded item served by a gateway that has not indexed it', () => {
  const log = createTestLogger({ suite: 'bundled-content-encoding' });
  const L1 = randomBytes(32).toString('base64url');
  const PAGE = Buffer.from(
    `<!doctype html><title>compressed on chain</title>${'<p>hi</p>'.repeat(200)}`,
  );
  const PAYLOAD = gzipSync(PAGE);

  let tempDir: string;
  let item: DataItem;
  let app: express.Express;
  let cdb: Cdb64RootTxIndex;
  const attributes = new Map<string, ContiguousDataAttributes>();

  const bufferBody = (res: any, callback: any) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-encoding-'));
    ({ app, item, cdb } = await serveBundledItem({
      log,
      tempDir,
      payload: PAYLOAD,
      attributes,
      L1,
    }));
  });

  after(async () => {
    await cdb.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('labels the first response, served from the chain', async () => {
    const res = await request(app)
      .get(`/raw/${item.id}`)
      .buffer(true)
      .parse(bufferBody)
      .expect(200);

    assert.equal(res.headers['x-cache'], 'MISS');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['content-length'], String(PAYLOAD.length));
    // The client decoded it, which fails unless the header fits the bytes.
    assert.deepEqual(res.body, PAGE);
  });

  it('labels a cache hit after it', async () => {
    await settle();

    const res = await request(app)
      .get(`/raw/${item.id}`)
      .buffer(true)
      .parse(bufferBody)
      .expect(200);

    assert.equal(res.headers['x-cache'], 'HIT');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.deepEqual(res.body, PAGE);
  });

  it('reports the compressed length on HEAD', async () => {
    const res = await request(app).head(`/raw/${item.id}`).expect(200);

    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['content-length'], String(PAYLOAD.length));
  });

  it('serves ranges of the compressed bytes, still labelled', async () => {
    const res = await request(app)
      .get(`/raw/${item.id}`)
      .set('Range', 'bytes=0-9')
      // Take the raw slice: a 10-byte piece of a gzip stream cannot be decoded.
      .set('Accept-Encoding', 'identity')
      .buffer(true)
      .parse((res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.removeAllListeners('data');
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .catch((error: any) => error.response ?? Promise.reject(error));

    assert.equal(res.status, 206);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['content-range'], `bytes 0-9/${PAYLOAD.length}`);
    assert.ok(gunzipSync(PAYLOAD).equals(PAGE));
  });
});

/**
 * The same path for an item whose `Content-Encoding: gzip` tag is false: its
 * signed bytes are plain (a manifest uploaded this way exists on mainnet).
 * Labelling it gzip makes every decoding client fail, and makes a gateway
 * that checks the coding's magic reject our copy, so it is served unlabelled.
 */
describe('bundled item tagged gzip whose bytes are plain', () => {
  const log = createTestLogger({ suite: 'bundled-content-encoding' });
  const L1 = randomBytes(32).toString('base64url');
  const PAYLOAD = Buffer.from(
    JSON.stringify({ manifest: 'arweave/paths', version: '0.2.0', paths: {} }),
  );

  let tempDir: string;
  let item: DataItem;
  let app: express.Express;
  let cdb: Cdb64RootTxIndex;
  const attributes = new Map<string, ContiguousDataAttributes>();

  // Keeps the bytes as sent: superagent would otherwise try to decode them.
  const rawBody = (res: any, callback: any) => {
    const chunks: Buffer[] = [];
    res.removeAllListeners('data');
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  };
  const get = (range?: string) => {
    const req = request(app)
      .get(`/raw/${item.id}`)
      .set('Accept-Encoding', 'identity');
    if (range !== undefined) {
      req.set('Range', range);
    }
    return req.buffer(true).parse(rawBody);
  };

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-plain-'));
    ({ app, item, cdb } = await serveBundledItem({
      log,
      tempDir,
      payload: PAYLOAD,
      attributes,
      L1,
    }));
  });

  after(async () => {
    await cdb.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves the first response, from the chain, unlabelled', async () => {
    const res = await get().expect(200);

    assert.equal(res.headers['x-cache'], 'MISS');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], String(PAYLOAD.length));
    assert.deepEqual(res.body, PAYLOAD);
  });

  it('serves a cache hit after it unlabelled', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await get().expect(200);

    assert.equal(res.headers['x-cache'], 'HIT');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.deepEqual(res.body, PAYLOAD);
  });

  it('answers HEAD unlabelled', async () => {
    const res = await request(app).head(`/raw/${item.id}`).expect(200);

    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], String(PAYLOAD.length));
  });

  it('serves ranges unlabelled, including ones past the first byte', async () => {
    for (const [range, start, end] of [
      ['bytes=0-9', 0, 9],
      ['bytes=5-14', 5, 14],
    ] as const) {
      const res = await get(range);

      assert.equal(res.status, 206, range);
      assert.equal(res.headers['content-encoding'], undefined, range);
      assert.deepEqual(res.body, PAYLOAD.subarray(start, end + 1), range);
    }
  });
});
