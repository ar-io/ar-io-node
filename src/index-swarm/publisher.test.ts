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

import {
  Publisher,
  loadPublisherSigner,
  supersededBands,
} from './publisher.js';
import { publishTotal } from './metrics.js';
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

  it('keeps counting from the served document when its state is lost', async () => {
    await makeBand('band-a');
    await makePublisher().scanOnce();
    await makeBand('band-b');
    await makePublisher().scanOnce();
    assert.equal((await readPublication()).sequence, 2);

    // State is re-derivable and may be reset to empty; publication.json,
    // which subscribers have already seen, survives.
    await fs.rm(path.join(tempDir, 'state.json'), { force: true });
    state = new StateStore({ log, filePath: path.join(tempDir, 'state.json') });
    await makeBand('band-c');
    await makePublisher().scanOnce();

    assert.equal(
      (await readPublication()).sequence,
      3,
      'not 1, which every subscriber would refuse',
    );
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

  // `.tmp.<pid>` is what the partitioned writers create; bare `.tmp` is the
  // older convention.
  for (const suffix of ['.tmp', `.tmp.${process.pid}`]) {
    it(`ignores a band directory still being written (${suffix})`, async () => {
      await makeBand('band-ready');
      const partial = await makeBand('band-partial');
      await fs.rename(partial, `${partial}${suffix}`);

      await makePublisher().scanOnce();

      const ids = (await readPublication()).indexes[0].bands.map((b) => b.id);
      assert.deepEqual(ids, ['band-ready']);
    });
  }

  it("keeps its records apart from a subscriber's on the same node", async () => {
    // A node can publish and subscribe to the same index name; one role must
    // never overwrite the other's band records.
    await state.update((draft) => {
      draft.installed['root-tx-index'] = {
        'band-old': {
          dir: '/subscriber/installed/root-tx-index/band-old~abc',
          files: [],
          installedAt: '',
          publisher: 'SomeOtherPublisher',
        },
      };
    });
    await makeBand('band-old');
    await makeBand('band-new', 3, { supersedes: 'band-old' });

    await makePublisher().scanOnce();

    const after = await state.load();
    assert.equal(
      after.installed['root-tx-index']['band-old'].dir,
      '/subscriber/installed/root-tx-index/band-old~abc',
      "the subscriber's record is untouched",
    );
    assert.equal(
      after.installed['root-tx-index']['band-old'].retiredAt,
      undefined,
    );
    // (Its own record of the retirement is swept at once: grace is 0 here.)
  });

  const failedScans = async () =>
    (await publishTotal.get()).values
      .filter((v) => v.labels.result === 'failed')
      .reduce((sum, v) => sum + v.value, 0);

  // Root ignores directory permissions, so an unreadable band can't be staged.
  it(
    'keeps the current document when a published band is briefly unreadable',
    {
      skip: process.getuid?.() === 0,
    },
    async () => {
      const dir = await makeBand('band-a');
      await makeBand('band-b');
      const publisher = makePublisher();
      await publisher.scanOnce();
      const before = await readPublication();
      const failed = await failedScans();

      await fs.chmod(dir, 0o000);
      try {
        clock = new Date(clock.getTime() + 60_000);
        await assert.rejects(publisher.scanOnce(), /could not be described/);
        const after = await readPublication();
        assert.equal(
          after.sequence,
          before.sequence,
          'nothing was republished',
        );
        assert.deepEqual(
          after.indexes[0].bands.map((b) => b.id),
          ['band-a', 'band-b'],
          'the unreadable band is still offered',
        );
        assert.equal(await failedScans(), failed + 1, 'the failure is counted');
      } finally {
        await fs.chmod(dir, 0o755);
      }
    },
  );

  it('skips a band directory whose name is not a valid band id', async () => {
    await makeBand('band-a');
    await makeBand('band b');

    await makePublisher().scanOnce();

    // Parsing validates the whole document, as every subscriber does.
    const doc = await readPublication();
    assert.deepEqual(
      doc.indexes[0].bands.map((b) => b.id),
      ['band-a'],
    );
  });

  it('refuses a band holding a symlink', async () => {
    await makeBand('band-a');
    const dir = await makeBand('band-link');
    const manifest = parseManifest(
      await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
    );
    const victim = (manifest.partitions[0].location as { filename: string })
      .filename;
    const elsewhere = path.join(tempDir, 'elsewhere.cdb');
    await fs.rename(path.join(dir, victim), elsewhere);
    await fs.symlink(elsewhere, path.join(dir, victim));

    await makePublisher().scanOnce();

    const doc = await readPublication();
    assert.deepEqual(
      doc.indexes[0].bands.map((b) => b.id),
      ['band-a'],
    );
  });

  it('ignores a band that supersedes itself, and bands that supersede each other', async () => {
    await makeBand('band-self', 3, { supersedes: 'band-self' });
    await makeBand('band-x', 3, { supersedes: 'band-y' });
    await makeBand('band-y', 3, { supersedes: 'band-x' });

    await makePublisher().scanOnce();

    const doc = await readPublication();
    assert.deepEqual(
      doc.indexes[0].bands.map((b) => b.id).sort(),
      ['band-self', 'band-x', 'band-y'],
      'none of them retired, so none of their directories are deleted',
    );
    for (const id of ['band-self', 'band-x', 'band-y']) {
      assert.equal(
        existsSync(path.join(publishedDir, 'root-tx-index', id)),
        true,
      );
    }
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

  // Root ignores directory permissions, so the refused link can't be staged.
  it(
    'does not publish a document whose blobs could not be linked',
    {
      skip: process.getuid?.() === 0,
    },
    async () => {
      // Subscribers fetch by digest, and the gateway answers 503 for a digest
      // with no link, so such a document would advertise files nobody can get.
      await makeBand('band-a');
      await fs.mkdir(blobsDir, { recursive: true });
      await fs.chmod(blobsDir, 0o555);
      try {
        await assert.rejects(makePublisher().scanOnce(), /Could not link/);
        assert.equal(
          existsSync(publicationFile),
          false,
          'nothing was published',
        );
      } finally {
        await fs.chmod(blobsDir, 0o755);
      }
      // Once the links can be made, the next scan publishes.
      await makePublisher().scanOnce();
      assert.equal(existsSync(publicationFile), true);
    },
  );

  it('restores a missing link on a scan that changes nothing else', async () => {
    await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();
    const doc = await readPublication();
    const digest = doc.indexes[0].bands[0].files[0].sha256;
    await fs.rm(path.join(blobsDir, digest));

    clock = new Date(clock.getTime() + 60_000);
    await publisher.scanOnce();

    assert.equal(
      (await readPublication()).sequence,
      doc.sequence,
      'no republish',
    );
    assert.equal(
      existsSync(path.join(blobsDir, digest)),
      true,
      'link restored',
    );
  });

  it('links a digest before the document that names it is published', async () => {
    // The blob route refuses a digest with no link, so a document must never
    // be visible before its links. Make the publishing rename fail, and the
    // links must already be there.
    await makeBand('band-a');
    await fs.mkdir(path.join(publicationFile, 'occupied'), { recursive: true });

    await assert.rejects(makePublisher().scanOnce());

    const linked = await fs.readdir(blobsDir);
    assert.ok(linked.length > 0, 'the band files were linked first');
    for (const digest of linked) {
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
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

describe('supersededBands', () => {
  const band = (id: string, supersedes?: string | string[]) => ({
    id,
    files: [],
    ...(supersedes !== undefined ? { metadata: { supersedes } } : {}),
  });

  it('retires down a chain', () => {
    assert.deepEqual(
      [...supersededBands([band('c', 'b'), band('b', 'a'), band('a')])].sort(),
      ['a', 'b'],
    );
  });

  it('drops a longer cycle but keeps an unrelated claim', () => {
    assert.deepEqual(
      [
        ...supersededBands([
          band('a', 'b'),
          band('b', 'c'),
          band('c', 'a'),
          band('new', 'old'),
          band('old'),
        ]),
      ],
      ['old'],
    );
  });

  it('accepts a list of ids, and a claim on a band not in the set', () => {
    assert.deepEqual(
      [
        ...supersededBands([band('new', ['gone', 'older']), band('older')]),
      ].sort(),
      ['gone', 'older'],
    );
  });
});
