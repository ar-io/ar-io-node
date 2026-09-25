/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The TorrentTransport contract, run against every implementation.
 *
 * Always against the in-memory fake. Against a real qBittorrent too when
 * `INDEX_SWARM_E2E_ENGINE_URL` is set, which needs:
 *
 * - `INDEX_SWARM_E2E_ENGINE_DIR`: a directory this process can write that
 *   the engine sees at the same path (mount it at the same path in the
 *   engine container).
 * - `INDEX_SWARM_E2E_WEBSEED_HOST`: how the engine reaches this process, for
 *   the WebSeed the download test serves (default `host.docker.internal`,
 *   which needs `--add-host=host.docker.internal:host-gateway`).
 * - `INDEX_SWARM_E2E_ENGINE_AUTH`: `user:password`, unless the engine allows
 *   the test's address without a login.
 *
 * Run the engine with DHT, LSD, PeX and UPnP off: the test torrents have no
 * trackers, but an engine with DHT on would still announce them. Publish its
 * Web UI port under the same number it listens on (`WebUI\Port`): qBittorrent
 * answers 401 to everything when the Host header's port differs.
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import { buildTorrent, BuiltTorrent } from '../torrent.js';
import { MemorySwarm, MemoryTransport } from './memory.js';
import { QBittorrentTransport } from './qbittorrent.js';
import { TorrentStatus, TorrentTransport } from './types.js';

interface Harness {
  transport: TorrentTransport;
  /** A directory the transport's engine sees at the same path. */
  root: string;
  /** Make a torrent that was added to `transport` downloadable. */
  provide(id: string, built: BuiltTorrent, filesDir: string): Promise<void>;
  close(): Promise<void>;
}

const FILES = { 'a.cdb': 40_000, 'b.cdb': 16_384, 'c.cdb': 70_001 };

async function writeBand(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, size] of Object.entries(FILES)) {
    await fs.writeFile(path.join(dir, name), crypto.randomBytes(size));
  }
}

async function digests(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    out[name] = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(dir, name)))
      .digest('hex');
  }
  return out;
}

async function waitForStatus(
  transport: TorrentTransport,
  id: string,
  predicate: (s: TorrentStatus | undefined) => boolean,
  timeoutMs = 30_000,
): Promise<TorrentStatus | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await transport.status(id);
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting on ${id}; last ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function contract(name: string, makeHarness: () => Promise<Harness>): void {
  describe(`TorrentTransport contract: ${name}`, () => {
    let harness: Harness;
    let work: string;
    const added: string[] = [];

    before(async () => {
      harness = await makeHarness();
    });

    after(async () => {
      await harness.close();
    });

    const fresh = async (label: string) => {
      work = path.join(harness.root, `${label}-${crypto.randomUUID()}`);
      await fs.mkdir(work, { recursive: true });
      return work;
    };

    const torrentFor = (dir: string, name: string) =>
      buildTorrent({ dir, name, pieceLength: 16_384 });

    afterEach(async () => {
      for (const id of added.splice(0)) {
        await harness.transport.remove(id).catch(() => undefined);
      }
      if (work !== undefined) {
        await fs.rm(work, { recursive: true, force: true });
      }
    });

    it('is available', async () => {
      assert.equal(await harness.transport.isAvailable(), true);
    });

    it('does not know a torrent it was never given', async () => {
      assert.equal(await harness.transport.status('0'.repeat(40)), undefined);
    });

    it('seeds complete files in place, without writing to them', async () => {
      const dir = path.join(await fresh('seed'), 'band');
      await writeBand(dir);
      const before = await digests(dir);
      const built = await torrentFor(dir, 'band-seed-test');

      const { id } = await harness.transport.seed({
        torrent: built.torrent,
        dir,
      });
      added.push(id);
      const status = await waitForStatus(
        harness.transport,
        id,
        (s) => s?.state === 'seeding',
      );
      assert.equal(status?.progress, 1);
      assert.deepEqual(await digests(dir), before, 'the band is untouched');
    });

    it('treats seeding the same torrent twice as one torrent', async () => {
      const dir = path.join(await fresh('twice'), 'band');
      await writeBand(dir);
      const built = await torrentFor(dir, 'band-twice-test');
      const first = await harness.transport.seed({
        torrent: built.torrent,
        dir,
      });
      added.push(first.id);
      const second = await harness.transport.seed({
        torrent: built.torrent,
        dir,
      });
      assert.equal(second.id, first.id);
    });

    it('does not claim to seed files it does not have', async () => {
      const dir = path.join(await fresh('missing'), 'band');
      await writeBand(dir);
      const built = await torrentFor(dir, 'band-missing-test');
      await fs.rm(path.join(dir, 'b.cdb'));

      const { id } = await harness.transport.seed({
        torrent: built.torrent,
        dir,
      });
      added.push(id);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = await harness.transport.status(id);
      assert(
        !(status?.state === 'seeding' && status.progress === 1),
        `must not report a complete seed: ${JSON.stringify(status)}`,
      );
    });

    it('downloads into the directory given, not a subfolder, and then seeds', async () => {
      const base = await fresh('download');
      const source = path.join(base, 'source');
      const target = path.join(base, 'target');
      await writeBand(source);
      const built = await torrentFor(source, 'band-download-test');

      const { id } = await harness.transport.add({
        torrent: built.torrent,
        downloadDir: target,
      });
      added.push(id);
      await harness.provide(id, built, source);
      const status = await waitForStatus(
        harness.transport,
        id,
        (s) => s?.state === 'seeding' && s.progress === 1,
      );
      assert.equal(status?.progress, 1);
      assert.deepEqual(await digests(target), await digests(source));
      // Counters may trail the state; they must still catch up.
      await waitForStatus(
        harness.transport,
        id,
        (s) => (s?.bytesDown ?? 0) > 0,
        5_000,
      );
    });

    it('forgets a torrent and keeps its data unless told otherwise', async () => {
      const base = await fresh('remove');
      const source = path.join(base, 'source');
      const target = path.join(base, 'target');
      await writeBand(source);
      const built = await torrentFor(source, 'band-remove-test');

      const kept = await harness.transport.seed({
        torrent: built.torrent,
        dir: source,
      });
      await waitForStatus(
        harness.transport,
        kept.id,
        (s) => s?.state === 'seeding',
      );
      await harness.transport.remove(kept.id);
      assert.equal(await harness.transport.status(kept.id), undefined);
      assert.equal(Object.keys(await digests(source)).length, 3, 'data kept');

      const other = await torrentFor(source, 'band-remove-test-2');
      const { id } = await harness.transport.add({
        torrent: other.torrent,
        downloadDir: target,
      });
      await harness.provide(id, other, source);
      await waitForStatus(harness.transport, id, (s) => s?.state === 'seeding');
      await harness.transport.remove(id, { deleteData: true });
      assert.equal(await harness.transport.status(id), undefined);
      const left = await fs.readdir(target).catch(() => [] as string[]);
      assert.deepEqual(left, [], 'downloaded data deleted');
    });

    it('treats removing an unknown torrent as done', async () => {
      await harness.transport.remove('0'.repeat(40));
    });
  });
}

