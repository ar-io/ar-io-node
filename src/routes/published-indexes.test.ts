/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { PublishedIndexes } from './published-indexes.js';
import {
  IndexPublication,
  serializeIndexPublication,
  signIndexPublication,
} from '../lib/index-publication.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'published indexes' });

describe('PublishedIndexes', () => {
  let tempDir: string;
  let publicationFile: string;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const address = getSolanaAddress(publicKey);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'published-indexes-'));
    publicationFile = path.join(tempDir, 'publication.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const write = async (names: string[], sequence = 1): Promise<void> => {
    const doc: IndexPublication = {
      version: 1,
      publisher: address,
      sequence,
      previousManifestSha256: null,
      issuedAt: '2026-09-23T00:00:00Z',
      expiresAt: '2026-09-24T00:00:00Z',
      indexes: names.map((name) => ({
        name,
        kind: 'cdb64-root-tx',
        bands: [
          {
            id: 'band-a',
            files: [{ name: '00.cdb', size: 1, sha256: 'a'.repeat(64) }],
          },
        ],
      })),
    };
    await fs.writeFile(
      publicationFile,
      serializeIndexPublication(signIndexPublication(doc, privateKey, address)),
    );
  };

  it('has no view when nothing is published', async () => {
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    assert.equal(await indexes.current(), undefined);
  });

  it('lists index names sorted, for /ar-io/info to advertise', async () => {
    await write(['zeta-index', 'root-tx-index']);
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    assert.deepEqual((await indexes.current())?.names, [
      'root-tx-index',
      'zeta-index',
    ]);
  });

  it('reuses the view until the file changes, then rebuilds it', async () => {
    await write(['root-tx-index']);
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    const first = await indexes.current();
    assert.equal(await indexes.current(), first, 'unchanged file, same view');

    // A new document of a different size, so the change is visible to stat
    // even on a filesystem with coarse mtimes.
    await write(['root-tx-index', 'second-index'], 2);
    const second = await indexes.current();
    assert.notEqual(second, first);
    assert.deepEqual(second?.names, ['root-tx-index', 'second-index']);
  });

  it('drops the view rather than keep a stale one when the document goes bad', async () => {
    await write(['root-tx-index']);
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    assert.ok((await indexes.current()) !== undefined);

    // A stale view would keep advertising bytes the current document no
    // longer vouches for, so an unreadable document means nothing is offered.
    await fs.writeFile(publicationFile, '{ not a publication, and longer }');
    assert.equal(await indexes.current(), undefined);
  });

  it('forgets the view when the document is removed', async () => {
    await write(['root-tx-index']);
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    assert.ok((await indexes.current()) !== undefined);
    await fs.rm(publicationFile);
    assert.equal(await indexes.current(), undefined);
  });

  it('shares one rebuild among concurrent readers', async () => {
    await write(['root-tx-index']);
    const indexes = new PublishedIndexes({ log, publishedDir: tempDir });
    const views = await Promise.all(
      Array.from({ length: 20 }, () => indexes.current()),
    );
    assert.ok(views.every((view) => view === views[0]));
  });

  describe('revalidating off the request path', () => {
    /** The check in flight, if any: awaited instead of sleeping. */
    const settled = (indexes: PublishedIndexes) =>
      (indexes as unknown as { checking?: Promise<void> }).checking;

    it('answers from the view it has while a check is stuck', async () => {
      await write(['root-tx-index']);
      let clock = 0;
      let release: (() => void) | undefined;
      let stuck = false;
      let pendingStats = 0;
      const indexes = new PublishedIndexes({
        log,
        publishedDir: tempDir,
        revalidateMs: 5_000,
        now: () => clock,
        stat: async (file) => {
          // A stat queued behind a saturated thread pool.
          if (stuck) {
            pendingStats++;
            await new Promise<void>((resolve) => (release = resolve));
          }
          return fs.stat(file);
        },
      });
      const first = await indexes.current();
      assert.ok(first !== undefined, 'the first request waits for the view');

      stuck = true;
      clock += 10_000;
      assert.equal(await indexes.current(), first, 'served while checking');
      assert.equal(await indexes.current(), first);
      assert.equal(pendingStats, 1, 'one check, still unfinished, shared');
      release?.();
      await settled(indexes);
    });

    it('picks up a republished document once the check has run', async () => {
      await write(['root-tx-index'], 1);
      let clock = 0;
      const indexes = new PublishedIndexes({
        log,
        publishedDir: tempDir,
        revalidateMs: 5_000,
        now: () => clock,
      });
      assert.deepEqual((await indexes.current())?.names, ['root-tx-index']);

      await write(['root-tx-index', 'zeta-index'], 2);
      assert.deepEqual(
        (await indexes.current())?.names,
        ['root-tx-index'],
        'within the revalidation interval the previous view stands',
      );
      assert.equal(settled(indexes), undefined, 'and nothing was checked');
      clock += 5_000;
      assert.deepEqual(
        (await indexes.current())?.names,
        ['root-tx-index'],
        'the request that starts the check is answered from the old view',
      );
      await settled(indexes);
      assert.deepEqual((await indexes.current())?.names, [
        'root-tx-index',
        'zeta-index',
      ]);
    });

    it('stops serving a withdrawn document once checked', async () => {
      await write(['root-tx-index']);
      let clock = 0;
      const indexes = new PublishedIndexes({
        log,
        publishedDir: tempDir,
        revalidateMs: 5_000,
        now: () => clock,
      });
      assert.ok((await indexes.current()) !== undefined);
      await fs.rm(publicationFile);
      clock += 5_000;
      await indexes.current();
      await settled(indexes);
      assert.equal(await indexes.current(), undefined);
    });
  });
});
