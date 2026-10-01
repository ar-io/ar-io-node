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
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';

import {
  indexBandBuildCLICommand,
  indexBandVerifyCLICommand,
  parseHeightRange,
  readBandRecordsCsv,
} from './indexBandCommands.js';
import { scanBundle, ScannedDataItem } from '../../lib/ans104-bundle-scan.js';
import { ByteRangeSource } from '../../lib/byte-range-source.js';
import { toB64Url } from '../../lib/encoding.js';
import type { IndexBandBuildCLIOptions } from '../types.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'indexBandCommands' });
const ROOT = 'VmFsaWRSb290VHhJZEZvclRoZUhlYWRlckNoZWNrMDE';
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

class BufferByteRangeSource implements ByteRangeSource {
  constructor(private readonly bytes: Buffer) {}

  async read(offset: number, size: number): Promise<Buffer> {
    if (offset < 0 || offset + size > this.bytes.length) {
      throw Object.assign(new Error('outside the root'), {
        response: { status: 416 },
      });
    }
    return this.bytes.subarray(offset, offset + size);
  }

  async close(): Promise<void> {}

  isOpen(): boolean {
    return true;
  }
}

const idOf = (seed: number): string => {
  const id = Buffer.alloc(32, 7);
  id.writeUInt32BE(seed, 0);
  return toB64Url(id);
};

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

describe('readBandRecordsCsv', () => {
  const read = (text: string, skipHeader = false) =>
    collect(readBandRecordsCsv(Readable.from([text]), { skipHeader }));

  it('reads the generator columns plus height, with optional columns empty', async () => {
    const records = await read(
      [
        `${idOf(1)},${idOf(2)}`,
        `${idOf(3)},${idOf(4)},,100,250,900`,
        `${idOf(5)},${idOf(6)},,,,,42`,
      ].join('\n'),
    );

    assert.equal(records.length, 3);
    assert.equal(toB64Url(records[0].id), idOf(1));
    assert.equal(toB64Url(records[0].rootTxId), idOf(2));
    assert.equal(records[0].rootOffset, undefined);
    assert.deepEqual(
      [records[1].rootOffset, records[1].rootDataOffset, records[1].size],
      [100, 250, 900],
    );
    assert.equal(records[1].height, undefined);
    assert.equal(records[2].height, 42);
  });

  it('skips a header line when asked', async () => {
    const records = await read(
      `data_item_id,root_tx_id,path\n${idOf(1)},${idOf(2)}`,
      true,
    );
    assert.equal(records.length, 1);
  });

  it('fails on a malformed row, naming its line', async () => {
    await assert.rejects(
      read(`${idOf(1)},${idOf(2)}\nnot-an-id,${idOf(2)}`),
      /Line 2: data_item_id/,
    );
    // The line of the failing record, not how far the parser has read.
    await assert.rejects(
      read(
        [
          `not-an-id,${idOf(2)}`,
          ...Array.from({ length: 50 }, (_, i) => `${idOf(i)},${idOf(2)}`),
        ].join('\n'),
      ),
      /^Error: Line 1: data_item_id/,
    );
    await assert.rejects(
      read(`${idOf(1)},${idOf(2)},,1.5,9`),
      /Line 1: root_data_item_offset/,
    );
    await assert.rejects(read(`${idOf(1)}`), /Line 1: needs at least/);
  });

  it('points at --skip-header when the first line looks like a header', async () => {
    await assert.rejects(
      read(`data_item_id,root_tx_id,path\n${idOf(1)},${idOf(2)}`),
      /Line 1: data_item_id .*--skip-header/,
    );
  });

  it('refuses nested bundle paths, which bands do not carry yet', async () => {
    await assert.rejects(
      read(`${idOf(1)},${idOf(2)},"[""${idOf(3)}""]"`),
      /nested bundle paths/,
    );
  });
});

