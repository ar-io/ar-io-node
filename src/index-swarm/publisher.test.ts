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
  loadPublisherSigner,
  MAX_HELD_SCANS,
  magnetFor,
  Publisher,
  SEED_DIR,
  supersededBands,
} from './publisher.js';
import { MemorySwarm, MemoryTransport } from './transport/memory.js';
import { torrentIds } from './torrent.js';
import { publishTotal } from './metrics.js';
import { seedingKey, StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { parseManifest, serializeManifest } from '../lib/cdb64-manifest.js';
import {
  canonicalizeIndexPublication,
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

  const makePublisher = (ttlMs = 86_400_000, supersedeGraceMs = 0) =>
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
      supersedeGraceMs,
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

  it('re-signs at once a document signed in the pre-prefix format', async () => {
    await makeBand('band-a');
    const publisher = makePublisher();
    await publisher.scanOnce();

    // What a publisher from before domain separation left on disk: the same
    // document, signed over the bare canonical JSON. An upgraded subscriber
    // refuses it, so it must not stand until the next refresh.
    const old = await readPublication();
    const legacySig = crypto.sign(
      null,
      Buffer.from(canonicalizeIndexPublication(old)),
      signer.privateKey,
    );
    await fs.writeFile(
      publicationFile,
      JSON.stringify({
        ...old,
        signature: { ...old.signature, sig: legacySig.toString('base64') },
      }),
    );

    clock = new Date(clock.getTime() + 1_000);
    assert.equal(await publisher.scanOnce(), true);
    const doc = await readPublication();
    assert.equal(doc.sequence, old.sequence + 1);
    assert.equal(
      verifyIndexPublication(doc, crypto.createPublicKey(signer.privateKey)).ok,
      true,
    );

    // Once re-signed, the document stands again.
    clock = new Date(clock.getTime() + 1_000);
    assert.equal(await publisher.scanOnce(), false);
  });

  it('re-signs at once after the observer key changes', async () => {
    await makeBand('band-a');
    await makePublisher().scanOnce();
    const before = await readPublication();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    signer = { ...signer, privateKey, keyId: getSolanaAddress(publicKey) };
    clock = new Date(clock.getTime() + 1_000);
    assert.equal(await makePublisher().scanOnce(), true);

    const doc = await readPublication();
    assert.equal(doc.sequence, before.sequence + 1);
    assert.equal(doc.signature?.keyId, signer.keyId);
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

  it('recovers when a scan fails after retiring a superseded band', async () => {
    // The retirement (manifest unlinked) lands, then the scan fails before
    // the document is written, so the document still offers the old band.
    await makeBand('band-a');
    const publisher = makePublisher(86_400_000, 300_000);
    await publisher.scanOnce();
    await makeBand('band-b', 3, { supersedes: 'band-a' });
    await fs.rm(blobsDir, { recursive: true, force: true });
    await fs.writeFile(blobsDir, 'not a directory');
    clock = new Date(clock.getTime() + 60_000);
    await assert.rejects(publisher.scanOnce());
    assert.deepEqual(
      (await readPublication()).indexes[0].bands.map((b) => b.id),
      ['band-a'],
      'the failed scan left the old document',
    );

    // The fault clears. Scans must publish again, not fail forever on the
    // band this publisher retired itself.
    await fs.rm(blobsDir, { force: true });
    clock = new Date(clock.getTime() + 60_000);
    await publisher.scanOnce();
    assert.deepEqual(
      (await readPublication()).indexes[0].bands.map((b) => b.id),
      ['band-b'],
    );
  });

  it(
    'withdraws a published band that stays unreadable',
    {
      skip: process.getuid?.() === 0,
    },
    async () => {
      const dir = await makeBand('band-a');
      await makeBand('band-b');
      const publisher = makePublisher();
      await publisher.scanOnce();
      await fs.chmod(dir, 0o000);
      try {
        for (let i = 0; i < MAX_HELD_SCANS; i++) {
          clock = new Date(clock.getTime() + 60_000);
          await assert.rejects(publisher.scanOnce());
        }
        clock = new Date(clock.getTime() + 60_000);
        await publisher.scanOnce();
        assert.deepEqual(
          (await readPublication()).indexes[0].bands.map((b) => b.id),
          ['band-b'],
          'held for a while, then withdrawn rather than stuck forever',
        );
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

  describe('torrents', () => {
    const makeTorrentPublisher = (
      opts: {
        dir?: string;
        store?: StateStore;
        transport?: MemoryTransport;
        trackers?: string[];
        privateSwarm?: boolean;
      } = {},
    ) => {
      const dir = opts.dir ?? publishedDir;
      return new Publisher({
        log,
        state: opts.store ?? state,
        kinds: createKindRegistry({ log }),
        signer,
        publish: [{ name: 'root-tx-index', kind: 'cdb64-root-tx' }],
        publishedDir: dir,
        blobsDir: path.join(dir, 'blobs'),
        publicationFile: path.join(dir, 'publication.json'),
        ttlMs: 86_400_000,
        supersedeGraceMs: 0,
        now: () => clock,
        torrents: {
          ...(opts.transport !== undefined
            ? { transport: opts.transport }
            : {}),
          trackers: opts.trackers ?? ['http://tracker.example/announce'],
          privateSwarm: opts.privateSwarm ?? false,
        },
      });
    };

    const readDoc = async (dir = publishedDir) =>
      parseIndexPublication(
        await fs.readFile(path.join(dir, 'publication.json')),
      );

    it('offers each band as a torrent whose entry names the file it wrote', async () => {
      await makeBand('band-a');
      await makeTorrentPublisher().scanOnce();

      const band = (await readDoc()).indexes[0].bands[0];
      assert(band.torrent !== undefined, 'the band has a torrent entry');
      assert.equal(
        band.torrent.torrentUrl,
        '/ar-io/indexes/root-tx-index/band-a.torrent',
      );
      const file = await fs.readFile(
        path.join(publishedDir, 'root-tx-index', 'band-a.torrent'),
      );
      const ids = torrentIds(file);
      assert.equal(band.torrent.infohashV1, ids.infohashV1);
      assert.equal(band.torrent.infohashV2, ids.infohashV2);
      assert.match(
        band.torrent.magnet,
        new RegExp(`xt=urn:btih:${ids.infohashV1}`),
      );
      assert.match(
        band.torrent.magnet,
        new RegExp(`xt=urn:btmh:1220${ids.infohashV2}`),
      );
    });

    it('builds byte-identical torrents on two publishers holding the same bytes', async () => {
      const source = await makeBand('band-a');
      const otherDir = path.join(tempDir, 'other-published');
      // A second publisher, holding a copy of the same files under another band id.
      await fs.cp(source, path.join(otherDir, 'root-tx-index', 'band-copy'), {
        recursive: true,
      });
      const otherState = new StateStore({
        log,
        filePath: path.join(tempDir, 'other-state.json'),
      });

      await makeTorrentPublisher().scanOnce();
      await makeTorrentPublisher({
        dir: otherDir,
        store: otherState,
      }).scanOnce();

      const mine = await fs.readFile(
        path.join(publishedDir, 'root-tx-index', 'band-a.torrent'),
      );
      const theirs = await fs.readFile(
        path.join(otherDir, 'root-tx-index', 'band-copy.torrent'),
      );
      assert.deepEqual(theirs, mine, 'the .torrent files are byte-identical');
      assert.equal(
        (await readDoc(otherDir)).indexes[0].bands[0].torrent?.infohashV1,
        (await readDoc()).indexes[0].bands[0].torrent?.infohashV1,
      );
    });

    it('joins an overlapping scan instead of running a second', async () => {
      await makeBand('band-a');
      const publisher = makeTorrentPublisher();
      const first = publisher.scanOnce();
      const second = publisher.scanOnce();
      assert.equal(second, first);
      await Promise.all([first, second]);
      assert.equal((await readDoc()).sequence, 1, 'one document, not two');
    });

    it('does not rebuild a torrent while the band is untouched', async () => {
      await makeBand('band-a');
      const publisher = makeTorrentPublisher();
      await publisher.scanOnce();
      const file = path.join(publishedDir, 'root-tx-index', 'band-a.torrent');
      const first = statSync(file).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();
      assert.equal(statSync(file).mtimeMs, first);
    });

    it('rebuilds when the tracker list changes, without changing the infohash', async () => {
      await makeBand('band-a');
      await makeTorrentPublisher().scanOnce();
      const before = (await readDoc()).indexes[0].bands[0].torrent!;
      clock = new Date(clock.getTime() + 60_000);
      await makeTorrentPublisher({
        trackers: ['http://other.example/announce'],
      }).scanOnce();
      const after = (await readDoc()).indexes[0].bands[0].torrent!;
      assert.equal(after.infohashV1, before.infohashV1);
      assert.notEqual(after.magnet, before.magnet);
    });

    it('changes the infohash for a private swarm', async () => {
      await makeBand('band-a');
      await makeTorrentPublisher().scanOnce();
      const open = (await readDoc()).indexes[0].bands[0].torrent!;
      clock = new Date(clock.getTime() + 60_000);
      await makeTorrentPublisher({ privateSwarm: true }).scanOnce();
      assert.notEqual(
        (await readDoc()).indexes[0].bands[0].torrent!.infohashV1,
        open.infohashV1,
      );
    });

    it('has the engine seed every offered band from where it lies', async () => {
      await makeBand('band-a');
      await makeBand('band-b', 5);
      const transport = new MemoryTransport(new MemorySwarm());
      await makeTorrentPublisher({ transport }).scanOnce();

      const doc = await readDoc();
      const seeding = (await state.load()).seeding;
      for (const band of doc.indexes[0].bands) {
        // By the engine's id, which for a hybrid torrent is not the v1 hash.
        const entry = Object.values(seeding).find(
          (s) => s.infohashV1 === band.torrent!.infohashV1,
        )!;
        assert.notEqual(entry.id, band.torrent!.infohashV1);
        const status = await transport.status(entry.id);
        assert.equal(status?.state, 'seeding', band.id);
      }
      assert.deepEqual(
        Object.values(seeding)
          .map((s) => s.band)
          .sort(),
        ['band-a', 'band-b'],
      );
      // From pinned links, not the band directory: see SEED_DIR.
      const bandA = doc.indexes[0].bands.find((b) => b.id === 'band-a')!;
      const seedDir = Object.values(seeding).find(
        (s) => s.band === 'band-a',
      )!.dir;
      assert.equal(
        seedDir,
        path.join(publishedDir, SEED_DIR, bandA.torrent!.infohashV1),
      );
      for (const file of bandA.files) {
        assert.equal(
          statSync(path.join(seedDir, file.name)).ino,
          statSync(path.join(publishedDir, 'blobs', file.sha256)).ino,
          `${file.name} is a link to its blob`,
        );
      }
    });

    it('keeps seeding the hashed bytes when a band is rebuilt in place', async () => {
      const bandDir = await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      await makeTorrentPublisher({ transport }).scanOnce();
      const band = (await readDoc()).indexes[0].bands[0];
      const seedDir = Object.values((await state.load()).seeding)[0].dir;
      const cdb = band.files.find((f) => f.name.endsWith('.cdb'))!;
      const before = await fs.readFile(path.join(seedDir, cdb.name));

      // An operator overwrites a file in place, same size, new bytes.
      const target = path.join(bandDir, cdb.name);
      await fs.rm(target);
      await fs.writeFile(target, Buffer.alloc(before.byteLength, 0x5a));

      const after = await fs.readFile(path.join(seedDir, cdb.name));
      assert.deepEqual(after, before, 'the engine still reads the old bytes');
    });

    it('removes the seed directory of a band it no longer offers', async () => {
      await makeBand('band-a');
      await makeBand('band-b', 5);
      const transport = new MemoryTransport(new MemorySwarm());
      const publisher = makeTorrentPublisher({ transport });
      await publisher.scanOnce();
      const gone = (await readDoc()).indexes[0].bands.find(
        (b) => b.id === 'band-b',
      )!;
      const goneDir = path.join(
        publishedDir,
        SEED_DIR,
        gone.torrent!.infohashV1,
      );
      assert.ok(existsSync(goneDir));

      await fs.rm(path.join(publishedDir, 'root-tx-index', 'band-b'), {
        recursive: true,
      });
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();
      assert.equal(existsSync(goneDir), false);
    });

    it('seeds idempotently across restarts', async () => {
      await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      await makeTorrentPublisher({ transport }).scanOnce();
      const firstIds = Object.keys((await state.load()).seeding);

      // A fresh process: new publisher, state read back from disk.
      const reloaded = new StateStore({
        log,
        filePath: path.join(tempDir, 'state.json'),
      });
      clock = new Date(clock.getTime() + 60_000);
      await makeTorrentPublisher({ transport, store: reloaded }).scanOnce();
      assert.deepEqual(Object.keys((await reloaded.load()).seeding), firstIds);
    });

    it('stops seeding, and deletes the .torrent of, a band it no longer offers', async () => {
      await makeBand('band-a');
      await makeBand('band-b');
      const transport = new MemoryTransport(new MemorySwarm());
      const publisher = makeTorrentPublisher({ transport });
      await publisher.scanOnce();
      const gone = (await readDoc()).indexes[0].bands.find(
        (b) => b.id === 'band-b',
      )!;
      const goneId = Object.values((await state.load()).seeding).find(
        (s) => s.infohashV1 === gone.torrent!.infohashV1,
      )!.id;

      await fs.rm(path.join(publishedDir, 'root-tx-index', 'band-b'), {
        recursive: true,
      });
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();

      assert.equal(await transport.status(goneId), undefined);
      assert.equal(
        existsSync(path.join(publishedDir, 'root-tx-index', 'band-b.torrent')),
        false,
      );
      assert.deepEqual(
        Object.values((await state.load()).seeding).map((s) => s.band),
        ['band-a'],
      );
    });

    it('takes back a shared torrent running from its own files, for the subscriber to re-add', async () => {
      await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      const publisher = makeTorrentPublisher({ transport });
      await publisher.scanOnce();
      const [mine] = Object.values((await state.load()).seeding);
      // The node also subscribes to the same bytes; the engine's one copy of
      // the torrent runs from the publisher's seed directory.
      await state.update((draft) => {
        draft.seeding[seedingKey('subscriber', mine.id)] = {
          ...mine,
          owner: 'subscriber',
          dir: path.join(tempDir, 'installed-copy'),
        };
      });

      await fs.rm(path.join(publishedDir, 'root-tx-index', 'band-a'), {
        recursive: true,
      });
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();

      assert.equal(
        await transport.status(mine.id),
        undefined,
        'not left pointing at files about to be deleted',
      );
      assert.equal(existsSync(mine.dir), false, 'the seed directory went');
      assert.deepEqual(
        Object.values((await state.load()).seeding).map((s) => s.owner),
        ['subscriber'],
        "the subscriber's entry stays, for it to re-add",
      );
    });

    it('re-adds a seeded torrent the engine put in error', async () => {
      await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      const publisher = makeTorrentPublisher({ transport });
      await publisher.scanOnce();
      const [mine] = Object.values((await state.load()).seeding);
      transport.entry(mine.id)!.state = 'error'; // as qBittorrent's missingFiles

      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();
      assert.equal((await transport.status(mine.id))?.state, 'seeding');
    });

    it('leaves a shared torrent running from the subscriber copy alone', async () => {
      const bandDir = await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      await makeTorrentPublisher().scanOnce();
      const torrent = await fs.readFile(
        path.join(publishedDir, 'root-tx-index', 'band-a.torrent'),
      );
      // The subscriber added it first, from its installed copy.
      const installedCopy = path.join(tempDir, 'installed-copy');
      await fs.cp(bandDir, installedCopy, { recursive: true });
      const { id } = await transport.seed({ torrent, dir: installedCopy });

      const publisher = makeTorrentPublisher({ transport });
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();
      await fs.rm(bandDir, { recursive: true });
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();

      assert.equal((await transport.status(id))?.state, 'seeding');
      assert.equal((await transport.status(id))?.savePath, installedCopy);
    });

    it('still publishes when the engine is down, and seeds once it is back', async () => {
      await makeBand('band-a');
      const transport = new MemoryTransport(new MemorySwarm());
      transport.available = false;
      const publisher = makeTorrentPublisher({ transport });
      await publisher.scanOnce();
      assert((await readDoc()).indexes[0].bands[0].torrent !== undefined);
      assert.deepEqual((await state.load()).seeding, {});

      transport.available = true;
      clock = new Date(clock.getTime() + 60_000);
      await publisher.scanOnce();
      assert.equal(Object.keys((await state.load()).seeding).length, 1);
    });

    it('offers no torrents without the option', async () => {
      await makeBand('band-a');
      await makePublisher().scanOnce();
      assert.equal((await readDoc()).indexes[0].bands[0].torrent, undefined);
      assert.equal(
        existsSync(path.join(publishedDir, 'root-tx-index', 'band-a.torrent')),
        false,
      );
    });

    it('builds magnet links naming both hashes and every tracker', () => {
      assert.equal(
        magnetFor('0123456789abcdef', 'a'.repeat(40), 'b'.repeat(64), [
          'http://t/a?x=1',
        ]),
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&xt=urn:btmh:1220${'b'.repeat(64)}&dn=0123456789abcdef&tr=http%3A%2F%2Ft%2Fa%3Fx%3D1`,
      );
    });
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
