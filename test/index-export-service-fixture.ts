/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The shared setup of the index-export service's root-TX tests, split
 * across files so that none comes near the test runner's per-file timeout:
 * a signed bundle of 3,300 items, records over it in three height ranges,
 * an in-memory source and a service wired to them.
 */
import {
  bundleAndSignData,
  createData,
  EthereumSigner,
  keccak256,
} from '@dha-team/arbundles';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, before, beforeEach } from 'node:test';
import secp256k1 from 'secp256k1';

import { scanBundle, ScannedDataItem } from '../src/lib/ans104-bundle-scan.js';
import { ByteRangeSource } from '../src/lib/byte-range-source.js';
import { fromB64Url, toB64Url } from '../src/lib/encoding.js';
import type { BandRecord } from '../src/lib/index-band/build.js';
import type { RootSourceFactory } from '../src/lib/index-band/verify.js';
import type { ExportConfig } from '../src/index-export/config.js';
import {
  newSourceStats,
  RecordSource,
} from '../src/index-export/kinds/root-tx/sources/rows.js';
import { ExportService } from '../src/index-export/service.js';
import {
  deriveOwnBands,
  indexState,
  loadState,
  OwnBand,
} from '../src/index-export/state.js';
import { BufferByteRangeSource } from './buffer-byte-range-source.js';
import { createTestLogger } from './test-logger.js';

const log = createTestLogger({ suite: 'index-export service' });
export const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';
export const ROOT = Buffer.alloc(32, 9);
export const DAY = 24 * 3600_000;

/**
 * arbundles' EthereumSigner, signing through the native secp256k1 addon.
 *
 * EthereumSigner builds an ethers `Wallet` for every signature and signs in
 * pure JavaScript: about 1.5 ms an item, so 5 s of every suite's `before` on
 * a fast runner and several times that on CI's macOS runners, where it
 * pushed whole files toward the per-file timeout. This signs the same EIP-191
 * digest with libsecp256k1, whose RFC 6979 nonces are ethers' too, so its
 * signatures -- and the bundle -- are byte-for-byte the same, about five
 * times faster. `useExportService` checks that before it signs the bundle.
 */
class NativeEthereumSigner extends EthereumSigner {
  private readonly privateKey: Buffer;

