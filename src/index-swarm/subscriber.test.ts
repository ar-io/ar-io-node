/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { fileUrl, Subscriber } from './subscriber.js';
import { subscriptionTotal } from './metrics.js';
import { Publisher } from './publisher.js';
import { StateStore } from './state.js';
import { createKindRegistry } from './kinds/registry.js';
import { GatewayRegistry, PublisherRecord } from './gateway-registry.js';
import { PartitionedCdb64Writer } from '../lib/partitioned-cdb64-writer.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { getSolanaAddress } from '../lib/httpsig.js';
import {
  INDEX_PUBLICATION_MAX_BYTES,
  serializeIndexPublication,
  signIndexPublication,
} from '../lib/index-publication.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index-swarm subscriber' });

const txId = (seed: number): Buffer => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed + i) % 256;
  return buf;
};

describe('fileUrl', () => {
  const file = { name: '00.cdb', size: 1, sha256: 'ab'.repeat(32) };

  it('fetches a file on the publisher gateway by digest', () => {
    assert.equal(
      fileUrl('https://gw.example', '/ar-io/indexes/idx/band/', file),
      `https://gw.example/ar-io/indexes/blob/${'ab'.repeat(32)}`,
    );
  });

  it('fetches a file on another server by name', () => {
    assert.equal(
      fileUrl('https://gw.example', 'https://cdn.example/idx/band/', file),
      'https://cdn.example/idx/band/00.cdb',
    );
  });
});