// --- The in-memory fake, always ---------------------------------------------

contract('memory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-contract-'));
  const swarm = new MemorySwarm();
  const transport = new MemoryTransport(swarm);
  const peer = new MemoryTransport(swarm);
  return {
    transport,
    root,
    provide: async (_id, built, filesDir) => {
      await peer.seed({ torrent: built.torrent, dir: filesDir });
    },
    close: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
});

describe('MemoryTransport', () => {
  it('answers unavailable, and refuses work, when switched off', async () => {
    const transport = new MemoryTransport();
    transport.available = false;
    assert.equal(await transport.isAvailable(), false);
    await assert.rejects(transport.status('x'));
  });
});

// --- A real qBittorrent, when one is configured ------------------------------

const engineUrl = process.env.INDEX_SWARM_E2E_ENGINE_URL;
if (engineUrl !== undefined && engineUrl !== '') {
  contract('qbittorrent', async () => {
    const root = process.env.INDEX_SWARM_E2E_ENGINE_DIR;
    assert(root !== undefined, 'INDEX_SWARM_E2E_ENGINE_DIR is required');
    const webSeedHost =
      process.env.INDEX_SWARM_E2E_WEBSEED_HOST ?? 'host.docker.internal';
    const [username, password] = (
      process.env.INDEX_SWARM_E2E_ENGINE_AUTH ?? ''
    ).split(':');
    const transport = new QBittorrentTransport({
      url: engineUrl,
      ...(username !== undefined && username !== ''
        ? { username, password }
        : {}),
    });

    // A WebSeed for the download tests: /<torrent name>/<file>, with ranges.
    const served = new Map<string, string>();
    const server = http.createServer((req, res) => {
      void (async () => {
        const [, torrentName, file] = (req.url ?? '').split('/');
        const dir = served.get(torrentName);
        if (dir === undefined || file === undefined || file.includes('..')) {
          res.writeHead(404).end();
          return;
        }
        const body = await fs
          .readFile(path.join(dir, file))
          .catch(() => undefined);
        if (body === undefined) {
          res.writeHead(404).end();
          return;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (range !== null) {
          const start = Number(range[1]);
          const end = range[2] === '' ? body.length - 1 : Number(range[2]);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
          });
          res.end(body.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, { 'Content-Length': String(body.length) }).end(body);
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as AddressInfo).port;

    return {
      transport,
      root,
      provide: async (id, built, filesDir) => {
        served.set(built.name, filesDir);
        await transport.setWebSeeds(id, [`http://${webSeedHost}:${port}/`]);
      },
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  });

  describe('QBittorrentTransport against a dead engine', () => {
    it('answers unavailable within two seconds', async () => {
      // A port nothing listens on, on the same host as the real engine.
      const dead = new URL(engineUrl);
      dead.port = '1';
      const started = Date.now();
      const available = await new QBittorrentTransport({
        url: dead.toString(),
      }).isAvailable();
      assert.equal(available, false);
      assert(Date.now() - started < 2_500);
    });
  });
}
