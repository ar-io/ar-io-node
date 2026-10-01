/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  ArweaveSigner,
  bundleAndSignData,
  createData,
} from '@dha-team/arbundles';
import Arweave from 'arweave';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildBand, BandSampleEntry, MAX_HEADER_BYTES } from './build.js';
import {
  checkBandHeaders,
  gatewayRootSource,
  RootSourceFactory,
  sampleBandEntries,
} from './verify.js';
import { scanBundle, ScannedDataItem } from '../ans104-bundle-scan.js';
import { ByteRangeSource } from '../byte-range-source.js';
import { fromB64Url } from '../encoding.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'checkBandHeaders' });
const ROOT = 'VmFsaWRSb290VHhJZEZvclRoZUhlYWRlckNoZWNrMDE';

class BufferByteRangeSource implements ByteRangeSource {
  constructor(private readonly bytes: Buffer) {}

  async read(offset: number, size: number): Promise<Buffer> {
    if (offset < 0 || offset + size > this.bytes.length) {
      // As a gateway answers a range the root doesn't have.
      throw Object.assign(
        new Error(`Read ${offset}+${size} is outside the root`),
        {
          response: { status: 416 },
        },
      );
    }
    return this.bytes.subarray(offset, offset + size);
  }

  async close(): Promise<void> {}

  isOpen(): boolean {
    return true;
  }
}

