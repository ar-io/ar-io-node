/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildBand, BandRecord } from './build.js';
import { Cdb64RootTxKind } from '../../index-swarm/kinds/cdb64-root-tx.js';
import {
  decodeCdb64Value,
  getDataItemSize,
  getRootTxId,
} from '../cdb64-encoding.js';
import { parseManifest } from '../cdb64-manifest.js';
import { PartitionedCdb64Reader } from '../partitioned-cdb64-reader.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'buildBand' });
const PUBLISHER = 'ErEgD7dq1yR9W1CnVG3pEywi3qST7jqWA9nfWtxSGeBc';

const id32 = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 7 + i) % 256;
  return buf;
};

describe('buildBand', () => {
  let root: string;
  let publishDir: string;
  let workDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'index-band-'));
    publishDir = path.join(root, 'published', 'root-tx-index');
    workDir = path.join(root, 'export');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const build = (
    records: BandRecord[],
    overrides: Partial<Parameters<typeof buildBand>[0]> = {},
  ) =>
    buildBand({
      log,
      records,
      publishDir,
      workDir,
      publisher: PUBLISHER,
      kind: 'd',
      heightRange: [100, null],
      ...overrides,
    });

  const lookup = async (dir: string, key: Buffer) => {
    const manifest = parseManifest(
      await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
    );
    const reader = new PartitionedCdb64Reader({ manifest, baseDir: dir, log });
    await reader.open();
    try {
      const value = await reader.get(key);
      return value === undefined ? undefined : decodeCdb64Value(value);
    } finally {
      await reader.close();
    }
  };

  const listDir = async (dir: string) =>
    fs.readdir(dir).catch(() => [] as string[]);

  it('publishes a band that the index-swarm kind describes and validates', async () => {
    const records: BandRecord[] = [
      {
        id: id32(1),
        rootTxId: id32(101),
        height: 120,
        rootOffset: 1000,
        rootDataOffset: 1100,
        size: 600,
      },
      { id: id32(2), rootTxId: id32(102), height: 130 },
    ];
    const band = await build(records, { supersedes: ['d-h100-tip-old'] });

    assert.equal(band.published, true);
    assert.equal(band.records, 2);
    assert.equal(band.rootOnly, 1);
    assert.equal(band.dir, path.join(publishDir, band.id));
    assert.deepEqual(await listDir(publishDir), [band.id]);

    const manifest = parseManifest(
      await fs.readFile(path.join(band.dir!, 'manifest.json'), 'utf8'),
    );
    assert.deepEqual(manifest.metadata?.heightRange, [100, null]);
    assert.deepEqual(manifest.metadata?.supersedes, ['d-h100-tip-old']);

    const kind = new Cdb64RootTxKind({ log });
    const descriptor = await kind.describe(band.dir!);
    assert.equal(descriptor.id, band.id);
    assert.equal(descriptor.records, 2);
    assert.deepEqual(descriptor.heightRange, [100, null]);
    await kind.validate(descriptor, band.dir!);

    const complete = await lookup(band.dir!, id32(1));
    assert.ok(complete !== undefined);
    assert.ok(getRootTxId(complete).equals(id32(101)));
    assert.equal(getDataItemSize(complete), 600);
    const simple = await lookup(band.dir!, id32(2));
    assert.ok(simple !== undefined && getRootTxId(simple).equals(id32(102)));
  });

  it('keeps the record with the higher height for a duplicate ID', async () => {
    const band = await build([
      { id: id32(3), rootTxId: id32(201), height: 150 },
      { id: id32(3), rootTxId: id32(202), height: 140 },
    ]);

    assert.equal(band.records, 1);
    assert.equal(band.duplicates, 1);
    const value = await lookup(band.dir!, id32(3));
    assert.ok(value !== undefined && getRootTxId(value).equals(id32(201)));
  });

  it('keeps the later record among equal or missing heights', async () => {
    const band = await build([
      { id: id32(4), rootTxId: id32(301) },
      { id: id32(4), rootTxId: id32(302) },
      { id: id32(5), rootTxId: id32(303), height: 10 },
      { id: id32(5), rootTxId: id32(304), height: 10 },
    ]);

    const four = await lookup(band.dir!, id32(4));
    const five = await lookup(band.dir!, id32(5));
    assert.ok(four !== undefined && getRootTxId(four).equals(id32(302)));
    assert.ok(five !== undefined && getRootTxId(five).equals(id32(304)));
  });

  it('drops records with one offset or an impossible size', async () => {
    const band = await build([
      { id: id32(6), rootTxId: id32(1), rootOffset: 10 },
      {
        id: id32(7),
        rootTxId: id32(1),
        rootOffset: 100,
        rootDataOffset: 200,
        size: 50,
      },
      { id: id32(8), rootTxId: id32(1) },
    ]);

    assert.equal(band.dropped, 2);
    assert.equal(band.records, 1);
    assert.equal(await lookup(band.dir!, id32(6)), undefined);
    assert.equal(await lookup(band.dir!, id32(7)), undefined);
  });

  it('names bands by kind, heights, publisher and content', async () => {
    const records = [{ id: id32(9), rootTxId: id32(10), height: 5 }];
    const tip = await build(records);
    assert.match(tip.id, /^d-h100-tip-[0-9a-f]{8}-[0-9a-f]{12}$/);

    const closed = await build(records, {
      kind: 'r',
      heightRange: [100, 199],
    });
    assert.match(closed.id, /^r-h100-199-/);

    const other = await build(records, { publisher: 'another-wallet' });
    assert.notEqual(other.id.split('-')[3], tip.id.split('-')[3]);

    const superseding = await build(records, { supersedes: [tip.id] });
    assert.notEqual(superseding.id, tip.id);
  });

  it('gives the same id for the same records in any order', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: id32(i + 20),
      rootTxId: id32(i + 500),
      height: i,
      rootOffset: i * 1000,
      rootDataOffset: i * 1000 + 100,
    }));
    const first = await build(records, { dryRun: true });
    const second = await build([...records].reverse(), { dryRun: true });
    assert.equal(second.id, first.id);
  });

  it('does not publish a band again, or touch it, when the content is unchanged', async () => {
    const records = [{ id: id32(11), rootTxId: id32(12) }];
    const first = await build(records);
    const manifestPath = path.join(first.dir!, 'manifest.json');
    const before = await fs.stat(manifestPath);

    const second = await build(records);

    assert.equal(second.id, first.id);
    assert.equal(second.published, false);
    assert.equal(second.unchanged, true);
    assert.equal((await fs.stat(manifestPath)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await listDir(publishDir), [first.id]);
  });

  it('builds without publishing on a dry run, and leaves no scratch files', async () => {
    const band = await build([{ id: id32(13), rootTxId: id32(14) }], {
      dryRun: true,
    });

    assert.equal(band.published, false);
    assert.equal(band.dir, undefined);
    assert.deepEqual(await listDir(publishDir), []);
    assert.deepEqual(await listDir(workDir), []);
  });

  it('samples only entries with offsets, up to the sample size', async () => {
    const records: BandRecord[] = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? {
            id: id32(i + 60),
            rootTxId: id32(1),
            rootOffset: i * 10,
            rootDataOffset: i * 10 + 5,
          }
        : { id: id32(i + 60), rootTxId: id32(1) },
    );
    const band = await build(records, { sampleSize: 8 });

    assert.equal(band.sample.length, 8);
    for (const entry of band.sample) {
      assert.equal(entry.rootDataOffset - entry.rootOffset, 5);
    }
  });

  it('cleans up and publishes nothing when the input fails part way', async () => {
    async function* failing(): AsyncGenerator<BandRecord> {
      yield { id: id32(15), rootTxId: id32(16) };
      throw new Error('source failed');
    }

    await assert.rejects(build([], { records: failing() }), /source failed/);
    assert.deepEqual(await listDir(publishDir), []);
    assert.deepEqual(await listDir(workDir), []);
  });

  it('rejects invalid options before building', async () => {
    const records = [{ id: id32(17), rootTxId: id32(18) }];
    await assert.rejects(build(records, { kind: 'Delta!' }), /kind/);
    await assert.rejects(
      build(records, { heightRange: [200, 100] }),
      /heightRange/,
    );
    await assert.rejects(
      build(records, { supersedes: ['../x'] }),
      /supersedes/,
    );
    await assert.rejects(
      build(records, { metadata: { heightRange: [0, 1] } }),
      /reserved|heightRange or supersedes/,
    );
    await assert.rejects(
      build([{ id: Buffer.alloc(8), rootTxId: id32(1) }]),
      /32 bytes/,
    );
  });
});
