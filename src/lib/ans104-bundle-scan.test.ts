/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ArweaveSigner,
  DataItem,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import Arweave from 'arweave';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { before, describe, it } from 'node:test';

import {
  BundleScanError,
  ScannedDataItem,
  decodeDataItemHeader,
  scanBundle,
} from './ans104-bundle-scan.js';
import { ByteRangeSource } from './byte-range-source.js';
import { processBundleStream } from './bundles.js';

const ROOT = 'test-root-tx-id';

/** In-memory byte source that records every read. */
class BufferByteRangeSource implements ByteRangeSource {
  readonly reads: Array<{ offset: number; size: number }> = [];

  constructor(private readonly bytes: Buffer) {}

  async read(offset: number, size: number): Promise<Buffer> {
    this.reads.push({ offset, size });
    if (offset < 0 || size < 0 || offset + size > this.bytes.length) {
      throw new Error(
        `Read ${offset}+${size} is outside ${this.bytes.length} bytes`,
      );
    }
    return this.bytes.subarray(offset, offset + size);
  }

  async close(): Promise<void> {}

  isOpen(): boolean {
    return true;
  }
}

async function collect(
  items: AsyncGenerator<ScannedDataItem>,
): Promise<ScannedDataItem[]> {
  const collected: ScannedDataItem[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}

describe('ans104-bundle-scan', () => {
  let signer: ArweaveSigner;

  before(async () => {
    signer = new ArweaveSigner(await Arweave.init({}).wallets.generate());
  });

  const buildFlatBundle = async (): Promise<{
    items: DataItem[];
    raw: Buffer;
  }> => {
    const items = [
      createData(JSON.stringify({ name: 'nft #1' }), signer, {
        tags: [{ name: 'Content-Type', value: 'application/json' }],
      }),
      createData(Buffer.alloc(5000, 7), signer, {
        tags: [
          { name: 'content-type', value: 'image/png' },
          { name: 'App-Name', value: 'scan-test' },
        ],
      }),
      createData('', signer),
    ];
    const bundle = await bundleAndSignData(items, signer);
    return { items, raw: bundle.getRaw() };
  };

  const buildNestedBundle = async () => {
    const inner = [
      createData('inner a', signer, {
        tags: [{ name: 'Content-Type', value: 'text/plain' }],
      }),
      createData(Buffer.alloc(3000, 1), signer),
    ];
    const innerBundle = await bundleAndSignData(inner, signer);
    const nestedItem = createData(innerBundle.getRaw(), signer, {
      tags: [
        { name: 'Bundle-Format', value: 'binary' },
        { name: 'Bundle-Version', value: '2.0.0' },
      ],
    });
    const plain = createData('outer plain', signer);
    const outer = await bundleAndSignData([plain, nestedItem], signer);
    return { inner, nestedItem, plain, raw: outer.getRaw() };
  };

  describe('decodeDataItemHeader', () => {
    it('reports how many more bytes it needs until the header is complete', async () => {
      const item = createData('x', signer, {
        tags: [{ name: 'Content-Type', value: 'text/plain' }],
      });
      await item.sign(signer);
      const raw = item.getRaw();

      const full = decodeDataItemHeader(raw);
      assert.ok(full.complete);
      assert.equal(full.header.id, item.id);
      assert.equal(full.header.signatureType, 1);
      assert.equal(full.header.headerSize, raw.length - 1);
      assert.equal(full.header.contentType, 'text/plain');
      assert.equal(full.header.isBundle, false);

      let available = 0;
      let reads = 0;
      let result = decodeDataItemHeader(raw.subarray(0, available));
      while (!result.complete) {
        assert.ok(result.needBytes > available);
        available = result.needBytes;
        result = decodeDataItemHeader(raw.subarray(0, available));
        reads++;
      }
      assert.deepEqual(result.header, full.header);
      assert.ok(reads <= 5);
    });

    it('rejects an invalid presence byte', async () => {
      const item = createData('x', signer);
      await item.sign(signer);
      const raw = Buffer.from(item.getRaw());
      raw[2 + 512 + 512] = 7; // target presence byte

      assert.throws(
        () => decodeDataItemHeader(raw),
        /Invalid target presence byte: 7/,
      );
    });
  });

  describe('scanBundle', () => {
    it('matches the full-stream bundle parser', async () => {
      const { raw } = await buildFlatBundle();
      const expected = await processBundleStream(Readable.from([raw]));

      const scanned = await collect(
        scanBundle({
          source: new BufferByteRangeSource(raw),
          rootTxId: ROOT,
          bundleSize: raw.length,
        }),
      );

      assert.deepEqual(
        scanned.map((item) => ({
          id: item.id,
          itemOffset: item.rootDataItemOffset,
          dataOffset: item.rootDataOffset,
          size: item.dataItemSize,
          signatureType: item.signatureType,
          contentType: item.contentType,
        })),
        expected.map((item) => ({
          id: item.id,
          itemOffset: item.offset,
          dataOffset: item.dataOffset,
          size: item.size,
          signatureType: item.signatureType,
          contentType: item.tags.find(
            (tag) => tag.name.toLowerCase() === 'content-type',
          )?.value,
        })),
      );
      assert.deepEqual(
        scanned.map((item) => [item.rootTxId, item.path, item.isBundle]),
        [
          [ROOT, [], false],
          [ROOT, [], false],
          [ROOT, [], false],
        ],
      );
    });

    it('coalesces header reads into one window by default', async () => {
      const { raw } = await buildFlatBundle();
      const source = new BufferByteRangeSource(raw);

      await collect(
        scanBundle({ source, rootTxId: ROOT, bundleSize: raw.length }),
      );

      // Item count, item index, then a single window for all three headers.
      assert.equal(source.reads.length, 3);
    });

    it('produces identical results when forced into small reads', async () => {
      const { raw } = await buildFlatBundle();
      const wide = await collect(
        scanBundle({
          source: new BufferByteRangeSource(raw),
          rootTxId: ROOT,
          bundleSize: raw.length,
        }),
      );

      const narrowSource = new BufferByteRangeSource(raw);
      const narrow = await collect(
        scanBundle({
          source: narrowSource,
          rootTxId: ROOT,
          bundleSize: raw.length,
          maxWindowBytes: 16,
          headerGuessBytes: 8,
        }),
      );

      assert.deepEqual(narrow, wide);
      assert.ok(narrowSource.reads.length > 3);
    });

    it('locates items inside nested bundles by their offsets in the root', async () => {
      const { inner, nestedItem, plain, raw } = await buildNestedBundle();

      const scanned = await collect(
        scanBundle({
          source: new BufferByteRangeSource(raw),
          rootTxId: ROOT,
          bundleSize: raw.length,
        }),
      );

      assert.deepEqual(
        scanned.map((item) => item.id),
        [plain.id, nestedItem.id, inner[0].id, inner[1].id],
      );
      assert.equal(scanned[1].isBundle, true);
      assert.deepEqual(scanned[1].path, []);

      inner.forEach((child, index) => {
        const item = scanned[2 + index];
        assert.deepEqual(item.path, [ROOT, nestedItem.id]);
        assert.deepEqual(
          raw.subarray(
            item.rootDataItemOffset,
            item.rootDataItemOffset + item.dataItemSize,
          ),
          child.getRaw(),
        );
        assert.deepEqual(
          raw.subarray(
            item.rootDataOffset,
            item.rootDataItemOffset + item.dataItemSize,
          ),
          child.rawData,
        );
      });
      assert.equal(scanned[2].contentType, 'text/plain');
    });

    it('rejects a header that does not belong to the indexed item', async () => {
      const { raw } = await buildFlatBundle();
      const corrupted = Buffer.from(raw);
      corrupted[32 + 32] ^= 0xff; // first byte of the first item's ID

      await assert.rejects(
        collect(
          scanBundle({
            source: new BufferByteRangeSource(corrupted),
            rootTxId: ROOT,
            bundleSize: corrupted.length,
          }),
        ),
        (error: unknown) =>
          error instanceof BundleScanError &&
          error.bundleId === ROOT &&
          /belongs to/.test(error.message),
      );
    });

    it('rejects a bundle whose items do not end at its size', async () => {
      const { raw } = await buildFlatBundle();

      await assert.rejects(
        collect(
          scanBundle({
            source: new BufferByteRangeSource(
              Buffer.concat([raw, Buffer.alloc(1)]),
            ),
            rootTxId: ROOT,
            bundleSize: raw.length + 1,
          }),
        ),
        /Items end at byte/,
      );
    });

    it('reports a corrupt nested bundle and keeps scanning when a handler is given', async () => {
      const { nestedItem, plain, raw } = await buildNestedBundle();
      const clean = await collect(
        scanBundle({
          source: new BufferByteRangeSource(raw),
          rootTxId: ROOT,
          bundleSize: raw.length,
        }),
      );
      const corrupted = Buffer.from(raw);
      // Overwrite the nested bundle's item count with an impossible value.
      corrupted.fill(
        0xff,
        clean[1].rootDataOffset,
        clean[1].rootDataOffset + 8,
      );

      const errors: Array<{ id: string; message: string }> = [];
      const scanned = await collect(
        scanBundle({
          source: new BufferByteRangeSource(corrupted),
          rootTxId: ROOT,
          bundleSize: corrupted.length,
          onNestedBundleError: (error, bundle) =>
            errors.push({ id: bundle.id, message: error.message }),
        }),
      );

      assert.deepEqual(
        scanned.map((item) => item.id),
        [plain.id, nestedItem.id],
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0].id, nestedItem.id);

      await assert.rejects(
        collect(
          scanBundle({
            source: new BufferByteRangeSource(corrupted),
            rootTxId: ROOT,
            bundleSize: corrupted.length,
          }),
        ),
        BundleScanError,
      );
    });
  });
});
