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

import {
  bandsNewestFirst,
  fileUrl,
  MAX_SEQUENCE_JUMP,
  Subscriber,
} from './subscriber.js';
import {
  manifestAgeClock,
  publicationIssuedAt,
  subscriptionBytes,
  subscriptionManifestAge,
  subscriptionTotal,
} from './metrics.js';
import { MemorySwarm, MemoryTransport } from './transport/memory.js';
import { buildTorrent, torrentIds } from './torrent.js';
import { bdecode, bencode, BencodeValue } from '../lib/bencode.js';
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
  torrentNameForFiles,
} from '../lib/index-publication.js';
import { createTestLogger } from '../../test/test-logger.js';
import { SubscribeConfig } from './config.js';
import { ArtifactKind } from './kinds/types.js';
import { Cdb64RootTxIndex } from '../discovery/cdb64-root-tx-index.js';
import { toB64Url } from '../lib/encoding.js';

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

  it('fetches a file on another server by name, only if that server is allowed', () => {
    assert.equal(
      fileUrl(
        'https://gw.example',
        'https://cdn.example/idx/band/',
        file,
        new Set(['https://cdn.example']),
      ),
      'https://cdn.example/idx/band/00.cdb',
    );
    // A signed URL is still a request to wherever it points.
    for (const baseUrl of [
      'https://cdn.example/idx/band/',
      'http://169.254.169.254/latest/meta-data/?x=',
      'http://clickhouse:8123/?query=',
    ]) {
      assert.equal(
        fileUrl('https://gw.example', baseUrl, file),
        undefined,
        baseUrl,
      );
    }
  });

  it("allows an absolute URL on the publication's own origin", () => {
    assert.equal(
      fileUrl(
        'https://gw.example',
        'https://gw.example/ar-io/indexes/idx/band/',
        file,
      ),
      'https://gw.example/ar-io/indexes/idx/band/00.cdb',
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
  /** Every blob digest requested, in order. */
  let blobRequests: string[];
  /** Digests to answer with 404 once, as a load balancer's wrong node does. */
  let notFoundOnce: Set<string>;
  /** Send bodies without Content-Length, as a chunked response. */
  let omitContentLength: boolean;
  /** Requests for this path, which no test should ever cause. */
  let canaryHits: number;
  /** User-Agent of every request the publisher saw. */
  let userAgents: string[];

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
    blobRequests = [];
    notFoundOnce = new Set();
    omitContentLength = false;
    canaryHits = 0;
    userAgents = [];
    // Module-level, like the gauge it feeds: start each test clean.
    publicationIssuedAt.clear();
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
        userAgents.push(String(req.headers['user-agent'] ?? ''));
        if (urlPath === '/canary') {
          canaryHits++;
          res.writeHead(404).end();
          return;
        }
        if (blob !== null) {
          blobRequests.push(blob[1]);
          if (notFoundOnce.delete(blob[1])) {
            res.writeHead(404).end();
            return;
          }
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

  const makeBand = async (
    bandId: string,
    entries = 3,
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    const dir = path.join(pubDir, 'root-tx-index', bandId);
    const writer = new PartitionedCdb64Writer(
      dir,
      metadata !== undefined ? { metadata } : undefined,
    );
    await writer.open();
    for (let i = 0; i < entries; i++) {
      await writer.add(
        txId(i * 40),
        encodeCdb64Value({ rootTxId: txId(7 + i) }),
      );
    }
    await writer.finalize();
  };

  const publish = async (
    indexes: { name: string; kind: string }[] = [
      { name: 'root-tx-index', kind: 'cdb64-root-tx' },
    ],
  ): Promise<void> => {
    await new Publisher({
      log,
      state: pubState,
      kinds: createKindRegistry({ log }),
      signer,
      publish: indexes,
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
      userAgent: string;
      allowedFileOrigins: string[];
      replaceOverlapMs: number;
      alsoSubscribedTo: string[];
      subscribe: SubscribeConfig[];
      kinds: Map<string, ArtifactKind>;
      supersedeGraceMs: number;
      untrackedMinAgeMs: number;
    }> = {},
  ) =>
    new Subscriber({
      log,
      state: subState,
      kinds: opts.kinds ?? createKindRegistry({ log }),
      registry: opts.registry ?? registryFor(),
      subscribe: opts.subscribe ?? [
        {
          publisher: WALLET,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.url !== undefined ? { url: opts.url } : {}),
        },
        ...(opts.alsoSubscribedTo ?? []).map((publisher) => ({ publisher })),
      ],
      trustedPublishers: opts.trustedPublishers ?? [],
      incomingDir: subIncoming,
      installedDir: subInstalled,
      fetchTimeoutMs: 5000,
      downloadConcurrency: 4,
      supersedeGraceMs: opts.supersedeGraceMs ?? 0,
      replaceOverlapMs: opts.replaceOverlapMs ?? 0,
      ...(opts.untrackedMinAgeMs !== undefined
        ? { untrackedMinAgeMs: opts.untrackedMinAgeMs }
        : {}),
      ...(opts.maxDiskBytes !== undefined
        ? { maxDiskBytes: opts.maxDiskBytes }
        : {}),
      ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
      ...(opts.allowedFileOrigins !== undefined
        ? { allowedFileOrigins: opts.allowedFileOrigins }
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

  /** Where the gateway loads a live band from, as the subscriber recorded it. */
  const bandDir = async (id: string): Promise<string> => {
    const band = (await subState.load()).installed['root-tx-index']?.[id];
    assert(band !== undefined && band.retiredAt === undefined, `${id} is live`);
    return band.dir;
  };

  /** Directories on disk for a band id, any generation. */
  const dirsOnDisk = async (id: string): Promise<string[]> => {
    const root = path.join(subInstalled, 'root-tx-index');
    const names = await fs.readdir(root).catch(() => [] as string[]);
    return names.filter((n) => n === id || n.startsWith(`${id}~`));
  };

  const installedIds = async (): Promise<string[]> => {
    const state = await subState.load();
    return Object.entries(state.installed['root-tx-index'] ?? {})
      .filter(([, band]) => band.retiredAt === undefined)
      .map(([id]) => id)
      .sort();
  };

  describe('over the torrent transport', () => {
    /** Publish with torrents on, the publisher's engine in `swarm`. */
    const publishTorrents = async (seeder?: MemoryTransport) => {
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
        torrents: {
          ...(seeder !== undefined ? { transport: seeder } : {}),
          trackers: [],
          privateSwarm: false,
        },
      }).scanOnce();
    };

    const makeTorrentSubscriber = (
      transport: MemoryTransport,
      opts: Partial<{
        webSeedAfterMs: number;
        torrentTimeoutMs: number;
        torrentWatchMs: number;
        untrackedMinAgeMs: number;
        maxDiskBytes: number;
      }> = {},
    ) =>
      new Subscriber({
        log,
        state: subState,
        kinds: createKindRegistry({ log }),
        registry: registryFor(),
        subscribe: [{ publisher: WALLET }],
        trustedPublishers: [],
        incomingDir: subIncoming,
        installedDir: subInstalled,
        fetchTimeoutMs: 5000,
        downloadConcurrency: 4,
        supersedeGraceMs: 0,
        transport,
        torrentTimeoutMs: opts.torrentTimeoutMs ?? 3_600_000,
        webSeedAfterMs: opts.webSeedAfterMs ?? 3_600_000,
        torrentWatchMs: opts.torrentWatchMs ?? 2_000,
        torrentCheckMs: 20,
        ...(opts.untrackedMinAgeMs !== undefined
          ? { untrackedMinAgeMs: opts.untrackedMinAgeMs }
          : {}),
        ...(opts.maxDiskBytes !== undefined
          ? { maxDiskBytes: opts.maxDiskBytes }
          : {}),
        now: () => clock,
      });

    /** How often a result was counted, by transport, for this publisher. */
    const counted = async (result: string, transport: string) =>
      (await subscriptionTotal.get()).values
        .filter(
          (v) =>
            v.labels.publisher === WALLET &&
            v.labels.result === result &&
            v.labels.transport === transport,
        )
        .reduce((sum, v) => sum + v.value, 0);

    const keptTorrent = (infohashV1: string) =>
      path.join(path.dirname(subIncoming), 'torrents', `${infohashV1}.torrent`);

    const bytesBy = async (transport: string) =>
      (await subscriptionBytes.get()).values
        .filter((v) => v.labels.transport === transport)
        .reduce((sum, v) => sum + v.value, 0);

    const installedDigests = async (bandId: string) => {
      const dir = (await subState.load()).installed['root-tx-index'][bandId]
        .dir;
      const out: Record<string, string> = {};
      for (const name of await fs.readdir(dir)) {
        out[name] = crypto
          .createHash('sha256')
          .update(await fs.readFile(path.join(dir, name)))
          .digest('hex');
      }
      return out;
    };

    const publishedDigests = async () => {
      const doc = JSON.parse(
        await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
      );
      return Object.fromEntries(
        doc.indexes[0].bands[0].files.map(
          (f: { name: string; sha256: string }) => [f.name, f.sha256],
        ),
      );
    };

    it('installs a band through add and status, from a peer, and counts it as torrent', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      const installedBefore = await counted('installed', 'torrent');
      const torrentBytesBefore = await bytesBy('torrent');
      const httpBytesBefore = await bytesBy('http');

      await makeTorrentSubscriber(engine).pollOnce();

      assert.deepEqual(await installedIds(), ['band-a']);
      assert.deepEqual(
        await installedDigests('band-a'),
        await publishedDigests(),
      );
      assert.equal(await counted('installed', 'torrent'), installedBefore + 1);
      assert(
        (await bytesBy('torrent')) > torrentBytesBefore,
        'bytes counted as torrent',
      );
      assert.equal(await bytesBy('http'), httpBytesBefore, 'nothing over HTTP');
    });

    it('keeps an installed band seeding from installed/, and the publisher leaves it alone', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      const publisherEngine = new MemoryTransport(swarm);
      await publishTorrents(publisherEngine);
      const engine = new MemoryTransport(swarm);
      await makeTorrentSubscriber(engine).pollOnce();

      const seeding = Object.entries((await subState.load()).seeding);
      assert.equal(seeding.length, 1);
      const [, seeded] = seeding[0];
      const id = seeded.id;
      assert.equal(seeded.owner, 'subscriber');
      assert.equal(
        seeded.dir,
        (await subState.load()).installed['root-tx-index']['band-a'].dir,
        'seeded from the installed generation directory',
      );
      assert.equal(engine.entry(id)?.state, 'seeding');
      assert.equal(
        engine.entry(id)?.dir,
        seeded.dir,
        'seeded from where the band now lives',
      );
      assert(
        existsSync(keptTorrent(seeded.infohashV1!)),
        'the torrent is kept for re-seeding',
      );
    });

    it('re-seeds an installed band the engine lost', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      const subscriber = makeTorrentSubscriber(engine);
      await subscriber.pollOnce();
      const [{ id }] = Object.values((await subState.load()).seeding);

      await engine.remove(id); // a wiped engine
      await subscriber.pollOnce();
      assert.equal(engine.entry(id)?.state, 'seeding');
    });

    it('falls back to HTTP when the engine reports an error, and the band still installs', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      // Make every download on this engine fail.
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        const result = await add(opts);
        const entry = engine.entry(result.id)!;
        entry.state = 'error';
        entry.error = 'simulated';
        return result;
      };
      const fallbacks = await counted('transport_fallback', 'torrent');
      const httpInstalls = await counted('installed', 'http');

      await makeTorrentSubscriber(engine).pollOnce();

      assert.deepEqual(await installedIds(), ['band-a']);
      assert.deepEqual(
        await installedDigests('band-a'),
        await publishedDigests(),
      );
      assert.equal(
        await counted('transport_fallback', 'torrent'),
        fallbacks + 1,
      );
      assert.equal(await counted('installed', 'http'), httpInstalls + 1);
    });

    it('uses HTTP when the engine is down', async () => {
      await makeBand('band-a');
      await publishTorrents();
      const engine = new MemoryTransport(new MemorySwarm());
      engine.available = false;
      await makeTorrentSubscriber(engine).pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
    });

    it('seeds a band it fetched over HTTP once the engine answers again', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      engine.available = false; // still starting, as on a fresh `up`
      const subscriber = makeTorrentSubscriber(engine);
      await subscriber.pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
      assert.deepEqual((await subState.load()).seeding, {});

      engine.available = true;
      await subscriber.pollOnce();

      const seeding = Object.entries((await subState.load()).seeding);
      assert.equal(seeding.length, 1, 'the HTTP-installed band now seeds');
      const [, seeded] = seeding[0];
      const id = seeded.id;
      assert.equal(seeded.band, 'band-a');
      assert.equal(engine.entry(id)?.state, 'seeding');
      assert(
        existsSync(keptTorrent(seeded.infohashV1!)),
        'the verified torrent is kept for re-seeding',
      );
    });

    it('seeds a band the swarm could not deliver, in the same poll as its HTTP install', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        const result = await add(opts);
        const entry = engine.entry(result.id)!;
        entry.state = 'error';
        entry.error = 'simulated';
        return result;
      };

      await makeTorrentSubscriber(engine).pollOnce();

      const seeding = Object.entries((await subState.load()).seeding);
      assert.equal(seeding.length, 1);
      assert.equal(engine.entry(seeding[0][1].id)?.state, 'seeding');
    });

    it('refuses a torrent that is not the one the publication signed', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      let added = 0;
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        added++;
        return add(opts);
      };
      // A different torrent served at the band's torrent URL.
      tamper = (urlPath, body) => {
        if (!urlPath.endsWith('.torrent')) return body;
        const bytes = Buffer.from(body);
        bytes[bytes.length - 3] ^= 0xff;
        return bytes;
      };
      const refused = await counted('verify_failed', 'torrent');

      await makeTorrentSubscriber(engine).pollOnce();

      assert.equal(added, 0, 'never handed to the engine');
      assert.equal(await counted('verify_failed', 'torrent'), refused + 1);
      assert.deepEqual(
        await installedIds(),
        ['band-a'],
        'installed over HTTP instead',
      );
    });

    it('turns on the WebSeed only once peers are not delivering, and finishes through it', async () => {
      await makeBand('band-a');
      const requests: string[] = [];
      // A swarm with no seeder; only the publisher's WebSeed can deliver.
      const swarm = new MemorySwarm({
        webSeed: async (url, torrentName, file) => {
          requests.push(`${url}${torrentName}/${file}`);
          const doc = JSON.parse(
            await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
          );
          const band = doc.indexes[0].bands.find(
            (b: {
              files: Array<{ name: string; size: number; sha256: string }>;
            }) => torrentNameForFiles(b.files) === torrentName,
          );
          if (band === undefined || !url.endsWith('/ar-io/indexes/webseed/'))
            return undefined;
          return fs.readFile(path.join(pubDir, 'root-tx-index', band.id, file));
        },
      });
      await publishTorrents();
      const engine = new MemoryTransport(swarm);

      // Not stalled long enough yet: stays pending, no WebSeed.
      await makeTorrentSubscriber(engine, { torrentWatchMs: 100 }).pollOnce();
      assert.deepEqual(await installedIds(), []);
      assert.equal(requests.length, 0, 'no WebSeed yet');

      // Stalled: the WebSeed is turned on and delivers.
      await makeTorrentSubscriber(engine, { webSeedAfterMs: 0 }).pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
      assert(requests.length > 0);
      assert(
        requests.every((r) => r.startsWith(`${origin}/ar-io/indexes/webseed/`)),
        'the WebSeed is the publisher origin’s WebSeed route',
      );
    });

    it('carries an unfinished torrent across polls without starting it again', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents();
      const engine = new MemoryTransport(swarm);
      let added = 0;
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        added++;
        return add(opts);
      };
      const subscriber = makeTorrentSubscriber(engine, { torrentWatchMs: 50 });
      await subscriber.pollOnce();
      assert.deepEqual(await installedIds(), [], 'no seeder yet');

      // A seeder appears between polls.
      const seeder = new MemoryTransport(swarm);
      await seeder.seed({
        torrent: await fs.readFile(
          path.join(pubDir, 'root-tx-index', 'band-a.torrent'),
        ),
        dir: path.join(pubDir, 'root-tx-index', 'band-a'),
      });
      await subscriber.pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
      assert.equal(added, 1, 'the same torrent, not a second one');
    });

    it('joins an overlapping poll instead of racing it over the same band', async () => {
      // The live bug: a poll outlasting the interval, a second one starting,
      // one installing the band while the other abandoned it.
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents();
      const engine = new MemoryTransport(swarm);
      let added = 0;
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        added++;
        return add(opts);
      };
      const subscriber = makeTorrentSubscriber(engine, { torrentWatchMs: 400 });
      const fallbacks = await counted('transport_fallback', 'torrent');

      const first = subscriber.pollOnce();
      const second = subscriber.pollOnce();
      // The second call joins the running poll of this publisher; it does
      // not start another, which the single add below shows.
      // A seeder appears while the poll is watching.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new MemoryTransport(swarm).seed({
        torrent: await fs.readFile(
          path.join(pubDir, 'root-tx-index', 'band-a.torrent'),
        ),
        dir: path.join(pubDir, 'root-tx-index', 'band-a'),
      });
      await Promise.all([first, second]);

      assert.deepEqual(await installedIds(), ['band-a']);
      assert.equal(added, 1);
      assert.equal(await counted('transport_fallback', 'torrent'), fallbacks);
    });

    it('abandons a torrent that outlives the timeout and fetches over HTTP', async () => {
      await makeBand('band-a');
      await publishTorrents();
      const engine = new MemoryTransport(new MemorySwarm()); // nobody seeds
      const fallbacks = await counted('transport_fallback', 'torrent');
      await makeTorrentSubscriber(engine, { torrentTimeoutMs: 0 }).pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
      assert.equal(
        await counted('transport_fallback', 'torrent'),
        fallbacks + 1,
      );
      assert.equal(
        Object.keys((await subState.load()).seeding).length,
        1,
        'once the band is here over HTTP, this node seeds it: it may be the first seeder',
      );
    });

    it('hands the engine only the signed part of a hostile torrent', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      // A publisher rewrites what the signature does not cover: trackers
      // and WebSeeds pointing into the subscriber's network.
      const torrentFile = path.join(pubDir, 'root-tx-index', 'band-a.torrent');
      const original = await fs.readFile(torrentFile);
      const top = bdecode(original) as Record<string, BencodeValue>;
      await fs.writeFile(
        torrentFile,
        bencode({
          ...top,
          announce: Buffer.from('http://core:4000/announce'),
          'url-list': [Buffer.from('http://observer:5050/')],
        }),
      );

      const engine = new MemoryTransport(swarm);
      await makeTorrentSubscriber(engine).pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);

      const [seeded] = Object.values((await subState.load()).seeding);
      const kept = bdecode(
        await fs.readFile(keptTorrent(seeded.infohashV1!)),
      ) as Record<string, unknown>;
      assert.equal(kept['url-list'], undefined);
      assert.equal(kept.announce, undefined);
      assert.deepEqual(torrentIds(bencode(kept as any)), torrentIds(original));
    });

    it('keeps the timeout of a torrent download across a restart', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents();
      const engine = new MemoryTransport(swarm);
      // No seeder: the download waits.
      await makeTorrentSubscriber(engine, {
        torrentWatchMs: 20,
        torrentTimeoutMs: 60_000,
      }).pollOnce();
      assert.deepEqual(await installedIds(), []);
      assert.equal(
        Object.keys((await subState.load()).downloads).length,
        1,
        'the download is in state',
      );

      // A new process, past the timeout measured from the FIRST start.
      clock = new Date(clock.getTime() + 61_000);
      const fallbacks = await counted('transport_fallback', 'torrent');
      await makeTorrentSubscriber(engine, {
        torrentWatchMs: 20,
        torrentTimeoutMs: 60_000,
      }).pollOnce();
      assert.equal(
        await counted('transport_fallback', 'torrent'),
        fallbacks + 1,
        'abandoned, not restarted',
      );
      assert.deepEqual(await installedIds(), ['band-a'], 'installed over HTTP');
      assert.deepEqual((await subState.load()).downloads, {});
    });

    it('cleans up swarm directories and kept torrents nothing uses', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      const swarmDir = path.join(path.dirname(subIncoming), 'swarm');
      const orphanDir = path.join(swarmDir, 'f'.repeat(40));
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(path.join(orphanDir, '00.cdb'), 'partial');
      const strayTorrent = keptTorrent('e'.repeat(40));
      await fs.mkdir(path.dirname(strayTorrent), { recursive: true });
      await fs.writeFile(strayTorrent, 'd4:infode');

      await makeTorrentSubscriber(engine, { untrackedMinAgeMs: 0 }).pollOnce();

      assert.deepEqual(await installedIds(), ['band-a']);
      assert.equal(existsSync(orphanDir), false, 'orphan download removed');
      assert.equal(existsSync(strayTorrent), false, 'unused torrent removed');
      const [seeded] = Object.values((await subState.load()).seeding);
      assert.ok(
        existsSync(keptTorrent(seeded.infohashV1!)),
        'the installed band keeps its torrent',
      );
    });

    it('installs from a copy its own engine already seeds, leaving that seed alone', async () => {
      // This node publishes band-a and subscribes to the same bytes: one
      // engine, which already seeds the torrent from the publisher's links.
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      const engine = new MemoryTransport(swarm);
      await publishTorrents(engine);
      const [seed] = Object.values((await pubState.load()).seeding);
      let removed = 0;
      const remove = engine.remove.bind(engine);
      engine.remove = async (id, opts) => {
        removed++;
        return remove(id, opts);
      };
      const verifyFailed = await counted('verify_failed', 'torrent');

      await makeTorrentSubscriber(engine).pollOnce();

      assert.deepEqual(await installedIds(), ['band-a']);
      assert.deepEqual(
        await installedDigests('band-a'),
        await publishedDigests(),
      );
      assert.equal(await counted('verify_failed', 'torrent'), verifyFailed);
      assert.equal(removed, 0, "the publisher's seed was not taken over");
      assert.equal((await engine.status(seed.id))?.state, 'seeding');
    });

    it('refuses a band file the engine replaced with a symlink, and fetches over HTTP', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      const engine = new MemoryTransport(swarm);
      const status = engine.status.bind(engine);
      let swapped = false;
      engine.status = async (id) => {
        const result = await status(id);
        const dir = result?.savePath;
        if (!swapped && result?.state === 'seeding' && dir !== undefined) {
          // A compromised engine points a finished file somewhere else.
          const name = (await fs.readdir(dir)).find((n) => n.endsWith('.cdb'))!;
          await fs.rm(path.join(dir, name));
          await fs.symlink('/etc/hostname', path.join(dir, name));
          swapped = true;
        }
        return result;
      };
      const verifyFailed = await counted('verify_failed', 'torrent');

      await makeTorrentSubscriber(engine).pollOnce();

      assert.ok(swapped);
      assert.equal(await counted('verify_failed', 'torrent'), verifyFailed + 1);
      assert.deepEqual(await installedIds(), ['band-a'], 'installed over HTTP');
      assert.deepEqual(
        await installedDigests('band-a'),
        await publishedDigests(),
      );
    });

    it('refuses a signed torrent that carries a file the band does not list', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents(new MemoryTransport(swarm));
      // A publisher signs a torrent of the band plus a file of its choosing.
      const bandDir = path.join(pubDir, 'root-tx-index', 'band-a');
      const doc: any = JSON.parse(
        await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
      );
      const band = doc.indexes[0].bands[0];
      await fs.writeFile(path.join(bandDir, 'extra.bin'), Buffer.alloc(50_000));
      const hostile = await buildTorrent({
        dir: bandDir,
        name: torrentNameForFiles(band.files),
        files: [
          ...band.files.map((f: { name: string }) => f.name),
          'extra.bin',
        ],
      });
      await fs.writeFile(
        path.join(pubDir, 'root-tx-index', 'band-a.torrent'),
        hostile.torrent,
      );
      await resign((d) => {
        d.indexes[0].bands[0].torrent.infohashV1 = hostile.infohashV1;
        d.indexes[0].bands[0].torrent.infohashV2 = hostile.infohashV2;
      });

      const engine = new MemoryTransport(swarm);
      let added = 0;
      const add = engine.add.bind(engine);
      engine.add = async (opts) => {
        added++;
        return add(opts);
      };
      const verifyFailed = await counted('verify_failed', 'torrent');
      await makeTorrentSubscriber(engine).pollOnce();

      assert.equal(added, 0, 'the engine never saw it');
      assert.equal(await counted('verify_failed', 'torrent'), verifyFailed + 1);
      assert.deepEqual(await installedIds(), ['band-a'], 'installed over HTTP');
    });

    it('does not count a download in flight against its own disk budget', async () => {
      await makeBand('band-a');
      const swarm = new MemorySwarm();
      await publishTorrents();
      const engine = new MemoryTransport(swarm);
      const doc: any = JSON.parse(
        await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
      );
      const band = doc.indexes[0].bands[0];
      const bandBytes = band.files.reduce(
        (sum: number, f: { size: number }) => sum + f.size,
        0,
      );
      const opts = {
        torrentWatchMs: 20,
        maxDiskBytes: Math.floor(bandBytes * 1.5),
      };
      await makeTorrentSubscriber(engine, opts).pollOnce();
      // The engine has allocated the files, as libtorrent does early on.
      const partial = path.join(
        path.dirname(subIncoming),
        'swarm',
        band.torrent.infohashV1,
        'allocated.bin',
      );
      await fs.writeFile(partial, Buffer.alloc(bandBytes));

      await new MemoryTransport(swarm).seed({
        torrent: await fs.readFile(
          path.join(pubDir, 'root-tx-index', 'band-a.torrent'),
        ),
        dir: path.join(pubDir, 'root-tx-index', 'band-a'),
      });
      await makeTorrentSubscriber(engine, opts).pollOnce();
      assert.deepEqual(await installedIds(), ['band-a']);
    });

    it('shares one watch window across every torrent in a poll', async () => {
      await makeBand('band-a');
      await makeBand('band-b', 5);
      await makeBand('band-c', 7);
      await publishTorrents(); // no seeder: every torrent waits
      const engine = new MemoryTransport(new MemorySwarm());
      const started = Date.now();
      await makeTorrentSubscriber(engine, { torrentWatchMs: 300 }).pollOnce();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 800, `one window, not one per band (${elapsed} ms)`);
      assert.equal(
        Object.keys((await subState.load()).downloads).length,
        3,
        'every torrent was added in the first poll',
      );
    });

    it('drops the download of a band rebuilt under the same id', async () => {
      await makeBand('band-a');
      await publishTorrents(); // no seeder
      const engine = new MemoryTransport(new MemorySwarm());
      await makeTorrentSubscriber(engine, { torrentWatchMs: 20 }).pollOnce();
      const [first] = Object.keys((await subState.load()).downloads);

      await fs.rm(path.join(pubDir, 'root-tx-index', 'band-a'), {
        recursive: true,
      });
      await makeBand('band-a', 9);
      clock = new Date(clock.getTime() + 60_000);
      await publishTorrents();
      await makeTorrentSubscriber(engine, { torrentWatchMs: 20 }).pollOnce();

      const now = Object.keys((await subState.load()).downloads);
      assert.equal(now.length, 1);
      assert.notEqual(now[0], first, 'the old download is gone');
    });

    it('stops seeding a band once it is retired', async () => {
      await makeBand('band-a');
      await makeBand('band-b');
      const swarm = new MemorySwarm();
      const publisherEngine = new MemoryTransport(swarm);
      await publishTorrents(publisherEngine);
      const engine = new MemoryTransport(swarm);
      const subscriber = makeTorrentSubscriber(engine);
      await subscriber.pollOnce();
      assert.equal(Object.keys((await subState.load()).seeding).length, 2);

      await fs.rm(path.join(pubDir, 'root-tx-index', 'band-b'), {
        recursive: true,
      });
      await pubState.update((draft) => {
        draft.describeCache = {};
      });
      clock = new Date(clock.getTime() + 60_000);
      await publishTorrents(publisherEngine);
      await subscriber.pollOnce();

      const left = Object.values((await subState.load()).seeding).map(
        (s) => s.band,
      );
      assert.deepEqual(left, ['band-a']);
      assert.equal(
        existsSync(path.join(subInstalled, 'root-tx-index', 'band-b.torrent')),
        false,
      );
    });
  });

  it('installs every band a publisher offers', async () => {
    await makeBand('band-a');
    await makeBand('band-b');
    await publish();

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a', 'band-b']);
    for (const id of ['band-a', 'band-b']) {
      const dir = await bandDir(id);
      assert.equal(
        path.dirname(dir),
        path.join(subInstalled, 'root-tx-index'),
        `${id} is installed in the directory the gateway loads`,
      );
      assert.equal(
        existsSync(path.join(dir, 'manifest.json')),
        true,
        `${id} is installed where the gateway loads it`,
      );
    }
    const state = await subState.load();
    assert.equal(state.subscriptions[WALLET].sequence, 1);
    assert.equal(
      state.subscriptions[WALLET].manifestSha256,
      crypto
        .createHash('sha256')
        .update(await fs.readFile(path.join(pubDir, 'publication.json')))
        .digest('hex'),
      'records the digest of the document as served',
    );
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
    await Promise.all([first, second]);
    assert.deepEqual(await installedIds(), ['band-a']);
    assert.equal(
      blobRequests.length,
      new Set(blobRequests).size,
      'the second call joined the first: no file was fetched twice',
    );
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
      existsSync(path.join(subIncoming, WALLET, 'root-tx-index', 'band-a')),
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
      path.join(await bandDir('band-a'), 'manifest.json'),
    );

    await subscriber.pollOnce();
    const second = await fs.stat(
      path.join(await bandDir('band-a'), 'manifest.json'),
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

  it('refuses a sequence that jumps too far, which would lock out every genuine document', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    const seen = (await subState.load()).subscriptions[WALLET].sequence;

    await makeBand('band-b');
    clock = new Date(clock.getTime() + 60_000);
    await publish();
    await resign((doc) => {
      doc.sequence = seen + MAX_SEQUENCE_JUMP + 1;
    });
    const before = await counted('sequence_jump');
    await makeSubscriber().pollOnce();

    assert.equal(await counted('sequence_jump'), before + 1);
    assert.deepEqual(await installedIds(), ['band-a'], 'nothing new installed');
    assert.equal(
      (await subState.load()).subscriptions[WALLET].sequence,
      seen,
      'the huge sequence was not recorded',
    );

    // The genuine next document still works.
    await resign((doc) => {
      doc.sequence = seen + 1;
    });
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a', 'band-b']);
  });

  it('starts a new count when the publisher signs with a new key', async () => {
    await makeBand('band-a');
    await publish();
    // What an earlier key left behind: a high sequence.
    await subState.update((draft) => {
      draft.subscriptions[WALLET] = {
        sequence: 50,
        keyId: 'OldObserverKeyThatWasRotatedAway11111111111',
        manifestSha256: '',
        updatedAt: clock.toISOString(),
      };
    });

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    const state = (await subState.load()).subscriptions[WALLET];
    assert.equal(state.keyId, signer.keyId);
    assert.equal(state.sequence, 1);
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
      (await dirsOnDisk('band-a')).length,
      0,
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
    const incomingBand = path.join(
      subIncoming,
      WALLET,
      'root-tx-index',
      'band-a',
    );
    await fs.mkdir(incomingBand, { recursive: true });
    const source = await fs.readFile(
      path.join(pubDir, 'root-tx-index', 'band-a', file.name),
    );
    await fs.writeFile(
      path.join(incomingBand, `${file.name}.${file.sha256.slice(0, 16)}.tmp`),
      source.subarray(0, Math.max(1, Math.floor(source.length / 2))),
    );

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    const installedFile = await fs.readFile(
      path.join(await bandDir('band-a'), file.name),
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

  it('installs the newest heights first, whatever order they are published in', async () => {
    // Published oldest first, and named so that id order is wrong too.
    await makeBand('a-old', 3, { heightRange: [0, 999] });
    await makeBand('b-tip', 3, { heightRange: [2000, null] });
    await makeBand('c-mid', 3, { heightRange: [1000, 1999] });
    await publish();
    const doc = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    // The bands hold the same keys, so their partition files share digests;
    // only each manifest (which carries the height range) tells them apart.
    const bandOf = new Map<string, string>();
    for (const band of doc.indexes[0].bands) {
      for (const file of band.files) {
        if (file.name === 'manifest.json') bandOf.set(file.sha256, band.id);
      }
    }

    await makeSubscriber().pollOnce();

    const order = blobRequests.flatMap((digest) => {
      const id = bandOf.get(digest);
      return id !== undefined ? [id] : [];
    });
    assert.deepEqual(order, ['b-tip', 'c-mid', 'a-old']);
  });

  describe('never fetches where the network would not let an outsider', () => {
    // Stands in for an internal service on the gateway's network.
    let internal: http.Server;
    let internalOrigin: string;
    let internalHits: number;
    beforeEach(async () => {
      internalHits = 0;
      internal = http.createServer((_req, res) => {
        internalHits++;
        res.writeHead(200).end('internal');
      });
      await new Promise<void>((resolve) =>
        internal.listen(0, '127.0.0.1', resolve),
      );
      const address = internal.address();
      assert(address !== null && typeof address === 'object');
      internalOrigin = `http://127.0.0.1:${address.port}`;
    });
    afterEach(async () => {
      internal.closeAllConnections();
      await new Promise<void>((resolve) => internal.close(() => resolve()));
    });

    it('skips a band whose files are on another server', async () => {
      await makeBand('band-a');
      await publish();
      await resign((doc) => {
        doc.indexes[0].bands[0].http = { baseUrl: `${internalOrigin}/x/?q=` };
      });
      const before = await counted('unreachable');

      await makeSubscriber().pollOnce();

      assert.equal(internalHits, 0, 'the internal service was never asked');
      assert.deepEqual(await installedIds(), []);
      assert.equal(await counted('unreachable'), before + 1);
    });

    it('fetches another server that the operator allowed', async () => {
      await makeBand('band-a');
      await publish();
      await resign((doc) => {
        doc.indexes[0].bands[0].http = { baseUrl: `${internalOrigin}/x/` };
      });

      await makeSubscriber({ allowedFileOrigins: [internalOrigin] }).pollOnce();

      assert(internalHits > 0, 'the allowed server was asked');
    });

    it('does not follow a redirect from the publisher', async () => {
      const redirecting = http.createServer((_req, res) => {
        res
          .writeHead(302, { location: `${internalOrigin}/ar-io/indexes` })
          .end();
      });
      await new Promise<void>((resolve) =>
        redirecting.listen(0, '127.0.0.1', resolve),
      );
      const address = redirecting.address();
      assert(address !== null && typeof address === 'object');
      try {
        await makeSubscriber({
          url: `http://127.0.0.1:${address.port}`,
        }).pollOnce();
        assert.equal(internalHits, 0, 'the redirect was not followed');
      } finally {
        redirecting.closeAllConnections();
        await new Promise<void>((resolve) =>
          redirecting.close(() => resolve()),
        );
      }
    });
  });

  it('names itself on every request to a publisher', async () => {
    await makeBand('band-a');
    await publish();

    await makeSubscriber({
      userAgent: 'ar-io-index-swarm/test (WALLET)',
    }).pollOnce();

    assert.deepEqual(await installedIds(), ['band-a']);
    assert(userAgents.length > 1, 'the document and the files were fetched');
    assert.deepEqual(
      [...new Set(userAgents)],
      ['ar-io-index-swarm/test (WALLET)'],
    );
  });

  it('keeps serving a band while its replacement loads: no lookup misses', async () => {
    // The gateway's own collection source, watching the installed directory
    // exactly as in production.
    await makeBand('band-tip', 3);
    await publish();
    const subscriber = makeSubscriber({ replaceOverlapMs: 60_000 });
    await subscriber.pollOnce();
    const index = new Cdb64RootTxIndex({
      log,
      sources: [path.join(subInstalled, 'root-tx-index')],
      watch: true,
    });
    const key = toB64Url(txId(0));
    try {
      assert.notEqual(await index.getRootTx(key), undefined, 'served before');

      // The publisher rebuilds the tip under the same id.
      await fs.rm(path.join(pubDir, 'root-tx-index', 'band-tip'), {
        recursive: true,
        force: true,
      });
      await makeBand('band-tip', 5);
      clock = new Date(clock.getTime() + 60_000);
      await publish();

      let misses = 0;
      let lookups = 0;
      let running = true;
      const looking = (async () => {
        while (running) {
          lookups++;
          if ((await index.getRootTx(key)) === undefined) misses++;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      const settle = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      // The replacement installs; the old copy is recorded as due later.
      await subscriber.pollOnce();
      // The gateway loads the new directory (its watcher waits ~1 s).
      await settle(2500);
      // Past the overlap, the next housekeeping retires the old copy.
      clock = new Date(clock.getTime() + 61_000);
      await subscriber.pollOnce();
      await settle(1500);
      running = false;
      await looking;

      assert(lookups > 100, `looked up ${lookups} times across the replace`);
      assert.equal(misses, 0, `${misses} of ${lookups} lookups missed`);
      const records = JSON.parse(
        await fs.readFile(
          path.join(await bandDir('band-tip'), 'manifest.json'),
          'utf8',
        ),
      ).totalRecords;
      assert.equal(records, 5, 'the rebuilt band is the one live now');
      // Retired and (grace 0 here) swept: only the new copy is left.
      assert.deepEqual(await dirsOnDisk('band-tip'), [
        path.basename(await bandDir('band-tip')),
      ]);
    } finally {
      await index.close();
    }
  });

  describe('when two publishers offer one band id', () => {
    const OTHER = 'OtherPublisherWallet1111111111111111111111111';
    const holdByOther = async () => {
      await subState.update((draft) => {
        draft.installed['root-tx-index'] = {
          'band-a': {
            dir: path.join(subInstalled, 'root-tx-index', 'band-a~other'),
            files: [{ name: 'manifest.json', size: 1, sha256: 'c'.repeat(64) }],
            installedAt: clock.toISOString(),
            publisher: OTHER,
          },
        };
      });
    };

    it('leaves the band with the publisher whose copy is live', async () => {
      await makeBand('band-a');
      await publish();
      await holdByOther();
      const before = await counted('band_conflict');

      await makeSubscriber({ alsoSubscribedTo: [OTHER] }).pollOnce();

      assert.equal(await counted('band_conflict'), before + 1);
      assert.deepEqual(blobRequests, [], 'nothing was downloaded');
      const band = (await subState.load()).installed['root-tx-index']['band-a'];
      assert.equal(band.publisher, OTHER, 'still held by the other publisher');
    });

    it('takes over a band whose publisher is no longer subscribed to', async () => {
      await makeBand('band-a');
      await publish();
      await holdByOther();

      await makeSubscriber().pollOnce();

      const band = (await subState.load()).installed['root-tx-index']['band-a'];
      assert.equal(band.publisher, WALLET);
    });
  });

  it('adopts a band already on disk instead of fetching it again', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    const dir = await bandDir('band-a');

    // State is lost (or the process died between install and the write).
    await fs.rm(path.join(tempDir, 'sub', 'state.json'), { force: true });
    subState = new StateStore({
      log,
      filePath: path.join(tempDir, 'sub', 'state.json'),
    });
    blobRequests = [];

    await makeSubscriber().pollOnce();

    assert.deepEqual(blobRequests, [], 'nothing was downloaded');
    assert.equal(await bandDir('band-a'), dir, 'the copy on disk was adopted');
  });

  it('does not adopt a copy on disk that fails validation', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    await fs.rm(path.join(tempDir, 'sub', 'state.json'), { force: true });
    subState = new StateStore({
      log,
      filePath: path.join(tempDir, 'sub', 'state.json'),
    });
    blobRequests = [];
    // A kind that refuses what is already installed (as the stricter
    // validation now would a band an older build let through), and accepts
    // a fresh download.
    const base = createKindRegistry({ log }).get('cdb64-root-tx')!;
    const strict: ArtifactKind = Object.assign(Object.create(base), {
      validate: async (band: any, dir: string) => {
        if (dir.startsWith(subInstalled)) throw new Error('not well-formed');
        return base.validate(band, dir);
      },
    });

    await makeSubscriber({
      kinds: new Map([['cdb64-root-tx', strict]]),
    }).pollOnce();

    assert(blobRequests.length > 0, 'downloaded again instead of adopting');
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('retires a band from a publisher no longer subscribed to', async () => {
    const dir = path.join(subInstalled, 'root-tx-index', 'band-g~000000000000');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
    await subState.update((draft) => {
      draft.installed['root-tx-index'] = {
        'band-g': {
          dir,
          files: [],
          installedAt: clock.toISOString(),
          publisher: 'GonePublisherWallet11111111111111111111111111',
        },
      };
    });

    await makeSubscriber({ subscribe: [] }).pollOnce();

    assert.equal(existsSync(dir), false, 'retired and (grace 0) swept');
  });

  it('counts downloads waiting in incoming/ against the disk budget', async () => {
    await makeBand('band-a');
    await publish();
    const doc = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    const bandBytes = doc.indexes[0].bands[0].files.reduce(
      (sum: number, f: { size: number }) => sum + f.size,
      0,
    );
    // Something else is already waiting in incoming/.
    const waiting = path.join(subIncoming, WALLET, 'root-tx-index', 'band-x');
    await fs.mkdir(waiting, { recursive: true });
    await fs.writeFile(path.join(waiting, 'part.tmp'), Buffer.alloc(64));
    const before = await counted('skipped_disk_budget');

    await makeSubscriber({ maxDiskBytes: bandBytes + 10 }).pollOnce();

    assert.equal(await counted('skipped_disk_budget'), before + 1);
    assert.deepEqual(await installedIds(), []);
  });

  it('clears downloads nothing will finish', async () => {
    await makeBand('band-a');
    await publish();
    const dropped = path.join(
      subIncoming,
      WALLET,
      'root-tx-index',
      'band-gone',
    );
    const oldLayout = path.join(subIncoming, 'root-tx-index', 'band-a');
    for (const dir of [dropped, oldLayout]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'x.tmp'), 'partial');
    }

    await makeSubscriber().pollOnce();

    assert.equal(existsSync(dropped), false, 'a band no longer offered');
    assert.equal(
      existsSync(path.join(subIncoming, 'root-tx-index')),
      false,
      'the layout from before downloads were kept per publisher',
    );
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('polls each publisher independently: a stalled one holds up only itself', async () => {
    await makeBand('band-a');
    await publish();
    // A second publisher whose server accepts the request and never answers.
    const SLOW = 'SlowPublisherWallet11111111111111111111111111';
    let release: () => void = () => undefined;
    const hanging = http.createServer((_req, res) => {
      release = () => res.destroy();
    });
    await new Promise<void>((resolve) =>
      hanging.listen(0, '127.0.0.1', resolve),
    );
    const address = hanging.address();
    assert(address !== null && typeof address === 'object');
    const registry: GatewayRegistry = {
      lookup: async (wallet) =>
        wallet === SLOW
          ? {
              wallet: SLOW,
              observerAddress: signer.keyId,
              url: `http://127.0.0.1:${address.port}`,
              status: 'joined' as const,
            }
          : {
              wallet: WALLET,
              observerAddress: signer.keyId,
              url: origin,
              status: 'joined' as const,
            },
    };
    try {
      const subscriber = makeSubscriber({
        registry,
        // The stalled one first, which a serial poll would wait on.
        subscribe: [{ publisher: SLOW }, { publisher: WALLET }],
      });
      const poll = subscriber.pollOnce();
      // The healthy publisher's band installs while the other still hangs.
      let installed = false;
      for (let i = 0; i < 200 && !installed; i++) {
        installed = (await installedIds()).includes('band-a');
        if (!installed) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(installed, 'band-a installed while the other publisher stalled');
      release();
      await poll;
    } finally {
      release();
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('keeps the manifest-age alarm climbing while a publisher is unreachable', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    const issued = Date.parse(
      JSON.parse(
        await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
      ).issuedAt,
    );
    const age = async () =>
      (await subscriptionManifestAge.get()).values.find(
        (v) => v.labels.publisher === WALLET,
      )?.value;

    // The publisher goes away. Nothing new is fetched, but time passes.
    const unreachable: GatewayRegistry = { lookup: async () => undefined };
    const realNow = manifestAgeClock.now;
    manifestAgeClock.now = () => issued + 3_600_000;
    try {
      await makeSubscriber({ registry: unreachable }).pollOnce();
      assert.equal(
        await age(),
        3600,
        'an hour old, not frozen at its last fetch',
      );
    } finally {
      manifestAgeClock.now = realNow;
    }
  });

  it('stops promptly mid-download, leaving nothing half-installed', async () => {
    await makeBand('band-a');
    await publish();
    // Every file download stalls until the test ends.
    const stalled: http.ServerResponse[] = [];
    failPartitionsWith = undefined;
    const original = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (/\/blob\//.test(req.url ?? '')) {
        res.writeHead(200, { 'content-length': '1000000' });
        res.write('x');
        stalled.push(res);
        return;
      }
      original(req, res);
    });
    try {
      const subscriber = makeSubscriber();
      const poll = subscriber.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      await subscriber.stop();
      await poll;
      assert(Date.now() - started < 3000, 'stop did not wait out the download');
      assert.deepEqual(await installedIds(), []);
      assert.deepEqual(await dirsOnDisk('band-a'), []);
    } finally {
      for (const res of stalled) res.destroy();
      server.removeAllListeners('request');
      server.on('request', original);
    }
  });

  it('bounds the index names it labels, however many a publisher invents', async () => {
    // The cap is per subscriber, one per process in production; clear what
    // earlier tests in this file labelled.
    subscriptionTotal.reset();
    await makeBand('band-a');
    await publish();
    await resign((doc) => {
      for (let i = 0; i < 40; i++) {
        doc.indexes.push({
          name: `invented-${i}`,
          kind: 'no-such-kind',
          bands: [doc.indexes[0].bands[0]],
        });
      }
    });

    await makeSubscriber().pollOnce();

    const labels = new Set(
      (await subscriptionTotal.get()).values
        .filter((v) => v.labels.publisher === WALLET)
        .map((v) => v.labels.index),
    );
    assert(labels.size <= 16 + 1, `${labels.size} index labels`);
    assert(labels.has('(other)'), 'the rest share one label');
  });

  it('keeps an install that lands while the sweep is deleting', async () => {
    // A retired band waiting to be swept.
    await subState.update((draft) => {
      draft.installed['root-tx-index'] = {
        old: {
          dir: path.join(subInstalled, 'root-tx-index', 'old~1'),
          files: [],
          installedAt: '',
          retiredAt: new Date(0).toISOString(),
        },
      };
    });
    // A kind whose sweep pauses mid-way, as a slow delete on a busy disk does.
    const real = createKindRegistry({ log });
    const base = real.get('cdb64-root-tx')!;
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (release = resolve));
    let sweeping: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (sweeping = resolve));
    const slow: ArtifactKind = Object.assign(Object.create(base), {
      sweepRetired: async (
        request: Parameters<ArtifactKind['sweepRetired']>[0],
      ) => {
        // It has read its entries and is still deleting when the next
        // poll's install lands.
        const result = await base.sweepRetired(request);
        sweeping();
        await paused;
        return result;
      },
    });
    const subscriber = makeSubscriber({
      kinds: new Map([['cdb64-root-tx', slow]]),
      subscribe: [],
    });

    const poll = subscriber.pollOnce();
    await started;
    // Meanwhile another poll installs a band.
    await subState.update((draft) => {
      draft.installed['root-tx-index'].fresh = {
        dir: path.join(subInstalled, 'root-tx-index', 'fresh~2'),
        files: [],
        installedAt: clock.toISOString(),
        publisher: WALLET,
      };
    });
    release();
    await poll;

    const bands = (await subState.load()).installed['root-tx-index'];
    assert.deepEqual(Object.keys(bands), ['fresh'], 'swept old, kept fresh');
  });

  it('never carries stale download files into an installed band', async () => {
    await makeBand('band-a');
    await publish();
    // Left by older generations of this band: a partial under an old digest,
    // and a finished file the current band doesn't have.
    const incoming = path.join(subIncoming, WALLET, 'root-tx-index', 'band-a');
    await fs.mkdir(incoming, { recursive: true });
    await fs.writeFile(
      path.join(incoming, `00.cdb.${'e'.repeat(16)}.tmp`),
      'old',
    );
    await fs.writeFile(path.join(incoming, 'gone.cdb'), 'old');

    await makeSubscriber().pollOnce();

    const installed = await fs.readdir(await bandDir('band-a'));
    assert.equal(installed.includes('gone.cdb'), false);
    assert.equal(
      installed.some((n) => n.endsWith('.tmp')),
      false,
    );
  });

  it('retires a band directory no record points at, once it has sat a while', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    // Left by a crash or lost state: live to the gateway, unknown to state.
    const root = path.join(subInstalled, 'root-tx-index');
    const orphan = path.join(root, 'band-x~deadbeef0000');
    const fresh = path.join(root, 'band-y~deadbeef0000');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'manifest.json'), '{}');
    // Only the orphan has sat past the minimum age.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await fs.mkdir(fresh, { recursive: true });
    await fs.writeFile(path.join(fresh, 'manifest.json'), '{}');

    await makeSubscriber({ untrackedMinAgeMs: 1000 }).pollOnce();

    assert.equal(existsSync(orphan), false, 'the orphan was retired and swept');
    assert.equal(existsSync(fresh), true, 'a new directory is left alone');
    assert.deepEqual(await installedIds(), ['band-a']);
  });

  it('retires nothing untracked until every publisher has been reconciled', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    const dir = await bandDir('band-a');
    // State is lost, and the publisher is down on the first poll after.
    await fs.rm(path.join(tempDir, 'sub', 'state.json'), { force: true });
    subState = new StateStore({
      log,
      filePath: path.join(tempDir, 'sub', 'state.json'),
    });
    const down: GatewayRegistry = { lookup: async () => undefined };

    await makeSubscriber({ registry: down, untrackedMinAgeMs: 0 }).pollOnce();
    assert.equal(
      existsSync(path.join(dir, 'manifest.json')),
      true,
      'the band was not mistaken for an orphan while its publisher was down',
    );

    // The publisher is back: the copy on disk is adopted, not downloaded.
    blobRequests = [];
    await makeSubscriber({ untrackedMinAgeMs: 0 }).pollOnce();
    assert.deepEqual(blobRequests, [], 'nothing was downloaded');
    assert.equal(await bandDir('band-a'), dir);
  });

  it('reinstalls a band whose record outlived its files', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    await fs.rm(await bandDir('band-a'), { recursive: true, force: true });

    await makeSubscriber().pollOnce();

    assert.equal(
      existsSync(path.join(await bandDir('band-a'), 'manifest.json')),
      true,
    );
  });

  it('keeps the live band through a rollback to a generation still being swept', async () => {
    const key = toB64Url(txId(0));
    await makeBand('band-tip', 3);
    await publish();
    // A long grace, so the retired copy's record outlives the rollback.
    const slow = makeSubscriber({ supersedeGraceMs: 3_600_000 });
    await slow.pollOnce();
    const firstDir = await bandDir('band-tip');

    // Rebuilt (generation B), then rolled back to the first build's exact
    // bytes (generation A again).
    const published = path.join(pubDir, 'root-tx-index', 'band-tip');
    const saved = path.join(tempDir, 'band-tip-first-build');
    await fs.cp(published, saved, { recursive: true });
    await fs.rm(published, { recursive: true, force: true });
    await makeBand('band-tip', 5);
    clock = new Date(clock.getTime() + 60_000);
    await publish();
    await slow.pollOnce();
    await fs.rm(published, { recursive: true, force: true });
    await fs.cp(saved, published, { recursive: true });
    clock = new Date(clock.getTime() + 60_000);
    await publish();
    await slow.pollOnce();

    const liveDir = await bandDir('band-tip');
    assert.notEqual(
      path.resolve(liveDir),
      path.resolve(firstDir),
      'a directory still claimed by a retired record is not reused',
    );

    // Now the sweep runs out its grace: the live band must survive it.
    await makeSubscriber().pollOnce();
    assert.equal(existsSync(path.join(liveDir, 'manifest.json')), true);
    const index = new Cdb64RootTxIndex({
      log,
      sources: [path.join(subInstalled, 'root-tx-index')],
      watch: false,
    });
    try {
      assert.notEqual(await index.getRootTx(key), undefined, 'still served');
    } finally {
      await index.close();
    }
  });

  it('keeps the files that completed, and fetches only the rest next poll', async () => {
    // A publisher behind a load balancer where one node lacks the routes
    // answers some requests 404. The files that did arrive must not be
    // fetched again, or a band never completes.
    await makeBand('band-a', 12);
    await publish();
    const doc = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    const files: Array<{ sha256: string }> = doc.indexes[0].bands[0].files;
    assert(files.length > 4, 'enough files to spread across the poll');
    const unlucky = files[files.length - 1].sha256;
    notFoundOnce.add(unlucky);
    const subscriber = makeSubscriber();

    await subscriber.pollOnce();
    assert.deepEqual(await installedIds(), []);
    assert.equal(
      new Set(blobRequests).size,
      files.length,
      'every file was attempted, not only those before the failure',
    );

    blobRequests = [];
    await subscriber.pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);
    assert.deepEqual(blobRequests, [unlucky], 'only the missing file');
  });

  it('stops every band once the publisher meters it, not just the one refused', async () => {
    // Different keys per band, so their files are distinct digests.
    await makeBand('band-new', 12, { heightRange: [100, null] });
    await makeBand('band-old', 30, { heightRange: [0, 99] });
    await publish();
    const doc = JSON.parse(
      await fs.readFile(path.join(pubDir, 'publication.json'), 'utf8'),
    );
    const oldDigests = new Set(
      doc.indexes[0].bands
        .find((b: any) => b.id === 'band-old')
        .files.map((f: any) => f.sha256),
    );
    const newDigests = new Set(
      doc.indexes[0].bands
        .find((b: any) => b.id === 'band-new')
        .files.map((f: any) => f.sha256),
    );
    failPartitionsWith = 402;

    await makeSubscriber().pollOnce();

    const onlyOld = blobRequests.filter(
      (d) => oldDigests.has(d) && !newDigests.has(d),
    );
    assert.deepEqual(
      onlyOld,
      [],
      'the older band started nothing after the newer one was refused',
    );
  });

  it('stops starting files once the publisher meters it', async () => {
    await makeBand('band-a', 12);
    await publish();
    failPartitionsWith = 402;

    await makeSubscriber().pollOnce();
    // Nothing may still be running after the poll returns.
    const atReturn = blobRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      blobRequests.length,
      atReturn,
      'no download outlived the poll',
    );
    // Files in flight when the first 402 arrived may finish; nothing new
    // starts. With 4 at a time that is at most 4 refused partitions, plus
    // the manifest.
    assert(
      blobRequests.length <= 5,
      `asked ${blobRequests.length} times after being metered`,
    );
  });

  it('replaces a band the publisher rebuilt under the same id', async () => {
    // The rolling tip band is rebuilt in place on every publisher cadence.
    await makeBand('band-tip', 3);
    await publish();
    const subscriber = makeSubscriber();
    await subscriber.pollOnce();
    const before = JSON.parse(
      await fs.readFile(
        path.join(await bandDir('band-tip'), 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(before.totalRecords, 3);

    await fs.rm(path.join(pubDir, 'root-tx-index', 'band-tip'), {
      recursive: true,
      force: true,
    });
    await makeBand('band-tip', 5);
    clock = new Date(clock.getTime() + 60_000);
    await publish();

    await subscriber.pollOnce();

    const after = JSON.parse(
      await fs.readFile(
        path.join(await bandDir('band-tip'), 'manifest.json'),
        'utf8',
      ),
    );
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
    assert.deepEqual(await dirsOnDisk('band-b'), []);
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
      assert.deepEqual(await dirsOnDisk(id), [], `${id} was swept`);
    }
  });

  it('retires the bands of an index the publisher stops publishing', async () => {
    await makeBand('band-a');
    await publish();
    await makeSubscriber().pollOnce();
    assert.deepEqual(await installedIds(), ['band-a']);

    // The publisher drops the whole index, not just its bands, so the
    // document no longer names root-tx-index at all.
    clock = new Date(clock.getTime() + 60_000);
    await publish([]);

    await makeSubscriber().pollOnce();

    assert.deepEqual(await installedIds(), []);
    assert.deepEqual(await dirsOnDisk('band-a'), [], 'band-a was swept');
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

describe('bandsNewestFirst', () => {
  const band = (id: string, heightRange?: [number, number | null]) => ({
    id,
    files: [],
    ...(heightRange !== undefined ? { heightRange } : {}),
  });
  const ids = (bands: Array<{ id: string }>) => bands.map((b) => b.id);

  it('puts the open-ended tip band first, then by the top of each range', () => {
    // turbo-gateway's four bands, in a scrambled order.
    const ordered = bandsNewestFirst([
      band('b3', [1_350_000, 1_849_999]),
      band('b1', [1_950_000, null]),
      band('b4', [0, 1_349_999]),
      band('b2', [1_850_000, 1_949_999]),
    ]);
    assert.deepEqual(ids(ordered), ['b1', 'b2', 'b3', 'b4']);
  });

  it('breaks a tie on the top by the higher bottom, then keeps the given order', () => {
    const ordered = bandsNewestFirst([
      band('wide-tip', [0, null]),
      band('narrow-tip', [1_990_000, null]),
      band('same-a', [100, 200]),
      band('same-b', [100, 200]),
    ]);
    assert.deepEqual(ids(ordered), [
      'narrow-tip',
      'wide-tip',
      'same-a',
      'same-b',
    ]);
  });

  it('puts bands with no height range last, in the given order', () => {
    const ordered = bandsNewestFirst([
      band('unknown-1'),
      band('old', [0, 10]),
      band('unknown-2'),
    ]);
    assert.deepEqual(ids(ordered), ['old', 'unknown-1', 'unknown-2']);
  });

  it('does not reorder the array it was given', () => {
    const given = [band('old', [0, 10]), band('tip', [11, null])];
    bandsNewestFirst(given);
    assert.deepEqual(ids(given), ['old', 'tip']);
  });
});