  constructor(key: string) {
    super(key);
    this.privateKey = Buffer.from(key.replace(/^0x/, ''), 'hex');
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const digest = keccak256(
      Buffer.concat([
        Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`),
        message,
      ]),
    );
    const { signature, recid } = secp256k1.ecdsaSign(digest, this.privateKey);
    return Buffer.concat([signature, Buffer.from([27 + recid])]);
  }
}

export class MemorySource implements RecordSource {
  readonly rank = 0;
  readonly stats = newSourceStats();
  top = 0;
  fail?: string;

  constructor(
    readonly name: string,
    private readonly all: () => BandRecord[],
  ) {}

  async stableHeight() {
    if (this.fail !== undefined) throw new Error(this.fail);
    return this.top;
  }

  async *records(from: number, to: number) {
    for (const record of this.all()) {
      const height = record.height ?? 0;
      if (height < from || height > to || height > this.top) continue;
      this.stats.records += 1;
      yield { ...record, source: this.name };
    }
  }

  async close() {}
}

/**
 * Every height from the bottom of the lowest band to `top` is in some live
 * band: what a subscriber relies on.
 */
export function assertCovered(bands: OwnBand[], from: number, top: number) {
  const ranges = bands.map((b) => [b.from, b.to ?? Infinity] as const);
  for (let height = from; height <= top; height++) {
    assert.ok(
      ranges.some(([lo, hi]) => lo <= height && height <= hi),
      `height ${height} is covered`,
    );
  }
}

/** The suite's state, which a test may change, and the helpers that read it. */
export class ExportServiceHarness {
  items: ScannedDataItem[] = [];
  bundle: Buffer = Buffer.alloc(0);
  records: BandRecord[] = [];
  dir = '';
  now = 0;
  gw1 = new MemorySource('gw1', () => this.records);
  rootsFail = false;
  freeBytes = 0;

  config = (more: Partial<ExportConfig> = {}): ExportConfig => ({
    kinds: ['root-tx-index'],
    coreDbPath: path.join(this.dir, 'core.db'),
    l1PublishDir: path.join(this.dir, 'published', 'parquet-l1'),
    publisher: PUBLISHER,
    sources: [],
    sourceEnv: {},
    runAtMinute: 240,
    recentMaxBlocks: 1000,
    startHeight: 1000,
    headerCheckUrl: 'http://gateway.test',
    headerCheckTimeoutMs: 1000,
    metricsPort: 0,
    publishDir: path.join(this.dir, 'published', 'root-tx-index'),
    workDir: path.join(this.dir, 'export'),
    ...more,
  });

  /** Opens roots for the header check; a test may wrap it, root by root. */
  roots: () => { openRoot: RootSourceFactory; close: () => void } = () => ({
    openRoot: (): ByteRangeSource =>
      this.rootsFail
        ? ({
            read: async () => {
              throw new Error('Request failed with status code 503');
            },
            close: async () => undefined,
          } as unknown as ByteRangeSource)
        : new BufferByteRangeSource(this.bundle),
    close: () => undefined,
  });

  service = (
    more: Partial<ExportConfig> = {},
    sources: () => Array<{ source: RecordSource; optional: boolean }> = () => [
      { source: this.gw1, optional: false },
    ],
  ): ExportService =>
    new ExportService({
      config: this.config(more),
      log,
      now: () => this.now,
      openSources: async () => sources(),
      openRoots: this.roots,
      diskSpace: async () => ({ free: this.freeBytes, total: 1e13 }),
      headerCheck: { retryDelayMs: 1 },
      // Thousands of small files a suite; none need survive a power cut.
      syncBands: false,
    });

  live = (): Promise<OwnBand[]> =>
    deriveOwnBands(this.config().publishDir, PUBLISHER, {});

  exportState = async () =>
    indexState(
      await loadState(path.join(this.dir, 'export', 'state.json')),
      'root-tx-index',
    );
}

/** Registers the suite's hooks, and returns the state they set up. */
export function useExportService(): ExportServiceHarness {
  const ctx = new ExportServiceHarness();

  before(async () => {
    const key = `0x${'11'.repeat(32)}`;
    const signer = new NativeEthereumSigner(key);
    const probe = Buffer.from('index-export service fixture');
    assert.deepEqual(
      Buffer.from(await signer.sign(probe)),
      Buffer.from(await new EthereumSigner(key).sign(probe)),
      'signs exactly as EthereumSigner does',
    );
    const signed = await bundleAndSignData(
      Array.from({ length: 3300 }, (_, i) => createData(`item ${i}`, signer)),
      signer,
    );
    ctx.bundle = signed.getRaw();
    ctx.items = [];
    for await (const item of scanBundle({
      source: new BufferByteRangeSource(ctx.bundle),
      rootTxId: toB64Url(ROOT),
      bundleSize: ctx.bundle.length,
    })) {
      ctx.items.push(item);
    }
  });

  beforeEach(async () => {
    ctx.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-service-'));
    ctx.now = Date.parse('2026-10-02T04:00:00Z');
    ctx.rootsFail = false;
    ctx.freeBytes = 1e13;
    // 1,100 items in each of h [1000, 1999], r [2000, 2087] and the
    // overlap [2089, 2600] a delta reads.
    ctx.records = ctx.items.map((item, i) => ({
      id: fromB64Url(item.id),
      rootTxId: ROOT,
      height:
        i < 1100
          ? 1000 + (i % 1000)
          : i < 2200
            ? 2000 + (i % 88)
            : 2089 + (i % 512),
      rootOffset: item.rootDataItemOffset,
      rootDataOffset: item.rootDataOffset,
      size: item.dataItemSize,
    }));
    ctx.gw1 = new MemorySource('gw1', () => ctx.records);
    ctx.gw1.top = 2600;
  });

  afterEach(async () => {
    await fs.rm(ctx.dir, { recursive: true, force: true });
  });

  return ctx;
}
