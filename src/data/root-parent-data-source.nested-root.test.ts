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
import { CompositeRootTxIndex } from '../discovery/composite-root-tx-index.js';
import { Cdb64RootTxIndex } from '../discovery/cdb64-root-tx-index.js';
import { Cdb64Writer } from '../lib/cdb64.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { fromB64Url } from '../lib/encoding.js';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataAttributesStore,
  ContiguousDataSource,
  DataItemRootIndex,
  Region,
} from '../types.js';
import { createTestLogger } from '../../test/test-logger.js';

/**
 * End to end over real bytes (ar-io/ar-io-node#959): a data item inside a
 * bundle that is itself a data item, stored with that intermediate bundle as
 * its root, as seen on turbo-gateway.com. Every component on the read path is
 * real except storage: signed ANS-104 items and bundles, the ANS-104 header
 * parser, a CDB64 index file read through the composite root TX index, and an
 * in-memory "chain" that, like chunk retrieval, can only read the L1
 * transaction.
 *
 *   L1 transaction (outer bundle)
 *   └─ BUNDLE: a data item whose payload is a bundle
 *      └─ ITEM: the item requested, first in BUNDLE, so at offset 160
 */
describe('RootParentDataSource: nested item stored under its enclosing bundle', () => {
  const log = createTestLogger({ suite: 'RootParentDataSource nested root' });
  const L1 = randomBytes(32).toString('base64url');
  const PAYLOAD = Buffer.from('the nested item payload, served from L1');

  let tempDir: string;
  let item: DataItem;
  let bundleItem: DataItem;
  let l1Bytes: Buffer;
  let storedLocation: ContiguousDataAttributes;
  let bundleInL1: { itemOffset: number; dataOffset: number };
  let expected: { itemOffset: number; dataOffset: number };

  const headerSize = (d: DataItem) => d.getRaw().length - d.rawData.length;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-root-test-'));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .subarray(-32);
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signer = new SolanaSigner(bs58.encode(Buffer.concat([seed, pub])));

    item = createData(PAYLOAD, signer, {
      tags: [{ name: 'Content-Type', value: 'text/plain' }],
    });
    const sibling = createData('sibling', signer);
    const innerBundle = await bundleAndSignData([item, sibling], signer);

    bundleItem = createData(innerBundle.getRaw(), signer, {
      tags: [
        { name: 'Bundle-Format', value: 'binary' },
        { name: 'Bundle-Version', value: '2.0.0' },
      ],
    });
    await bundleItem.sign(signer);
    const filler = createData('filler', signer);
    const outerBundle = await bundleAndSignData([bundleItem, filler], signer);
    l1Bytes = outerBundle.getRaw();

    // Two-item bundles: the first item's header starts after the 32-byte
    // count and two 64-byte index entries.
    const FIRST_ITEM = 32 + 64 * 2;
    storedLocation = {
      size: PAYLOAD.length,
      rootTransactionId: bundleItem.id,
      rootDataItemOffset: FIRST_ITEM,
      rootDataOffset: FIRST_ITEM + headerSize(item),
    } as ContiguousDataAttributes;
    bundleInL1 = {
      itemOffset: FIRST_ITEM,
      dataOffset: FIRST_ITEM + headerSize(bundleItem),
    };
    expected = {
      itemOffset: bundleInL1.dataOffset + FIRST_ITEM,
      dataOffset: bundleInL1.dataOffset + FIRST_ITEM + headerSize(item),
    };

    // Sanity: the fixture really has the item's bytes at the expected place.
    assert.deepStrictEqual(
      l1Bytes.subarray(
        expected.dataOffset,
        expected.dataOffset + PAYLOAD.length,
      ),
      PAYLOAD,
    );
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Only the L1 transaction can be read, as with chunk retrieval. */
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

  /** The gateway's own store: the item is recorded under the bundle. */
  const attributesStore = () => {
    const writes: [string, Record<string, unknown>][] = [];
    const store: ContiguousDataAttributesStore = {
      async getDataAttributes(id: string) {
        return id === item.id ? storedLocation : undefined;
      },
      async setDataAttributes(id: string, attributes: any) {
        writes.push([id, attributes]);
      },
    } as ContiguousDataAttributesStore;
    return { store, writes };
  };

  /**
   * The `db` source answers from the same stored row, first, as with
   * ROOT_TX_LOOKUP_ORDER=db,cdb,...
   */
  const dbIndex: DataItemRootIndex = {
    async getRootTx(id: string) {
      return id === item.id
        ? {
            rootTxId: storedLocation.rootTransactionId!,
            rootOffset: storedLocation.rootDataItemOffset,
            rootDataOffset: storedLocation.rootDataOffset,
            dataSize: storedLocation.size,
          }
        : undefined;
    },
  };

  /** A CDB64 file placing the bundle in the L1 transaction. */
  const cdbIndex = async (withBundleEntry: boolean) => {
    const cdbPath = path.join(
      tempDir,
      `index-${withBundleEntry}-${randomBytes(4).toString('hex')}.cdb`,
    );
    const writer = new Cdb64Writer(cdbPath);
    await writer.open();
    if (withBundleEntry) {
      await writer.add(
        fromB64Url(bundleItem.id),
        encodeCdb64Value({
          rootTxId: fromB64Url(L1),
          rootDataItemOffset: bundleInL1.itemOffset,
          rootDataOffset: bundleInL1.dataOffset,
        }),
      );
    } else {
      // Something unrelated, so the file is valid.
      await writer.add(
        randomBytes(32),
        encodeCdb64Value({ rootTxId: randomBytes(32) }),
      );
    }
    await writer.finalize();
    return new Cdb64RootTxIndex({ log, sources: [cdbPath], watch: false });
  };

  const source = (
    store: ContiguousDataAttributesStore,
    cdb: DataItemRootIndex,
  ) =>
    new RootParentDataSource({
      log,
      dataSource: chain,
      dataAttributesStore: store,
      dataItemRootTxIndex: new CompositeRootTxIndex({
        log,
        indexes: [dbIndex, cdb],
      }),
      ans104OffsetSource: new Ans104OffsetSource({ log, dataSource: chain }),
    });

  const readAll = async (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it('serves the item from the L1 transaction and stores the corrected location', async () => {
    const { store, writes } = attributesStore();
    const cdb = await cdbIndex(true);
    try {
      const data = await source(store, cdb).getData({ id: item.id });

      assert.deepStrictEqual(await readAll(data.stream), PAYLOAD);
      assert.deepStrictEqual(writes, [
        [
          item.id,
          {
            rootTransactionId: L1,
            rootDataItemOffset: expected.itemOffset,
            rootDataOffset: expected.dataOffset,
            size: PAYLOAD.length,
          },
        ],
      ]);
    } finally {
      await cdb.close();
    }
  });

  it('still fails, and stores nothing, when no index places the bundle', async () => {
    const { store, writes } = attributesStore();
    const cdb = await cdbIndex(false);
    try {
      await assert.rejects(source(store, cdb).getData({ id: item.id }));
      assert.deepStrictEqual(writes, []);
    } finally {
      await cdb.close();
    }
  });
});