describe('parseHeightRange', () => {
  it('reads a closed range or one that follows the tip', () => {
    assert.deepEqual(parseHeightRange('100,200'), [100, 200]);
    assert.deepEqual(parseHeightRange('2010500, tip'), [2010500, null]);
  });

  it('refuses anything else', () => {
    for (const bad of ['200,100', '100', '-1,5', 'a,b', '100,200,300']) {
      assert.throws(() => parseHeightRange(bad), /--height-range/, bad);
    }
  });
});

describe('index-band-build and index-band-verify', () => {
  let items: ScannedDataItem[];
  let rootBytes: Buffer;
  let tempDir: string;
  let roots: { openRoot: () => ByteRangeSource; close: () => void };

  before(async () => {
    const signer = new ArweaveSigner(await Arweave.init({}).wallets.generate());
    const bundle = await bundleAndSignData(
      [
        createData('first item', signer),
        createData(Buffer.alloc(3000, 5), signer),
        createData('third', signer),
      ],
      signer,
    );
    rootBytes = bundle.getRaw();
    items = await collect(
      scanBundle({
        source: new BufferByteRangeSource(rootBytes),
        rootTxId: ROOT,
        bundleSize: rootBytes.length,
      }),
    );
    roots = {
      openRoot: () => new BufferByteRangeSource(rootBytes),
      close: () => {},
    };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-band-cli-'));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Three real items with offsets (the header check samples these) and
  // enough root-only records to clear the check's 1,000-record minimum.
  const csv = (offsetsFor: (item: ScannedDataItem) => [number, number]) =>
    [
      ...items.map((item) => {
        const [rootOffset, rootDataOffset] = offsetsFor(item);
        return `${item.id},${ROOT},,${rootOffset},${rootDataOffset},,7`;
      }),
      ...Array.from({ length: 1000 }, (_, i) => `${idOf(i + 100)},${ROOT}`),
    ].join('\n');

  const options = (
    name: string,
    overrides: Partial<IndexBandBuildCLIOptions> = {},
  ): IndexBandBuildCLIOptions => ({
    input: 'records.csv',
    publisher: PUBLISHER,
    kind: 'd',
    heightRange: '0,tip',
    publishDir: path.join(tempDir, name, 'published', 'root-tx-index'),
    workDir: path.join(tempDir, name, 'export'),
    ...overrides,
  });

  const correct = (item: ScannedDataItem): [number, number] => [
    item.rootDataItemOffset,
    item.rootDataOffset,
  ];

  it('builds, checks and publishes a band, and verify passes it', async () => {
    const opts = options('good');
    const built = (await indexBandBuildCLICommand(opts, {
      log,
      openInput: () => Readable.from([csv(correct)]),
      roots,
    })) as Record<string, any>;

    assert.equal(built.published, true);
    assert.equal(built.records, 1003);
    assert.equal(built.rootOnly, 1000);
    assert.equal(built.headerCheck.passed, true);
    assert.equal(built.headerCheck.ok, 3);
    assert.match(built.id, /^d-h0-tip-/);
    assert.deepEqual(await fs.readdir(opts.publishDir), [built.id]);

    const verified = (await indexBandVerifyCLICommand(
      { bandDir: built.dir },
      { log, roots },
    )) as Record<string, any>;
    assert.equal(verified.passed, true);
    assert.equal(verified.ok, 3);
  });

  it('refuses to publish a band whose offsets point at the wrong bytes, and exits 1 with the result', async () => {
    const opts = options('bad');
    const shifted = (item: ScannedDataItem): [number, number] => [
      item.rootDataItemOffset + 1,
      item.rootDataOffset + 1,
    ];
    const thrown = await indexBandBuildCLICommand(opts, {
      log,
      openInput: () => Readable.from([csv(shifted)]),
      roots,
    }).then(
      () => assert.fail('expected the build to be refused'),
      (error: unknown) => error as Record<string, any>,
    );

    assert.equal(thrown.published, false);
    assert.equal(thrown.headerCheck.passed, false);
    assert.ok(thrown.rejected.length > 0);
    assert.deepEqual(
      await fs.readdir(opts.publishDir).catch(() => []),
      [],
      'nothing published',
    );
  });

  it('checks but publishes nothing on a dry run', async () => {
    const opts = options('dry', { dryRun: true });
    const built = (await indexBandBuildCLICommand(opts, {
      log,
      openInput: () => Readable.from([csv(correct)]),
      roots,
    })) as Record<string, any>;

    assert.equal(built.published, false);
    assert.equal(built.dryRun, true);
    assert.equal(built.headerCheck.passed, true);
    assert.deepEqual(await fs.readdir(opts.publishDir).catch(() => []), []);
  });

  it('needs a gateway for the check unless it is skipped', async () => {
    await assert.rejects(
      indexBandBuildCLICommand(options('nogw'), {
        log,
        openInput: () => Readable.from([csv(correct)]),
      }),
      /--gateway-url is required unless --skip-header-check/,
    );

    const built = (await indexBandBuildCLICommand(
      options('skipped', { skipHeaderCheck: true }),
      { log, openInput: () => Readable.from([csv(correct)]) },
    )) as Record<string, any>;
    assert.equal(built.published, true);
    assert.equal(built.headerCheck, 'skipped');
  });

  it('fails with one line, not a crash, when the input file is missing', async () => {
    await assert.rejects(
      indexBandBuildCLICommand(
        options('missing-input', {
          input: path.join(tempDir, 'nope.csv'),
          skipHeaderCheck: true,
        }),
        { log },
      ),
      /--input .*nope\.csv cannot be read/,
    );
  });

  it('refuses to write outside the directory the wrapper mounts', async () => {
    const mounted = path.join(tempDir, 'mounted');
    process.env.AR_IO_NODE_CLI_DATA_DIR = mounted;
    try {
      await assert.rejects(
        indexBandBuildCLICommand(
          options('elsewhere', { skipHeaderCheck: true }),
          { log, openInput: () => Readable.from([csv(correct)]) },
        ),
        /--publish-dir .* is outside data\/indexes/,
      );
      const built = (await indexBandBuildCLICommand(
        {
          ...options('inside', { skipHeaderCheck: true }),
          publishDir: path.join(mounted, 'published', 'root-tx-index'),
          workDir: path.join(mounted, 'export'),
        },
        { log, openInput: () => Readable.from([csv(correct)]) },
      )) as Record<string, any>;
      assert.equal(built.published, true);
    } finally {
      delete process.env.AR_IO_NODE_CLI_DATA_DIR;
    }
  });

  it('requires the band options, by their flag names', async () => {
    for (const [key, flag] of [
      ['input', '--input'],
      ['publisher', '--publisher'],
      ['kind', '--kind'],
      ['heightRange', '--height-range'],
    ] as const) {
      await assert.rejects(
        indexBandBuildCLICommand(
          { ...options('missing'), [key]: undefined },
          { log, roots },
        ),
        new RegExp(`${flag} is required`),
      );
    }
  });

  it('verify throws its result when a band fails the check', async () => {
    const opts = options('verify-bad', { skipHeaderCheck: true });
    const shifted = (item: ScannedDataItem): [number, number] => [
      item.rootDataItemOffset + 1,
      item.rootDataOffset + 1,
    ];
    const built = (await indexBandBuildCLICommand(opts, {
      log,
      openInput: () => Readable.from([csv(shifted)]),
    })) as Record<string, any>;

    const thrown = await indexBandVerifyCLICommand(
      { bandDir: built.dir },
      { log, roots },
    ).then(
      () => assert.fail('expected verify to fail'),
      (error: unknown) => error as Record<string, any>,
    );
    assert.equal(thrown.passed, false);
    assert.equal(thrown.wrong.length, 3);
  });
});
