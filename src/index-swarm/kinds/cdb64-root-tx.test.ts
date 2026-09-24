/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cdb64RootTxKind, MANIFEST_FILE } from './cdb64-root-tx.js';
import { createKindRegistry, kindFor } from './registry.js';
import { InstalledSet } from './types.js';
import { PartitionedCdb64Writer } from '../../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../../lib/cdb64-encoding.js';
import { parseManifest, serializeManifest } from '../../lib/cdb64-manifest.js';
import { createTestLogger } from '../../../test/test-logger.js';

const log = createTestLogger({ suite: 'cdb64-root-tx kind' });

const txId = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed + i) % 256;
  return buf;
};

describe('Cdb64RootTxKind', () => {
  let tempDir: string;
  let kind: Cdb64RootTxKind;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-kind-test-'));
    kind = new Cdb64RootTxKind({ log });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Build a real partitioned band on disk. */
  const makeBand = async (
    dir: string,
    entries = 3,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    const writer = new PartitionedCdb64Writer(dir);
    await writer.open();
    for (let i = 0; i < entries; i++) {
      await writer.add(
        txId(i * 40),
        encodeCdb64Value({ rootTxId: txId(200 + i) }),
      );
    }
    await writer.finalize();

    if (metadata !== undefined) {
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.metadata = { ...manifest.metadata, ...metadata };
      await fs.writeFile(manifestPath, serializeManifest(manifest));
    }
    return dir;
  };

  describe('describe', () => {
    it('describes a band, manifest included, sorted and hashed', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-a'));
      const band = await kind.describe(dir);

      assert.equal(band.id, 'band-a');
      assert.equal(band.records, 3);
      assert.ok(band.files.length >= 2, 'manifest plus at least one partition');
      assert.ok(
        band.files.some((f) => f.name === MANIFEST_FILE),
        'the manifest travels with the band',
      );
      const names = band.files.map((f) => f.name);
      assert.deepEqual(names, [...names].sort(), 'files are in sorted order');
      for (const file of band.files) {
        assert.match(file.sha256, /^[0-9a-f]{64}$/);
        assert.ok(file.size > 0);
      }
      // Every file named is one that is actually there.
      for (const file of band.files) {
        assert.equal(existsSync(path.join(dir, file.name)), true);
      }
    });

    it('is deterministic for unchanged bytes', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-det'));
      assert.deepEqual(await kind.describe(dir), await kind.describe(dir));
    });

    it('carries the height range and supersedes hint through', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-meta'), 2, {
        heightRange: [1950000, null],
        supersedes: 'band-old',
      });
      const band = await kind.describe(dir);

      assert.deepEqual(band.heightRange, [1950000, null]);
      assert.deepEqual(band.metadata, { supersedes: 'band-old' });
    });

    it('ignores a malformed height range rather than publishing it', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-badrange'), 2, {
        heightRange: ['not', 'numbers'],
      });
      assert.equal((await kind.describe(dir)).heightRange, undefined);
    });

    it('rejects a directory that is not a band', async () => {
      const dir = path.join(tempDir, 'not-a-band');
      await fs.mkdir(dir);
      await assert.rejects(
        () => kind.describe(dir),
        /manifest\.json is missing/,
      );
    });

    it('rejects a manifest whose partitions are all remote', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-remote'));
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      for (const partition of manifest.partitions) {
        partition.location = { type: 'http', url: 'https://example.com/x.cdb' };
      }
      await fs.writeFile(manifestPath, serializeManifest(manifest));

      // Such a manifest describes an index read remotely, not bytes to publish.
      await assert.rejects(() => kind.describe(dir), /http location/);
    });

    it('rejects a manifest with even one remote partition', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-mixed'));
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.partitions[0].location = {
        type: 'http',
        url: 'https://example.com/x.cdb',
      };
      await fs.writeFile(manifestPath, serializeManifest(manifest));
      await assert.rejects(
        () => kind.describe(dir),
        /may only carry local files/,
      );
    });
  });

  describe('validate', () => {
    it('refuses a band whose manifest points a partition at a URL', async () => {
      // What a hostile publisher would send: every digest correct, but one
      // partition's location is a URL of its choosing, which the gateway's
      // reader would fetch with no digest check.
      const dir = await makeBand(path.join(tempDir, 'band-ssrf'));
      const band = await kind.describe(dir);
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const victim = manifest.partitions[0];
      const dropped =
        victim.location.type === 'file' ? victim.location.filename : '';
      victim.location = { type: 'http', url: 'http://169.254.169.254/x.cdb' };
      const raw = serializeManifest(manifest);
      await fs.writeFile(manifestPath, raw);
      await fs.rm(path.join(dir, dropped));
      const tampered = {
        ...band,
        files: band.files
          .filter((f) => f.name !== dropped)
          .map((f) =>
            f.name === MANIFEST_FILE
              ? {
                  ...f,
                  size: Buffer.byteLength(raw),
                  sha256: crypto.createHash('sha256').update(raw).digest('hex'),
                }
              : f,
          ),
      };
      await assert.rejects(
        () => kind.validate(tampered, dir),
        /http location; a published band may only carry local files/,
      );
    });

    it('accepts a band it just described', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-ok'));
      await kind.validate(await kind.describe(dir), dir);
    });

    it('rejects a file name that is not a partition', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-badname'));
      const band = await kind.describe(dir);

      for (const bad of ['../x.cdb', '00.cdb ', 'evil.sh', 'FF.cdb']) {
        const tampered = {
          ...band,
          files: [
            ...band.files,
            { name: bad, size: 1, sha256: 'a'.repeat(64) },
          ],
        };
        await assert.rejects(
          () => kind.validate(tampered, dir),
          /which is neither manifest\.json nor a partition file/,
          `${bad} should be rejected`,
        );
      }
    });

    it('rejects a band with no manifest', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-nomanifest'));
      const band = await kind.describe(dir);
      const tampered = {
        ...band,
        files: band.files.filter((f) => f.name !== MANIFEST_FILE),
      };
      await assert.rejects(
        () => kind.validate(tampered, dir),
        /does not include manifest\.json/,
      );
    });

    it('rejects a missing file', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-missing'));
      const band = await kind.describe(dir);
      const partition = band.files.find((f) => f.name !== MANIFEST_FILE);
      assert.ok(partition !== undefined);
      await fs.unlink(path.join(dir, partition.name));

      await assert.rejects(() => kind.validate(band, dir), /is missing/);
    });

    it('rejects a size mismatch', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-size'));
      const band = await kind.describe(dir);
      const partition = band.files.find((f) => f.name !== MANIFEST_FILE);
      assert.ok(partition !== undefined);
      const tampered = {
        ...band,
        files: band.files.map((f) =>
          f.name === partition.name ? { ...f, size: f.size + 1 } : f,
        ),
      };
      await assert.rejects(
        () => kind.validate(tampered, dir),
        /bytes, expected/,
      );
    });

    it('rejects a truncated partition that is the right length on paper', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-trunc'));
      const band = await kind.describe(dir);
      const partition = band.files.find((f) => f.name !== MANIFEST_FILE);
      assert.ok(partition !== undefined);

      // Same declared size, and a zero-filled CDB64 file parses as a
      // perfectly valid *empty* database, so opening it is not enough to
      // catch this. The record count from the header is what does.
      await fs.writeFile(
        path.join(dir, partition.name),
        Buffer.alloc(partition.size),
      );

      await assert.rejects(
        () => kind.validate(band, dir),
        /holds 0 records, but the manifest declares/,
      );
    });

    it('rejects a band that carries a partition its manifest omits', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-extra'));
      const band = await kind.describe(dir);
      const stray = 'ab.cdb';
      await fs.copyFile(
        path.join(dir, band.files[1].name),
        path.join(dir, stray),
      );
      const tampered = {
        ...band,
        files: [...band.files, { ...band.files[1], name: stray }],
      };
      await assert.rejects(
        () => kind.validate(tampered, dir),
        /which the manifest does not name/,
      );
    });

    it('rejects a manifest naming a partition that is not there', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-short'));
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.partitions.push({
        prefix: 'ab',
        location: { type: 'file', filename: 'ab.cdb' },
        recordCount: 1,
        size: 1,
      });
      await fs.writeFile(manifestPath, serializeManifest(manifest));

      // Surfaced by describe, and the message should name the manifest as the
      // fault rather than surfacing a bare ENOENT.
      await assert.rejects(
        () => kind.describe(dir),
        /names ab\.cdb, which is not present/,
      );
    });

    it('rejects a partition whose record count disagrees with the manifest', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-count'));
      const band = await kind.describe(dir);
      const partition = band.files.find((f) => f.name !== MANIFEST_FILE);
      assert.ok(partition !== undefined);

      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      for (const p of manifest.partitions) {
        if (
          p.location.type === 'file' &&
          p.location.filename === partition.name
        ) {
          p.recordCount = 999;
        }
      }
      await fs.writeFile(manifestPath, serializeManifest(manifest));

      const restated = await kind.describe(dir);
      await assert.rejects(
        () => kind.validate(restated, dir),
        /records, but the manifest declares 999/,
      );
    });
  });

  describe('validate: partition structure', () => {
    /**
     * Build a band, rewrite bytes of one partition in place (same size, same
     * header slot counts, so the header-only checks still pass), and return
     * a descriptor restated over the tampered bytes.
     */
    const tamperedBand = async (
      name: string,
      tamper: (bytes: Buffer) => void,
    ) => {
      const dir = await makeBand(path.join(tempDir, name));
      const original = await kind.describe(dir);
      const partition = original.files.find((f) => f.name !== MANIFEST_FILE);
      assert.ok(partition !== undefined);
      const partitionPath = path.join(dir, partition.name);
      const bytes = await fs.readFile(partitionPath);
      tamper(bytes);
      await fs.writeFile(partitionPath, bytes);
      return { dir, band: await kind.describe(dir) };
    };

    /** The one non-empty table in a single-record partition. */
    const onlyTable = (bytes: Buffer): number => {
      for (let i = 0; i < 256; i++) {
        if (bytes.readBigUInt64LE(i * 16 + 8) > 0n) return i;
      }
      throw new Error('no table');
    };

    it('rejects a record declaring a 2^31-byte key', async () => {
      // The shape of the crash: header counts agree with the manifest, and
      // the first lookup for this key would have aborted the gateway.
      const { dir, band } = await tamperedBand('band-klen', (bytes) =>
        bytes.writeBigUInt64LE(2n ** 31n, 4096),
      );
      await assert.rejects(
        () => kind.validate(band, dir),
        /not a well-formed CDB64 file: .*key length 2147483648/,
      );
    });

    it('rejects a record declaring a huge value', async () => {
      const { dir, band } = await tamperedBand('band-vlen', (bytes) =>
        bytes.writeBigUInt64LE(2n ** 30n, 4096 + 8),
      );
      await assert.rejects(
        () => kind.validate(band, dir),
        /not a well-formed CDB64 file: .*value length 1073741824/,
      );
    });

    it('rejects a value just over the root-tx bound', async () => {
      const { dir, band } = await tamperedBand('band-vbound', (bytes) =>
        bytes.writeBigUInt64LE(BigInt(64 * 1024 + 1), 4096 + 8),
      );
      await assert.rejects(
        () => kind.validate(band, dir),
        /beyond the 32\/65536-byte bounds/,
      );
    });

    it('rejects a record that runs into the hash tables', async () => {
      const { dir, band } = await tamperedBand('band-overrun', (bytes) =>
        bytes.writeBigUInt64LE(1000n, 4096 + 8),
      );
      await assert.rejects(
        () => kind.validate(band, dir),
        /past the hash tables/,
      );
    });

    it('rejects a table pointer past the end of the file', async () => {
      const { dir, band } = await tamperedBand('band-tptr', (bytes) =>
        bytes.writeBigUInt64LE(2n ** 40n, onlyTable(bytes) * 16),
      );
      await assert.rejects(
        () => kind.validate(band, dir),
        /does not fit in the/,
      );
    });

    it('rejects a slot pointing outside the records', async () => {
      const { dir, band } = await tamperedBand('band-slot', (bytes) => {
        const table = Number(bytes.readBigUInt64LE(onlyTable(bytes) * 16));
        for (let slot = 0; slot < 2; slot++) {
          const at = table + slot * 16 + 8;
          if (bytes.readBigUInt64LE(at) !== 0n) {
            bytes.writeBigUInt64LE(2n ** 40n, at);
          }
        }
      });
      await assert.rejects(
        () => kind.validate(band, dir),
        /is not a valid entry/,
      );
    });

    it('still accepts a larger real band', async () => {
      const dir = await makeBand(path.join(tempDir, 'band-large'), 2000);
      await kind.validate(await kind.describe(dir), dir);
    });
  });

  describe('install, retire and sweep', () => {
    it('installs a band atomically and records it', async () => {
      const source = await makeBand(path.join(tempDir, 'incoming', 'band-1'));
      const band = await kind.describe(source);
      const targetDir = path.join(tempDir, 'installed', 'band-1');

      const installed = await kind.install({
        band,
        sourceDir: source,
        targetDir,
        current: {},
      });

      assert.equal(existsSync(source), false, 'source is moved, not copied');
      assert.equal(existsSync(path.join(targetDir, MANIFEST_FILE)), true);
      assert.equal(installed['band-1'].dir, targetDir);
      assert.deepEqual(installed['band-1'].files, band.files);
      assert.match(installed['band-1'].installedAt, /^\d{4}-/);
    });

    it('replaces a directory left by an interrupted attempt', async () => {
      const targetDir = path.join(tempDir, 'installed', 'band-2');
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, 'stale.txt'), 'leftover');

      const source = await makeBand(path.join(tempDir, 'incoming', 'band-2'));
      const band = await kind.describe(source);
      await kind.install({ band, sourceDir: source, targetDir, current: {} });

      assert.equal(existsSync(path.join(targetDir, 'stale.txt')), false);
      assert.equal(existsSync(path.join(targetDir, MANIFEST_FILE)), true);
    });

    it('retires by removing the manifest, leaving the files for the sweep', async () => {
      const source = await makeBand(path.join(tempDir, 'incoming', 'band-3'));
      const band = await kind.describe(source);
      const targetDir = path.join(tempDir, 'installed', 'band-3');
      let set = await kind.install({
        band,
        sourceDir: source,
        targetDir,
        current: {},
      });

      set = await kind.retire({
        bandId: 'band-3',
        dir: targetDir,
        current: set,
      });

      // The manifest is what the gateway keys off, so its removal is what
      // takes the band out of service.
      assert.equal(existsSync(path.join(targetDir, MANIFEST_FILE)), false);
      // The partitions stay, so a reader mid-lookup keeps its open bytes.
      assert.equal(existsSync(targetDir), true);
      assert.ok(set['band-3'].retiredAt !== undefined);
    });

    it('keeps a retired band until its grace period is up', async () => {
      const targetDir = path.join(tempDir, 'installed', 'band-4');
      await fs.mkdir(targetDir, { recursive: true });
      const current: InstalledSet = {
        'band-4': {
          dir: targetDir,
          files: [],
          installedAt: new Date().toISOString(),
          retiredAt: new Date().toISOString(),
        },
      };

      const kept = await kind.sweepRetired({
        current,
        dirFor: () => targetDir,
        graceMs: 60_000,
      });
      assert.ok(kept['band-4'] !== undefined);
      assert.equal(existsSync(targetDir), true);

      const swept = await kind.sweepRetired({
        current: kept,
        dirFor: () => targetDir,
        graceMs: 0,
      });
      assert.equal(swept['band-4'], undefined);
      assert.equal(existsSync(targetDir), false);
    });

    it('leaves bands that were never retired alone', async () => {
      const current: InstalledSet = {
        live: {
          dir: path.join(tempDir, 'installed', 'live'),
          files: [],
          installedAt: new Date().toISOString(),
        },
      };
      const swept = await kind.sweepRetired({
        current,
        dirFor: (id) => path.join(tempDir, 'installed', id),
        graceMs: 0,
      });
      assert.deepEqual(swept, current);
    });

    it('sweeps a band whose retiredAt is unreadable rather than keeping it forever', async () => {
      const targetDir = path.join(tempDir, 'installed', 'band-bad-ts');
      await fs.mkdir(targetDir, { recursive: true });
      const swept = await kind.sweepRetired({
        current: {
          'band-bad-ts': {
            dir: targetDir,
            files: [],
            installedAt: '',
            retiredAt: 'not a timestamp',
          },
        },
        dirFor: () => targetDir,
        graceMs: 60_000,
      });
      assert.equal(swept['band-bad-ts'], undefined);
    });

    it('describes, validates, installs and retires end to end', async () => {
      const source = await makeBand(
        path.join(tempDir, 'incoming', 'band-e2e'),
        5,
      );
      const band = await kind.describe(source);
      await kind.validate(band, source);

      const targetDir = path.join(tempDir, 'installed', 'band-e2e');
      let set = await kind.install({
        band,
        sourceDir: source,
        targetDir,
        current: {},
      });
      // An installed band still validates where it now lives.
      await kind.validate(band, targetDir);

      set = await kind.retire({
        bandId: band.id,
        dir: targetDir,
        current: set,
      });
      set = await kind.sweepRetired({
        current: set,
        dirFor: () => targetDir,
        graceMs: 0,
      });

      assert.deepEqual(set, {});
      assert.equal(existsSync(targetDir), false);
    });
  });

  describe('registry', () => {
    it('resolves the cdb64 kind and nothing else', () => {
      const registry = createKindRegistry({ log });

      assert.equal(kindFor(registry, 'cdb64-root-tx')?.kind, 'cdb64-root-tx');
      // A publisher offering a kind this node does not understand is normal;
      // the caller counts it and carries on with the kinds it can use.
      assert.equal(kindFor(registry, 'parquet-export'), undefined);
      assert.equal(kindFor(registry, ''), undefined);
    });
  });
});
