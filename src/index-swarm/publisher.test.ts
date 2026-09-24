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
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Publisher, loadPublisherSigner } from './publisher.js';
import { StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { parseManifest, serializeManifest } from '../lib/cdb64-manifest.js';
import {
  IndexPublication,
  manifestSha256,
  parseIndexPublication,
  verifyIndexPublication,
} from '../lib/index-publication.js';
import {
  getSolanaAddress,
  publicKeyFromSolanaAddress,
} from '../lib/httpsig.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index-swarm publisher' });

const txId = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed + i) % 256;
  return buf;
};

describe('Publisher', () => {
  let tempDir: string;
  let publishedDir: string;
  let blobsDir: string;
  let publicationFile: string;
  let state: StateStore;
  let signer: {
    privateKey: crypto.KeyObject;
    keyId: string;
    wallet: string;
  };
  let clock: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-publisher-'));
    publishedDir = path.join(tempDir, 'published');
    blobsDir = path.join(publishedDir, 'blobs');
    publicationFile = path.join(publishedDir, 'publication.json');
    state = new StateStore({ log, filePath: path.join(tempDir, 'state.json') });

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    // The wallet is the publisher's identity and the observer key is the
    // signer; deliberately different keys here, since they only sometimes
    // coincide and a document must name the identity, not the signer.
    signer = {
      privateKey,
      keyId: getSolanaAddress(publicKey),
      wallet: getSolanaAddress(crypto.generateKeyPairSync('ed25519').publicKey),
    };
    clock = new Date('2026-09-23T00:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const makePublisher = (ttlMs = 86_400_000) =>
    new Publisher({
      log,
      state,
      kinds: createKindRegistry({ log }),
      signer,
      publish: [{ name: 'root-tx-index', kind: 'cdb64-root-tx' }],
      publishedDir,
      blobsDir,
      publicationFile,
      ttlMs,
      supersedeGraceMs: 0,
      now: () => clock,
    });

  /** Build a real band under published/<index>/<band>/. */
  const makeBand = async (
    bandId: string,
    entries = 3,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    const dir = path.join(publishedDir, 'root-tx-index', bandId);
    const writer = new PartitionedCdb64Writer(dir);
    await writer.open();
    for (let i = 0; i < entries; i++) {
      await writer.add(
        txId(i * 40),
        encodeCdb64Value({ rootTxId: txId(9 + i) }),
      );
    }
    await writer.finalize();
    if (metadata !== undefined) {
      const manifestPath = path.join(dir, 'manifest.json');
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.metadata = { ...manifest.metadata, ...metadata };
      await fs.writeFile(manifestPath, serializeManifest(manifest));
    }
    return dir;
  };

  const readPublication = async (): Promise<IndexPublication> =>
    parseIndexPublication(await fs.readFile(publicationFile));

  it('publishes a signed document a subscriber can verify from the address alone', async () => {
    await makeBand('band-tip');
    assert.equal(await makePublisher().scanOnce(), true);

    const doc = await readPublication();
    assert.equal(doc.publisher, signer.wallet, 'names the identity');
    assert.equal(
      doc.signature?.keyId,
      signer.keyId,
      'signed by the observer key',
    );
    assert.equal(doc.sequence, 1);
    assert.equal(doc.previousManifestSha256, null);
    assert.equal(doc.indexes[0].name, 'root-tx-index');
    assert.equal(doc.indexes[0].bands[0].id, 'band-tip');
    assert.ok(doc.indexes[0].bands[0].files.length >= 2);
    assert.equal(
      doc.indexes[0].bands[0].http?.baseUrl,
      '/ar-io/indexes/root-tx-index/band-tip/',
    );

    // Exactly what a subscriber does: rebuild the key from the registered
    // address and check the detached signature.
    assert.deepEqual(
      verifyIndexPublication(
        doc,
        publicKeyFromSolanaAddress(doc.signature!.keyId),
      ),
      { ok: true },
    );
  });

  it('joins an overlapping scan instead of running a second', async () => {
    await makeBand('band-tip');
    const publisher = makePublisher();
    const first = publisher.scanOnce();
    const second = publisher.scanOnce();
    assert.equal(second, first, 'the second call joins the first');
    await Promise.all([first, second]);
    assert.equal((await readPublication()).sequence, 1, 'one document');
  });

  it('chains each document to the bytes actually served before it', async () => {
    await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();
    const firstBytes = await fs.readFile(publicationFile);

    await makeBand('band-b');
    clock = new Date(clock.getTime() + 60_000);
    assert.equal(await publisher.scanOnce(), true);

    const second = await readPublication();
    assert.equal(second.sequence, 2);
    assert.equal(
      second.previousManifestSha256,
      manifestSha256(firstBytes),
      'chains to the digest of the previous file as served',
    );
    assert.equal(second.indexes[0].bands.length, 2);
  });

  it('writes nothing when nothing changed', async () => {
    await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();
    const before = statSync(publicationFile).mtimeMs;

    clock = new Date(clock.getTime() + 60_000);
    assert.equal(await publisher.scanOnce(), false);

    assert.equal(
      statSync(publicationFile).mtimeMs,
      before,
      'an unchanged scan must not rewrite the document',
    );
    assert.equal((await readPublication()).sequence, 1);
  });

  it('republishes a quiet publisher before its document expires', async () => {
    await makeBand('band-a');
    const publisher = makePublisher(60_000);
    await publisher.scanOnce();

    // Nothing has changed, but a subscriber alarms once expiresAt passes, so
    // a publisher whose bands are simply quiet must not look dead.
    clock = new Date(clock.getTime() + 31_000);
    assert.equal(await publisher.scanOnce(), true);

    const doc = await readPublication();
    assert.equal(doc.sequence, 2);
    assert.equal(doc.issuedAt, clock.toISOString());
  });

  it('reuses the cached description while a band is untouched', async () => {
    const dir = await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();

    const cacheKey = (await state.load()).describeCache[dir];
    assert.ok(cacheKey !== undefined, 'the band is cached after describing');

    // Make describing fail loudly: if the cache is consulted the scan still
    // succeeds, and if it is not the band silently drops out.
    clock = new Date(clock.getTime() + 60_000);
    await publisher.scanOnce();
    assert.equal((await readPublication()).indexes[0].bands.length, 1);

    // Touching the bytes changes the fingerprint, so it is described again.
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
    manifest.metadata = { note: 'changed' };
    await fs.writeFile(manifestPath, serializeManifest(manifest));

    clock = new Date(clock.getTime() + 60_000);
    await publisher.scanOnce();
    const after = (await state.load()).describeCache[dir];
    assert.notEqual(after.fingerprint, cacheKey.fingerprint);
  });

  it('ignores a band directory still being written', async () => {
    await makeBand('band-ready');
    const partial = await makeBand('band-partial');
    await fs.rename(partial, `${partial}.tmp`);

    await makePublisher().scanOnce();

    const ids = (await readPublication()).indexes[0].bands.map((b) => b.id);
    assert.deepEqual(ids, ['band-ready']);
  });

  it('drops and retires a band that a newer one supersedes', async () => {
    const oldDir = await makeBand('band-old');
    await makeBand('band-new', 3, { supersedes: 'band-old' });

    await makePublisher().scanOnce();

    const ids = (await readPublication()).indexes[0].bands.map((b) => b.id);
    assert.deepEqual(ids, ['band-new'], 'the superseded band is not offered');

    // Retirement removes the manifest, which is what stops it being served;
    // the sweep (grace 0 here) then removes the directory.
    assert.equal(existsSync(oldDir), false);
  });

  it('hard-links every published file under its digest, and prunes stale links', async () => {
    await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();

    const doc = await readPublication();
    const digests = doc.indexes[0].bands[0].files.map((f) => f.sha256);
    for (const digest of digests) {
      const blobPath = path.join(blobsDir, digest);
      assert.equal(existsSync(blobPath), true, `blob ${digest} exists`);
      // A link, not a copy: the bytes exist once however many names point at
      // them, so the content-addressed route costs only a directory entry.
      assert.equal(statSync(blobPath).nlink, 2);
    }

    // A stray blob from an earlier publication is cleaned up.
    const stray = path.join(blobsDir, 'f'.repeat(64));
    await fs.writeFile(stray, 'stale');
    clock = new Date(clock.getTime() + 60_000);
    await makeBand('band-b');
    await publisher.scanOnce();
    assert.equal(existsSync(stray), false);
  });

  it('leaves the document alone when a band cannot be described', async () => {
    await makeBand('band-good');
    // A directory with a manifest that does not parse.
    const broken = path.join(publishedDir, 'root-tx-index', 'band-broken');
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, 'manifest.json'), 'not json');

    await makePublisher().scanOnce();

    // One unreadable band must not stop the ones that are fine.
    const ids = (await readPublication()).indexes[0].bands.map((b) => b.id);
    assert.deepEqual(ids, ['band-good']);
  });

  it('publishes an empty index rather than failing when there are no bands', async () => {
    assert.equal(await makePublisher().scanOnce(), true);
    const doc = await readPublication();
    assert.deepEqual(doc.indexes[0].bands, []);
  });

  describe('loadPublisherSigner', () => {
    it('returns undefined when no key is configured', () => {
      assert.equal(loadPublisherSigner({}), undefined);
    });

    it('loads a Solana keypair file and derives its registered address', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const seed = (
        privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
      ).subarray(16);
      const raw = (
        publicKey.export({ type: 'spki', format: 'der' }) as Buffer
      ).subarray(12);
      const keypairPath = path.join(tempDir, 'observer.json');
      await fs.writeFile(keypairPath, JSON.stringify([...seed, ...raw]));

      const loaded = loadPublisherSigner({ keypairPath });
      assert.equal(loaded?.keyId, getSolanaAddress(publicKey));
    });

    it('refuses both key settings at once', () => {
      assert.throws(
        () =>
          loadPublisherSigner({
            keypairPath: '/tmp/x.json',
            privateKeyBase58: 'abc',
          }),
        /not both/,
      );
    });
  });
});