describe('checkBandHeaders', () => {
  let items: ScannedDataItem[];
  let rootBytes: Buffer;
  let openRoot: RootSourceFactory;
  let tempDir: string;

  before(async () => {
    const signer = new ArweaveSigner(await Arweave.init({}).wallets.generate());
    const bundle = await bundleAndSignData(
      [
        createData('first item', signer, {
          tags: [{ name: 'Content-Type', value: 'text/plain' }],
        }),
        createData(Buffer.alloc(3000, 5), signer),
        createData('third', signer, {
          tags: [{ name: 'App-Name', value: 'header-check' }],
        }),
      ],
      signer,
    );
    rootBytes = bundle.getRaw();
    items = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(rootBytes),
      rootTxId: ROOT,
      bundleSize: rootBytes.length,
    })) {
      items.push(item);
    }
    openRoot = () => new BufferByteRangeSource(rootBytes);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'band-verify-'));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const entry = (item: ScannedDataItem): BandSampleEntry => ({
    id: item.id,
    rootTxId: ROOT,
    rootOffset: item.rootDataItemOffset,
    rootDataOffset: item.rootDataOffset,
  });

  it('passes when every header matches its ID and offsets', async () => {
    const result = await checkBandHeaders({
      entries: items.map(entry),
      totalRecords: items.length,
      openRoot,
      minRecords: 1,
    });

    assert.equal(result.passed, true, result.reasons.join('; '));
    assert.equal(result.ok, items.length);
    assert.deepEqual(result.wrong, []);
  });

  it('fails on an entry whose offsets point at another item', async () => {
    const [first, second] = items;
    const result = await checkBandHeaders({
      entries: [
        {
          ...entry(first),
          rootOffset: second.rootDataItemOffset,
          rootDataOffset: second.rootDataOffset,
        },
        entry(second),
      ],
      totalRecords: 2,
      openRoot,
      minRecords: 1,
    });

    assert.equal(result.passed, false);
    assert.equal(result.wrong.length, 1);
    assert.match(result.wrong[0].reason, /is item/);
  });

  it('fails on offsets that cut the header short or run past it', async () => {
    const [first] = items;
    const short = await checkBandHeaders({
      entries: [{ ...entry(first), rootDataOffset: first.rootDataOffset - 1 }],
      totalRecords: 1,
      openRoot,
      minRecords: 1,
    });
    const long = await checkBandHeaders({
      entries: [{ ...entry(first), rootDataOffset: first.rootDataOffset + 1 }],
      totalRecords: 1,
      openRoot,
      minRecords: 1,
    });

    assert.equal(short.passed, false);
    assert.match(short.wrong[0].reason, /runs past/);
    assert.equal(long.passed, false);
    assert.match(long.wrong[0].reason, /header is/);
  });

  it('fails when offsets point at bytes that are not a header', async () => {
    const [first] = items;
    const result = await checkBandHeaders({
      entries: [
        {
          ...entry(first),
          rootOffset: first.rootDataOffset,
          rootDataOffset: first.rootDataOffset + 2000,
        },
      ],
      totalRecords: 1,
      openRoot,
      minRecords: 1,
    });

    assert.equal(result.passed, false);
    assert.equal(result.wrong.length, 1);
    assert.deepEqual(result.errors, []);
  });

  it('fails a mostly correct sample that has any entry pointing into a payload', async () => {
    // 125 correct entries and 25 whose offsets land inside payloads: over the
    // 80% ratio, so only classing them as wrong can fail the band.
    const good = Array.from({ length: 125 }, (_, i) =>
      entry(items[i % items.length]),
    );
    const bad = Array.from({ length: 25 }, (_, i) => {
      const item = items[i % items.length];
      return {
        ...entry(item),
        rootOffset: item.rootDataOffset,
        rootDataOffset: item.rootDataOffset + 500,
      };
    });
    const result = await checkBandHeaders({
      entries: [...good, ...bad],
      totalRecords: 150,
      openRoot,
      minRecords: 1,
    });

    assert.equal(result.passed, false);
    assert.equal(result.ok, 125);
    assert.equal(result.wrong.length, 25);
  });

  it('calls a range past the end of the root wrong, and a transport failure unchecked', async () => {
    const [first] = items;
    const answering =
      (status: number): RootSourceFactory =>
      () => ({
        read: async () => {
          throw Object.assign(new Error(`status ${status}`), {
            response: { status },
          });
        },
        close: async () => {},
        isOpen: () => true,
      });
    const pastEnd = await checkBandHeaders({
      entries: [entry(first)],
      totalRecords: 1,
      openRoot: answering(416),
      minRecords: 1,
    });
    const unavailable = await checkBandHeaders({
      entries: [entry(first)],
      totalRecords: 1,
      openRoot: answering(503),
      minRecords: 1,
    });

    assert.equal(pastEnd.wrong.length, 1);
    assert.match(pastEnd.wrong[0].reason, /past the end/);
    assert.deepEqual(unavailable.wrong, []);
    assert.equal(unavailable.errors.length, 1);
  });

  it('calls a range a gateway trims at the end of the root wrong, through a real HTTP source', async () => {
    // Gateways answer a range that starts inside the root but runs past its
    // end with a shorter 206 (RFC 9110), not a 416.
    const server = http.createServer((req, res) => {
      const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (match === null) {
        res.writeHead(200).end(rootBytes);
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), rootBytes.length - 1);
      if (start >= rootBytes.length) {
        res.writeHead(416).end();
        return;
      }
      res
        .writeHead(206, {
          'content-range': `bytes ${start}-${end}/${rootBytes.length}`,
        })
        .end(rootBytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const roots = gatewayRootSource(`http://127.0.0.1:${port}/`);
    try {
      const [first] = items;
      const trimmed = {
        ...entry(first),
        id: 'trimmed',
        rootOffset: rootBytes.length - 100,
        rootDataOffset: rootBytes.length + 500,
      };
      const result = await checkBandHeaders({
        entries: [entry(first), trimmed],
        totalRecords: 2,
        openRoot: roots.openRoot,
        minRecords: 1,
      });

      assert.equal(result.ok, 1, 'a correct entry passes over HTTP');
      assert.deepEqual(
        result.wrong.map((w) => w.id),
        ['trimmed'],
      );
      assert.match(result.wrong[0].reason, /past the end/);
      assert.deepEqual(result.errors, []);
    } finally {
      roots.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('passes at exactly the minimum ratio, and fails just under it', async () => {
    const good = entry(items[0]);
    let calls = 0;
    // The first `failures` reads fail as transport errors.
    const flaky =
      (failures: number): RootSourceFactory =>
      (rootTxId) => {
        const real = openRoot(rootTxId);
        return {
          read: async (offset: number, size: number) => {
            calls += 1;
            if (calls <= failures) throw new Error('timeout');
            return real.read(offset, size);
          },
          close: async () => {},
          isOpen: () => true,
        };
      };
    const run = (failures: number) => {
      calls = 0;
      return checkBandHeaders({
        entries: Array.from({ length: 10 }, () => good),
        totalRecords: 10,
        openRoot: flaky(failures),
        minRecords: 1,
        concurrency: 1,
      });
    };

    assert.equal((await run(2)).passed, true, '8 of 10 is 80%');
    assert.equal((await run(3)).passed, false, '7 of 10 is under 80%');
  });

  it('calls a header span over the maximum wrong without reading it', async () => {
    let reads = 0;
    const counting: RootSourceFactory = (rootTxId) => {
      const real = openRoot(rootTxId);
      return {
        read: async (offset: number, size: number) => {
          reads += 1;
          return real.read(offset, size);
        },
        close: async () => {},
        isOpen: () => true,
      };
    };
    const [first] = items;
    const result = await checkBandHeaders({
      entries: [
        {
          ...entry(first),
          rootDataOffset: first.rootDataItemOffset + MAX_HEADER_BYTES + 1,
        },
      ],
      totalRecords: 1,
      openRoot: counting,
      minRecords: 1,
    });

    assert.equal(result.wrong.length, 1);
    assert.equal(reads, 0);
  });

  it('counts unreadable roots against the pass ratio without calling them wrong', async () => {
    const failing: RootSourceFactory = () => ({
      read: async () => {
        throw new Error('gateway unreachable');
      },
      close: async () => {},
      isOpen: () => true,
    });
    const result = await checkBandHeaders({
      entries: items.map(entry),
      totalRecords: items.length,
      openRoot: failing,
      minRecords: 1,
    });

    assert.equal(result.passed, false);
    assert.deepEqual(result.wrong, []);
    assert.equal(result.errors.length, items.length);
    assert.match(result.reasons.join(' '), /under 80%/);
  });

  it('fails a band smaller than the minimum, or with nothing to check', async () => {
    const small = await checkBandHeaders({
      entries: items.map(entry),
      totalRecords: items.length,
      openRoot,
    });
    const empty = await checkBandHeaders({
      entries: [],
      totalRecords: 5000,
      openRoot,
    });

    assert.equal(small.passed, false);
    assert.match(small.reasons.join(' '), /fewer than 1000/);
    assert.equal(empty.passed, false);
    assert.match(empty.reasons.join(' '), /no entries with offsets/);
  });

  it('refuses to open a partition file a manifest names outside the band', async () => {
    const band = await buildBand({
      log,
      records: items.map((item) => ({
        id: fromB64Url(item.id),
        rootTxId: fromB64Url(ROOT),
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
      })),
      publishDir: path.join(tempDir, 'published-traversal'),
      workDir: path.join(tempDir, 'export-traversal'),
      publisher: 'test-publisher',
      kind: 'd',
      heightRange: [0, null],
    });
    const manifestPath = path.join(band.dir!, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.partitions[0].location.filename = '../../elsewhere.cdb';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      sampleBandEntries(band.dir!, 10),
      /not a partition file/,
    );
  });

  it('checks a built band end to end, from its own sample or one read from disk', async () => {
    const band = await buildBand({
      log,
      records: items.map((item) => ({
        id: fromB64Url(item.id),
        rootTxId: fromB64Url(ROOT),
        rootOffset: item.rootDataItemOffset,
        rootDataOffset: item.rootDataOffset,
        size: item.dataItemSize,
      })),
      publishDir: path.join(tempDir, 'published'),
      workDir: path.join(tempDir, 'export'),
      publisher: 'test-publisher',
      kind: 'd',
      heightRange: [0, null],
    });

    const fromBuild = await checkBandHeaders({
      entries: band.sample,
      totalRecords: band.records,
      openRoot,
      minRecords: 1,
    });
    assert.equal(fromBuild.passed, true, fromBuild.reasons.join('; '));

    const fromDisk = await sampleBandEntries(band.dir!, 10);
    assert.equal(fromDisk.totalRecords, items.length);
    assert.equal(fromDisk.entries.length, items.length);
    const checked = await checkBandHeaders({
      ...fromDisk,
      openRoot,
      minRecords: 1,
    });
    assert.equal(checked.passed, true, checked.reasons.join('; '));
  });
});