describe('Subscriber', () => {
  let tempDir: string;
  let pubDir: string;
  let subIncoming: string;
  let subInstalled: string;
  let pubState: StateStore;
  let subState: StateStore;
  let signer: { privateKey: crypto.KeyObject; keyId: string; wallet: string };
  let server: http.Server;
  let origin: string;
  let clock: Date;
  /** Lets a test corrupt what the publisher serves without touching disk. */
  let tamper: ((urlPath: string, body: Buffer) => Buffer) | undefined;
  /** Status to answer partition fetches with instead of their bytes. */
  let failPartitionsWith: number | undefined;
  /** Send bodies without Content-Length, as a chunked response. */
  let omitContentLength: boolean;
  /** Requests for this path, which no test should ever cause. */
  let canaryHits: number;

  /**
   * A real base58 address, and deliberately a different key from the one that
   * signs: the wallet is the publisher's identity and the observer key is the
   * signer, and they are only sometimes the same.
   */
  const WALLET = getSolanaAddress(
    crypto.generateKeyPairSync('ed25519').publicKey,
  );

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-sub-'));
    pubDir = path.join(tempDir, 'pub', 'published');
    subIncoming = path.join(tempDir, 'sub', 'incoming');
    subInstalled = path.join(tempDir, 'sub', 'installed');
    pubState = new StateStore({
      log,
      filePath: path.join(tempDir, 'pub', 'state.json'),
    });
    subState = new StateStore({
      log,
      filePath: path.join(tempDir, 'sub', 'state.json'),
    });
    tamper = undefined;
    failPartitionsWith = undefined;
    omitContentLength = false;
    canaryHits = 0;
    clock = new Date('2026-09-23T00:00:00.000Z');

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    signer = {
      privateKey,
      keyId: getSolanaAddress(publicKey),
      wallet: WALLET,
    };

    // Serve the publisher's directory, with Range support so the resume path
    // is exercised rather than assumed.
    server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const blob = /^\/ar-io\/indexes\/blob\/([0-9a-f]{64})$/.exec(urlPath);
      const filePath =
        urlPath === '/ar-io/indexes'
          ? path.join(pubDir, 'publication.json')
          : blob !== null
            ? path.join(pubDir, 'blobs', blob[1])
            : path.join(pubDir, urlPath.replace('/ar-io/indexes/', ''));

      void (async () => {
        if (urlPath === '/canary') {
          canaryHits++;
          res.writeHead(404).end();
          return;
        }
        if (failPartitionsWith !== undefined && isPartitionFetch(urlPath)) {
          res.writeHead(failPartitionsWith).end();
          return;
        }
        let body: Buffer;
        try {
          body = await fs.readFile(filePath);
        } catch {
          res.writeHead(404).end();
          return;
        }
        if (tamper !== undefined) body = tamper(urlPath, body);

        const range = req.headers.range;
        const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
        if (match !== null) {
          const start = Number(match[1]);
          const end = match[2] === '' ? body.length - 1 : Number(match[2]);
          const slice = body.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(slice.length),
          });
          res.end(slice);
          return;
        }
        if (omitContentLength) {
          res.writeHead(200);
          res.end(body);
          return;
        }
        res.writeHead(200, { 'Content-Length': String(body.length) }).end(body);
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Whether a request is for a partition file. Bands are fetched by digest,
   * so the path does not say which file it is; the publisher's own copy
   * does.
   */
  const isPartitionFetch = (urlPath: string): boolean => {
    const digest = /\/blob\/([0-9a-f]{64})$/.exec(urlPath)?.[1];
    if (digest === undefined) return urlPath.endsWith('.cdb');
    const doc = JSON.parse(
      readFileSync(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    return doc.indexes.some((index: any) =>
      index.bands.some((band: any) =>
        band.files.some(
          (file: any) => file.sha256 === digest && file.name.endsWith('.cdb'),
        ),
      ),
    );
  };

  const registryFor = (
    override?: Partial<PublisherRecord>,
  ): GatewayRegistry => ({
    lookup: async () => ({
      wallet: WALLET,
      observerAddress: signer.keyId,
      url: origin,
      status: 'joined' as const,
      ...override,
    }),
  });

  const makeBand = async (bandId: string, entries = 3): Promise<void> => {
    const dir = path.join(pubDir, 'root-tx-index', bandId);
    const writer = new PartitionedCdb64Writer(dir);
    await writer.open();
    for (let i = 0; i < entries; i++) {
      await writer.add(
        txId(i * 40),
        encodeCdb64Value({ rootTxId: txId(7 + i) }),
      );
    }
    await writer.finalize();
  };

  const publish = async (): Promise<void> => {
    await new Publisher({
      log,
      state: pubState,
      kinds: createKindRegistry({ log }),
      signer,
      publish: [{ name: 'root-tx-index', kind: 'cdb64-root-tx' }],
      publishedDir: pubDir,
      blobsDir: path.join(pubDir, 'blobs'),
      publicationFile: path.join(pubDir, 'publication.json'),
      ttlMs: 86_400_000,
      supersedeGraceMs: 0,
      now: () => clock,
    }).scanOnce();
  };

  const makeSubscriber = (
    opts: Partial<{
      registry: GatewayRegistry;
      maxDiskBytes: number;
      trustedPublishers: string[];
      name: string;
      url: string;
    }> = {},
  ) =>
    new Subscriber({
      log,
      state: subState,
      kinds: createKindRegistry({ log }),
      registry: opts.registry ?? registryFor(),
      subscribe: [
        {
          publisher: WALLET,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.url !== undefined ? { url: opts.url } : {}),
        },
      ],
      trustedPublishers: opts.trustedPublishers ?? [],
      incomingDir: subIncoming,
      installedDir: subInstalled,
      fetchTimeoutMs: 5000,
      downloadConcurrency: 4,
      supersedeGraceMs: 0,
      ...(opts.maxDiskBytes !== undefined
        ? { maxDiskBytes: opts.maxDiskBytes }
        : {}),
      now: () => clock,
    });

  /** How often a result was counted for this publisher, over all labels. */
  const counted = async (result: string): Promise<number> =>
    (await subscriptionTotal.get()).values
      .filter(
        (v) => v.labels.publisher === WALLET && v.labels.result === result,
      )
      .reduce((sum, v) => sum + v.value, 0);

  /**
   * Rewrite what the publisher serves and sign it again with its own key: a
   * newer or a hostile publisher, as far as a subscriber can tell.
   */
  const resign = async (mutate: (doc: any) => void | Promise<void>) => {
    const file = path.join(pubDir, 'publication.json');
    const doc: any = JSON.parse(await fs.readFile(file, 'utf8'));
    delete doc.signature;
    await mutate(doc);
    await fs.writeFile(
      file,
      serializeIndexPublication(
        signIndexPublication(doc, signer.privateKey, signer.keyId),
      ),
    );
  };

  /** Serve `bytes` as a band file of the publisher's, by name and digest. */
  const serveFile = async (bandId: string, name: string, bytes: Buffer) => {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(pubDir, 'root-tx-index', bandId, name), bytes);
    await fs.writeFile(path.join(pubDir, 'blobs', sha256), bytes);
    return { name, size: bytes.length, sha256 };
  };

  const installedIds = async (): Promise<string[]> => {
    const state = await subState.load();
    return Object.entries(state.installed['root-tx-index'] ?? {})
      .filter(([, band]) => band.retiredAt === undefined)
      .map(([id]) => id)
      .sort();
  };

  it('installs every band a publisher offers', async () => {
    await makeBand('band-a');
    await makeBand('band-b');
    await publish();

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a', 'band-b']);
    for (const id of ['band-a', 'band-b']) {
      assert.equal(
        existsSync(
          path.join(subInstalled, 'root-tx-index', id, 'manifest.json'),
        ),
        true,
        `${id} is installed where the gateway loads it`,
      );
    }
    const state = await subState.load();
    assert.equal(state.subscriptions[WALLET].sequence, 1);
    assert.equal(
      state.installed['root-tx-index']['band-a'].publisher,
      WALLET,
      'provenance is recorded so retirement can be scoped',
    );
  });

  it('joins an overlapping poll instead of downloading the same band twice', async () => {
    await makeBand('band-a');
    await publish();
    const subscriber = makeSubscriber();
    const first = subscriber.pollOnce();
    const second = subscriber.pollOnce();
    assert.equal(second, first, 'the second call joins the first');
    await Promise.all([first, second]);
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('accepts a document from a newer publisher that adds fields', async () => {
    await makeBand('band-a');
    await publish();
    // Re-sign what the publisher wrote with members this version does not
    // know, at every level, as a later version might add a per-file root.
    const file = path.join(pubDir, 'publication.json');
    const future: any = JSON.parse(await fs.readFile(file, 'utf8'));
    delete future.signature;
    future.addedLater = true;
    future.indexes[0].bands[0].addedLater = { at: 'band' };
    for (const entry of future.indexes[0].bands[0].files) {
      entry.merkle = { 'arweave-data-root': 'x'.repeat(43) };
    }
    await fs.writeFile(
      file,
      serializeIndexPublication(
        signIndexPublication(future, signer.privateKey, signer.keyId),
      ),
    );
    const failuresBefore = await counted('signature_failed');

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    assert.equal(await counted('signature_failed'), failuresBefore);
  });

  it('discards a signed band whose manifest points a partition at a URL, and never requests it', async () => {
    await makeBand('band-a');
    await publish();
    await resign(async (doc) => {
      const band = doc.indexes[0].bands[0];
      const manifestPath = path.join(
        pubDir,
        'root-tx-index',
        'band-a',
        'manifest.json',
      );
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const victim = manifest.partitions[0];
      const dropped = victim.location.filename;
      victim.location = { type: 'http', url: `${origin}/canary` };
      const entry = await serveFile(
        'band-a',
        'manifest.json',
        Buffer.from(JSON.stringify(manifest)),
      );
      band.files = band.files
        .filter((f: any) => f.name !== dropped)
        .map((f: any) => (f.name === 'manifest.json' ? entry : f));
    });
    const before = await counted('verify_failed');

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), [], 'nothing installed');
    assert.equal(await counted('verify_failed'), before + 1);
    assert.equal(canaryHits, 0, 'the publisher-chosen URL was never requested');
    assert.equal(
      existsSync(path.join(subIncoming, 'root-tx-index', 'band-a')),
      false,
      'the rejected download is not kept for resuming',
    );
  });

  it('skips an index of a kind it does not know and installs the rest', async () => {
    await makeBand('band-a');
    await publish();
    await resign((doc) => {
      doc.indexes.push({
        name: 'from-the-future',
        kind: 'not-a-kind-yet',
        bands: [],
      });
    });
    const before = await counted('unknown_kind');

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    assert.equal(await counted('unknown_kind'), before + 1);
  });

  it('installs from a publication past its expiry, since its bands are still valid', async () => {
    await makeBand('band-a');
    await publish();
    clock = new Date(clock.getTime() + 7 * 86_400_000);
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('counts bands already installed against the disk budget', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    const doc = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    const sizeOf = (band: any) =>
      band.files.reduce((sum: number, f: any) => sum + f.size, 0);
    const aBytes = sizeOf(doc.indexes[0].bands[0]);

    await makeBand('band-b');
    clock = new Date(clock.getTime() + 60_000);
    await publish();
    const next = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    const bBytes = sizeOf(
      next.indexes[0].bands.find((b: any) => b.id === 'band-b'),
    );
    const before = await counted('skipped_disk_budget');

    // Room for either band alone, not both.
    await makeSubscriber({ maxDiskBytes: aBytes + bBytes - 1 }).pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    assert.equal(await counted('skipped_disk_budget'), before + 1);
  });

  it('refuses an oversized publication sent without a Content-Length', async () => {
    await makeBand('band-a');
    await publish();
    await resign((doc) => {
      doc.padding = 'x'.repeat(INDEX_PUBLICATION_MAX_BYTES);
    });
    omitContentLength = true;

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), []);
  });

  it('does nothing on a second poll when the publisher has not moved', async () => {
    await makeBand('band-a');
    await publish();
    const subscriber = makeSubscriber();
    await subscriber.pollOnce();
    const first = await fs.stat(
      path.join(subInstalled, 'root-tx-index', 'band-a', 'manifest.json'),
    );

    await subscriber.pollOnce();
    const second = await fs.stat(
      path.join(subInstalled, 'root-tx-index', 'band-a', 'manifest.json'),
    );
    assert.equal(first.mtimeMs, second.mtimeMs, 'nothing re-downloaded');
  });

  it('refuses a document older than the one already installed', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();

    // A cache or mirror replaying sequence 1 after 2 is installed must not
    // roll the subscriber back to the older band set.
    await subState.update((draft) => {
      draft.subscriptions[WALLET].sequence = 5;
    });
    await makeBand('band-b');
    clock = new Date(clock.getTime() + 60_000);
    await publish();

    await makeSubscriber().pollOnce();

    assert.deepEqual(
      await installedIds(),
      ['band-a'],
      'the replayed document installed nothing',
    );
  });

  it('rejects a document signed by a key the registry does not name', async () => {
    await makeBand('band-a');
    await publish();

    const stranger = crypto.generateKeyPairSync('ed25519');
    await makeSubscriber({
      registry: registryFor({
        observerAddress: getSolanaAddress(stranger.publicKey),
      }),
    }).pollOnce();

    assert.deepEqual(await installedIds(), []);
  });

  it('rejects a document whose signature does not verify', async () => {
    await makeBand('band-a');
    await publish();

    // Flip a byte in the document on the wire, leaving the signature intact.
    tamper = (urlPath, body) => {
      if (urlPath !== '/ar-io/indexes') return body;
      const doc = JSON.parse(body.toString());
      doc.indexes[0].bands[0].records = 999999;
      return Buffer.from(JSON.stringify(doc));
    };

    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), []);
  });

  it('rejects a document claiming a different publisher', async () => {
    await makeBand('band-a');
    await publish();

    await makeSubscriber({
      registry: registryFor({
        wallet: getSolanaAddress(
          crypto.generateKeyPairSync('ed25519').publicKey,
        ),
      }),
    }).pollOnce();

    assert.deepEqual(await installedIds(), []);
  });

  /** How often a result has been counted for this test's publisher. */
  const resultCount = async (result: string): Promise<number> => {
    const { values } = await subscriptionTotal.get();
    return values
      .filter(
        (v) => v.labels.publisher === WALLET && v.labels.result === result,
      )
      .reduce((sum, v) => sum + v.value, 0);
  };

  it('installs nothing when a file does not match its digest', async () => {
    await makeBand('band-a');
    await publish();

    // The document is authentic; the bytes served are not what it names.
    tamper = (urlPath, body) =>
      isPartitionFetch(urlPath) ? Buffer.alloc(body.length, 0x41) : body;
    const before = await resultCount('verify_failed');

    await makeSubscriber().pollOnce();

    assert.equal(
      await resultCount('verify_failed'),
      before + 1,
      'bytes that fail their digest are counted as verify_failed',
    );
    assert.deepEqual(await installedIds(), []);
    assert.equal(
      existsSync(path.join(subInstalled, 'root-tx-index', 'band-a')),
      false,
      'nothing reaches the directory the gateway loads from',
    );
  });

  it('resumes a band whose download was interrupted', async () => {
    await makeBand('band-a');
    await publish();

    // Leave a truncated partial behind, as a killed process would.
    const state0 = JSON.parse(
      (await fs.readFile(path.join(pubDir, 'publication.json'))).toString(),
    );
    const file = state0.indexes[0].bands[0].files.find((f: any) =>
      f.name.endsWith('.cdb'),
    );
    const incomingBand = path.join(subIncoming, 'root-tx-index', 'band-a');
    await fs.mkdir(incomingBand, { recursive: true });
    const source = await fs.readFile(
      path.join(pubDir, 'root-tx-index', 'band-a', file.name),
    );
    await fs.writeFile(
      path.join(incomingBand, `${file.name}.tmp`),
      source.subarray(0, Math.max(1, Math.floor(source.length / 2))),
    );

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    const installedFile = await fs.readFile(
      path.join(subInstalled, 'root-tx-index', 'band-a', file.name),
    );
    assert.deepEqual(
      installedFile,
      source,
      'the resumed file is byte-identical to the published one',
    );
  });

  it('skips a band that would exceed the disk budget', async () => {
    await makeBand('band-a');
    await publish();

    await makeSubscriber({ maxDiskBytes: 10 }).pollOnce();

    assert.deepEqual(await installedIds(), []);
  });

  it('fetches the bands, not just the document, from a url override', async () => {
    await makeBand('band-a');
    await publish();

    // The registry's host is dead; only the override can serve anything.
    await makeSubscriber({
      registry: registryFor({ url: 'http://127.0.0.1:1' }),
      url: origin,
    }).pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('counts a metered or failed fetch as download_failed, not tampering', async () => {
    await makeBand('band-a');
    await publish();
    failPartitionsWith = 402;
    const verifyBefore = await resultCount('verify_failed');
    const downloadBefore = await resultCount('download_failed');

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), []);
    assert.equal(await resultCount('download_failed'), downloadBefore + 1);
    assert.equal(
      await resultCount('verify_failed'),
      verifyBefore,
      'a 402 says nothing about the bytes',
    );
  });

  it('replaces a band the publisher rebuilt under the same id', async () => {
    // The rolling tip band is rebuilt in place on every publisher cadence.
    await makeBand('band-tip', 3);
    await publish();
    const subscriber = makeSubscriber();
    await subscriber.pollOnce();
    const manifestPath = path.join(
      subInstalled,
      'root-tx-index',
      'band-tip',
      'manifest.json',
    );
    const before = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(before.totalRecords, 3);

    await fs.rm(path.join(pubDir, 'root-tx-index', 'band-tip'), {
      recursive: true,
      force: true,
    });
    await makeBand('band-tip', 5);
    clock = new Date(clock.getTime() + 60_000);
    await publish();

    await subscriber.pollOnce();

    const after = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(after.totalRecords, 5, 'the rebuilt band replaced the old');
    const state = await subState.load();
    const published = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    assert.deepEqual(
      state.installed['root-tx-index']['band-tip'].files
        .map((file) => file.sha256)
        .sort(),
      published.indexes[0].bands[0].files
        .map((file: { sha256: string }) => file.sha256)
        .sort(),
      'state records the files actually installed',
    );
  });

  it('retires a band the publisher stops offering', async () => {
    await makeBand('band-a');
    await makeBand('band-b');
    await publish();
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a', 'band-b']);

    // The publisher drops band-b.
    await fs.rm(path.join(pubDir, 'root-tx-index', 'band-b'), {
      recursive: true,
      force: true,
    });
    await pubState.update((draft) => {
      draft.describeCache = {};
    });
    clock = new Date(clock.getTime() + 60_000);
    await publish();

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    // Grace is zero here, so the sweep in the same poll removed the files.
    assert.equal(
      existsSync(path.join(subInstalled, 'root-tx-index', 'band-b')),
      false,
    );
  });

  it('retires every band the publisher drops in one publication', async () => {
    await makeBand('band-a');
    await makeBand('band-b');
    await makeBand('band-c');
    await publish();
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a', 'band-b', 'band-c']);

    for (const id of ['band-b', 'band-c']) {
      await fs.rm(path.join(pubDir, 'root-tx-index', id), {
        recursive: true,
        force: true,
      });
    }
    await pubState.update((draft) => {
      draft.describeCache = {};
    });
    clock = new Date(clock.getTime() + 60_000);
    await publish();

    await makeSubscriber().pollOnce();

    assert.deepEqual(
      await installedIds(),
      ['band-a'],
      'both dropped bands are out of service, not only the last one retired',
    );
    for (const id of ['band-b', 'band-c']) {
      assert.equal(
        existsSync(path.join(subInstalled, 'root-tx-index', id)),
        false,
        `${id} was swept`,
      );
    }
  });

  it('honours an allowlist without abandoning the registry check', async () => {
    await makeBand('band-a');
    await publish();

    const stranger = getSolanaAddress(
      crypto.generateKeyPairSync('ed25519').publicKey,
    );
    await makeSubscriber({ trustedPublishers: [stranger] }).pollOnce();
    assert.deepEqual(await installedIds(), [], 'not on the list, not fetched');

    await makeSubscriber({ trustedPublishers: [WALLET] }).pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('installs only the named index when one is configured', async () => {
    await makeBand('band-a');
    await publish();

    await makeSubscriber({ name: 'some-other-index' }).pollOnce();
    assert.deepEqual(await installedIds(), []);

    await makeSubscriber({ name: 'root-tx-index' }).pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('keeps what is installed when the publisher is unreachable', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);

    // Failure must degrade toward keeping what works.
    await makeSubscriber({
      registry: { lookup: async () => undefined },
    }).pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('retries a band that failed earlier, without waiting for a new document', async () => {
    await makeBand('band-a');
    await publish();

    // A transient failure: the bytes served do not match their digests.
    tamper = (urlPath, body) =>
      isPartitionFetch(urlPath) ? Buffer.alloc(body.length, 0x41) : body;
    const subscriber = makeSubscriber();
    await subscriber.pollOnce();
    assert.deepEqual(await installedIds(), []);

    // The publisher has not moved: same document, same sequence. A subscriber
    // that treated the sequence as "already processed" would never retry, and
    // on a twelve-hour publish cadence the band would simply be missing.
    tamper = undefined;
    await subscriber.pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);

    const state = await subState.load();
    assert.equal(state.subscriptions[WALLET].sequence, 1);
  });

  it('refuses an oversized publication before buffering it', async () => {
    await makeBand('band-a');
    await publish();

    tamper = (urlPath, body) =>
      urlPath === '/ar-io/indexes' ? Buffer.alloc(5 * 1024 * 1024, 0x7b) : body;

    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), []);
  });
});
