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

import {
  buildBand,
  BandRecord,
  MAX_HEADER_BYTES,
  STALE_STAGING_MS,
  Reservoir,
  StagedBand,
} from './build.js';
import { Cdb64RootTxKind } from '../../index-swarm/kinds/cdb64-root-tx.js';
import {
  decodeCdb64Value,
  getDataItemSize,
  getRootTxId,
  isCompleteValue,
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

  it('breaks ties among equal or missing heights the same way in any input order', async () => {
    // Different roots for one ID at the same (or no) height: which one wins
    // must not depend on the order the source returned them in, or the band
    // id would change between identical rebuilds.
    const records: BandRecord[] = [
      { id: id32(4), rootTxId: id32(301) },
      { id: id32(4), rootTxId: id32(302) },
      { id: id32(5), rootTxId: id32(304), height: 10 },
      { id: id32(5), rootTxId: id32(303), height: 10 },
      {
        id: id32(6),
        rootTxId: id32(305),
        height: 10,
        rootOffset: 0,
        rootDataOffset: 100,
      },
      {
        id: id32(6),
        rootTxId: id32(305),
        height: 10,
        rootOffset: 500,
        rootDataOffset: 600,
      },
    ];
    const forward = await build(records);
    const reversed = await build([...records].reverse(), {
      publishDir: path.join(root, 'published-reversed'),
    });

    assert.equal(reversed.id, forward.id);
    for (const id of [id32(4), id32(5), id32(6)]) {
      assert.deepEqual(
        await lookup(reversed.dir!, id),
        await lookup(forward.dir!, id),
      );
    }
  });

  it('drops records with invalid offsets or heights, and keeps offsets over a bad size', async () => {
    const band = await build([
      // Only one offset.
      { id: id32(6), rootTxId: id32(1), rootOffset: 10 },
      // Offsets reversed, equal, negative, beyond safe integers, or spanning
      // a header longer than any real one.
      { id: id32(20), rootTxId: id32(1), rootOffset: 500, rootDataOffset: 100 },
      { id: id32(21), rootTxId: id32(1), rootOffset: 100, rootDataOffset: 100 },
      { id: id32(22), rootTxId: id32(1), rootOffset: -1, rootDataOffset: -1 },
      {
        id: id32(23),
        rootTxId: id32(1),
        rootOffset: 2 ** 60,
        rootDataOffset: 2 ** 60 + 10,
      },
      {
        id: id32(24),
        rootTxId: id32(1),
        rootOffset: 0,
        rootDataOffset: MAX_HEADER_BYTES + 1,
      },
      // Heights that aren't non-negative integers.
      { id: id32(25), rootTxId: id32(1), height: Number.NaN },
      { id: id32(26), rootTxId: id32(1), height: -5 },
      { id: id32(27), rootTxId: id32(1), height: 1.5 },
      // A size smaller than the header: the size goes, the offsets stay.
      {
        id: id32(7),
        rootTxId: id32(1),
        rootOffset: 100,
        rootDataOffset: 200,
        size: 50,
      },
      { id: id32(8), rootTxId: id32(1) },
    ]);

    assert.equal(band.dropped, 9);
    assert.equal(band.sizeDropped, 1);
    assert.equal(band.records, 2);
    for (const seed of [6, 20, 21, 22, 23, 24, 25, 26, 27]) {
      assert.equal(
        await lookup(band.dir!, id32(seed)),
        undefined,
        `seed ${seed}`,
      );
    }
    const kept = await lookup(band.dir!, id32(7));
    assert.ok(kept !== undefined && isCompleteValue(kept));
    assert.equal(kept.rootDataItemOffset, 100);
    assert.equal(getDataItemSize(kept), undefined);
  });

  it('never lets an invalid newer record hide a valid older one', async () => {
    const band = await build([
      {
        id: id32(30),
        rootTxId: id32(301),
        height: 10,
        rootOffset: 5,
        rootDataOffset: 50,
      },
      { id: id32(30), rootTxId: id32(302), height: 20, rootOffset: 7 },
    ]);

    const value = await lookup(band.dir!, id32(30));
    assert.ok(value !== undefined && getRootTxId(value).equals(id32(301)));
  });

  it('prefers an entry with offsets at the same height', async () => {
    const band = await build([
      {
        id: id32(31),
        rootTxId: id32(311),
        height: 10,
        rootOffset: 5,
        rootDataOffset: 50,
      },
      { id: id32(31), rootTxId: id32(311), height: 10 },
    ]);

    const value = await lookup(band.dir!, id32(31));
    assert.ok(value !== undefined && isCompleteValue(value));
  });

  it('refuses a band with no valid entries, and publishes nothing', async () => {
    await assert.rejects(build([]), /would be empty/);
    await assert.rejects(
      build([{ id: id32(32), rootTxId: id32(1), rootOffset: 1 }]),
      /would be empty: 1 of the records/,
    );
    assert.deepEqual(await listDir(publishDir), []);
    assert.deepEqual(await listDir(workDir), []);
  });

  it('runs beforePublish on the staged band, and discards a band it declines', async () => {
    const records = [
      { id: id32(33), rootTxId: id32(1), rootOffset: 0, rootDataOffset: 10 },
    ];
    let seen: StagedBand | undefined;
    const declined = await build(records, {
      beforePublish: async (band) => {
        seen = band;
        assert.ok(
          (await fs.stat(path.join(band.dir, 'manifest.json'))).isFile(),
        );
        assert.deepEqual(await listDir(publishDir), [], 'not yet published');
        return { publish: false, reasons: ['gate failed'] };
      },
    });

    assert.equal(seen?.id, declined.id);
    assert.equal(seen?.sample.length, 1);
    assert.equal(declined.published, false);
    assert.deepEqual(declined.rejected, ['gate failed']);
    assert.deepEqual(await listDir(publishDir), []);
    assert.deepEqual(await listDir(workDir), []);

    const accepted = await build(records, {
      beforePublish: async () => ({ publish: true }),
    });
    assert.equal(accepted.published, true);
    assert.deepEqual(await listDir(publishDir), [accepted.id]);
  });

  it('refuses to publish over something at the target that is not a band', async () => {
    const records = [{ id: id32(34), rootTxId: id32(1) }];
    const { id } = await build(records, { dryRun: true });
    await fs.mkdir(path.join(publishDir, id), { recursive: true });

    await assert.rejects(build(records), /exists but is not a band/);
  });

  it('refuses a target whose manifest is empty or torn, rather than call it published', async () => {
    const records = [{ id: id32(35), rootTxId: id32(1) }];
    const { id } = await build(records, { dryRun: true });
    await fs.mkdir(path.join(publishDir, id), { recursive: true });
    await fs.writeFile(path.join(publishDir, id, 'manifest.json'), '');

    await assert.rejects(build(records), /exists but is not a band/);
  });

  it('publishes once when two builds of the same band race', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: id32(i + 40),
      rootTxId: id32(i + 900),
    }));
    const [a, b] = await Promise.all([
      build(records),
      build(records, { workDir: path.join(root, 'export-2') }),
    ]);

    assert.equal(a.id, b.id);
    assert.equal(
      [a, b].filter((r) => r.published).length,
      1,
      'exactly one build publishes',
    );
    assert.ok([a, b].some((r) => r.unchanged));
    assert.deepEqual(await listDir(publishDir), [a.id]);
  });

  it('removes staging an interrupted build left a day ago, and leaves a fresh one', async () => {
    await fs.mkdir(workDir, { recursive: true });
    const stale = path.join(workDir, '.band-build-stale1');
    const fresh = path.join(workDir, '.band-build-fresh1');
    const longRunning = path.join(workDir, '.band-build-long1');
    const other = path.join(workDir, 'not-staging');
    for (const dir of [stale, fresh, longRunning, other]) await fs.mkdir(dir);
    // A build that has run for over a day writes into a subdirectory, which
    // leaves its staging directory's own mtime old.
    await fs.mkdir(path.join(longRunning, 'scatter'));
    await fs.writeFile(path.join(longRunning, 'scatter', '00.frames'), 'x');
    // A symlink loop inside stale staging: the walk must not follow it.
    await fs.symlink(stale, path.join(stale, 'loop'));
    const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
    for (const dir of [stale, other, longRunning]) {
      await fs.utimes(dir, old, old);
    }
    await fs.lutimes(path.join(stale, 'loop'), old, old);
    // And a link out to a directory being written now: followed, it would
    // make the stale staging look fresh.
    await fs.symlink(fresh, path.join(stale, 'out'));
    await fs.lutimes(path.join(stale, 'out'), old, old);
    await fs.utimes(stale, old, old); // adding the links touched it

    await build([{ id: id32(60), rootTxId: id32(61) }]);

    const left = await listDir(workDir);
    assert.ok(!left.includes('.band-build-stale1'), 'stale staging removed');
    assert.ok(
      left.includes('.band-build-fresh1'),
      'a running build is untouched',
    );
    assert.ok(
      left.includes('.band-build-long1'),
      'a long-running build, still writing below its top level, is untouched',
    );
    assert.ok(left.includes('not-staging'), 'other directories are untouched');
  });

  it('refuses a workDir inside publishDir', async () => {
    await assert.rejects(
      build([{ id: id32(35), rootTxId: id32(1) }], {
        workDir: path.join(publishDir, 'scratch'),
      }),
      /must not be inside publishDir/,
    );
  });

  it('fails cleanly, without crashing, when a scatter file cannot be written', async () => {
    async function* records(): AsyncGenerator<BandRecord> {
      yield {
        id: Buffer.concat([Buffer.from([1]), id32(36).subarray(1)]),
        rootTxId: id32(1),
      };
      // Make the next partition's scatter file impossible to open.
      const staging = (await fs.readdir(workDir)).find((name) =>
        name.startsWith('.band-build-'),
      );
      await fs.mkdir(path.join(workDir, staging!, 'scatter', '02.frames'));
      yield {
        id: Buffer.concat([Buffer.from([2]), id32(37).subarray(1)]),
        rootTxId: id32(1),
      };
      yield {
        id: Buffer.concat([Buffer.from([3]), id32(38).subarray(1)]),
        rootTxId: id32(1),
      };
    }

    await assert.rejects(
      build([], { records: records() }),
      /EISDIR|illegal operation/,
    );
    assert.deepEqual(await listDir(publishDir), []);
    assert.deepEqual(await listDir(workDir), []);
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
    assert.equal(superseding.contentDigest, tip.contentDigest, 'same entries');

    const different = await build([
      { id: id32(9), rootTxId: id32(11), height: 5 },
    ]);
    assert.notEqual(different.id, tip.id, 'different entries, different id');
    assert.notEqual(different.contentDigest, tip.contentDigest);
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

  it('skips the check before publishing when an identical band is already published', async () => {
    const records = [{ id: id32(70), rootTxId: id32(71) }];
    await build(records);
    let checks = 0;
    const again = await build(records, {
      beforePublish: async () => {
        checks += 1;
        return { publish: true };
      },
    });

    assert.equal(again.unchanged, true);
    assert.equal(checks, 0, 'no header check for a band already published');
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

  it('samples uniformly (reservoir sampling)', () => {
    // A seeded generator, so the check is deterministic.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const hits = new Array(100).fill(0);
    for (let trial = 0; trial < 2000; trial++) {
      const reservoir = new Reservoir<number>(10, random);
      for (let i = 0; i < 100; i++) reservoir.offer(i);
      for (const i of reservoir.items) hits[i] += 1;
    }
    // Each item is kept with probability 10/100: about 200 of 2000 trials.
    for (const count of hits) {
      assert.ok(count > 140 && count < 260, `kept ${count} times`);
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
