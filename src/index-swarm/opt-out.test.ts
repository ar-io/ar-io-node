/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { stopSubscriberTorrents } from './opt-out.js';
import { seedingKey, StateStore } from './state.js';
import { buildTorrent } from './torrent.js';
import { MemorySwarm, MemoryTransport } from './transport/memory.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'index-swarm opt-out' });

/** A memory engine that records every remove, to show none touched files. */
class RecordingTransport extends MemoryTransport {
  readonly removed: string[] = [];
  override async remove(id: string): Promise<void> {
    this.removed.push(id);
    await super.remove(id);
  }
}

describe('stopSubscriberTorrents', () => {
  let tempDir: string;
  let statePath: string;
  let state: StateStore;
  let installed: string;
  let published: string;
  let swarmDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-swarm-opt-out-'));
    statePath = path.join(tempDir, 'state.json');
    state = new StateStore({ log, filePath: statePath });
    installed = path.join(tempDir, 'installed');
    published = path.join(tempDir, 'published');
    swarmDir = path.join(tempDir, 'swarm');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** A torrent of one small file written to `dir`. */
  const torrentIn = async (dir: string, content: string) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.bin'), content);
    return (await buildTorrent({ dir, name: content })).torrent;
  };

  /**
   * A node that installed band-a as a subscriber (seeded from installed/),
   * publishes band-p (seeded from published/), and is downloading band-d
   * into swarm/.
   */
  const setUp = async (transport: MemoryTransport) => {
    const installedDir = path.join(installed, 'root-tx-index', 'band-a', 'g1');
    const sub = await transport.seed({
      torrent: await torrentIn(installedDir, 'installed'),
      dir: installedDir,
    });
    const publishedDir = path.join(published, '.seed', 'p');
    const pub = await transport.seed({
      torrent: await torrentIn(publishedDir, 'published'),
      dir: publishedDir,
    });
    const downloadTorrent = await buildTorrent({
      dir: await (async () => {
        const src = path.join(tempDir, 'elsewhere');
        await torrentIn(src, 'downloading');
        return src;
      })(),
      name: 'downloading',
    });
    const infohashD = downloadTorrent.infohashV1;
    const dl = await transport.add({
      torrent: downloadTorrent.torrent,
      downloadDir: path.join(swarmDir, infohashD),
    });
    await state.update((draft) => {
      draft.installed['root-tx-index'] = {
        'band-a': {
          dir: installedDir,
          files: [],
          installedAt: new Date(0).toISOString(),
          publisher: 'pub',
          infohashV1: 'aa'.repeat(20),
        },
      };
      draft.seeding[seedingKey('subscriber', sub.id)] = {
        id: sub.id,
        infohashV1: 'aa'.repeat(20),
        index: 'root-tx-index',
        band: 'band-a',
        dir: installedDir,
        owner: 'subscriber',
      };
      draft.seeding[seedingKey('publisher', pub.id)] = {
        id: pub.id,
        index: 'root-tx-index',
        band: 'band-p',
        dir: publishedDir,
        owner: 'publisher',
      };
      draft.downloads[infohashD] = {
        id: dl.id,
        publisher: 'pub',
        index: 'root-tx-index',
        band: 'band-d',
        startedAt: 0,
        lastProgress: 0,
        lastProgressAt: 0,
        webSeeded: false,
        lastSeenAt: 0,
      };
    });
    return { sub: sub.id, pub: pub.id, dl: dl.id, installedDir };
  };

  it('removes only the subscriber torrents, keeping their files and the install records', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    const { sub, pub, dl, installedDir } = await setUp(transport);

    const result = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });

    assert.deepEqual(result, { engineAvailable: true, removed: 2, failed: 0 });
    assert.deepEqual(transport.removed.sort(), [sub, dl].sort());
    assert.equal(transport.entry(sub), undefined, 'installed band unseeded');
    assert.equal(transport.entry(dl), undefined, 'download stopped');
    assert.equal(transport.entry(pub)?.state, 'seeding', 'publisher keeps its');
    assert.equal(
      await fs.readFile(path.join(installedDir, 'a.bin'), 'utf8'),
      'installed',
      'the installed band file is kept',
    );

    // Persisted: a later start, and the janitor, read the same.
    const reloaded = await new StateStore({ log, filePath: statePath }).load();
    assert.deepEqual(
      Object.values(reloaded.seeding).map((s) => s.owner),
      ['publisher'],
    );
    assert.deepEqual(reloaded.downloads, {});
    assert.equal(
      reloaded.installed['root-tx-index']['band-a'].infohashV1,
      'aa'.repeat(20),
      'kept so re-subscribing seeds it again',
    );
  });

  it('is idempotent: a second start removes nothing', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    const { pub } = await setUp(transport);
    await stopSubscriberTorrents({ log, state, transport, swarmDir });
    transport.removed.length = 0;

    const again = await stopSubscriberTorrents({
      log,
      state: new StateStore({ log, filePath: statePath }),
      transport,
      swarmDir,
    });

    assert.deepEqual(again, { engineAvailable: true, removed: 0, failed: 0 });
    assert.deepEqual(transport.removed, []);
    assert.equal(transport.entry(pub)?.state, 'seeding');
  });

  it('leaves a torrent the engine runs from the publisher copy, dropping only the subscriber record', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    // Same bytes published and installed: the engine's one copy runs from
    // published/, and the subscriber's record names the same id.
    const publishedDir = path.join(published, '.seed', 'p');
    const torrent = await torrentIn(publishedDir, 'shared');
    const { id } = await transport.seed({ torrent, dir: publishedDir });
    const installedDir = path.join(installed, 'root-tx-index', 'band-a', 'g1');
    await torrentIn(installedDir, 'shared');
    await state.update((draft) => {
      draft.seeding[seedingKey('publisher', id)] = {
        id,
        index: 'root-tx-index',
        band: 'band-a',
        dir: publishedDir,
        owner: 'publisher',
      };
      draft.seeding[seedingKey('subscriber', id)] = {
        id,
        index: 'root-tx-index',
        band: 'band-a',
        dir: installedDir,
        owner: 'subscriber',
      };
    });

    const result = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });

    assert.equal(result.removed, 0);
    assert.deepEqual(transport.removed, []);
    assert.equal(transport.entry(id)?.state, 'seeding');
    assert.deepEqual(Object.keys((await state.load()).seeding), [
      seedingKey('publisher', id),
    ]);
  });

  it('changes nothing while the engine is down, and finishes once it answers', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    const { sub } = await setUp(transport);
    transport.available = false;

    const down = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });
    assert.deepEqual(down, { engineAvailable: false, removed: 0, failed: 0 });
    assert.equal(
      Object.values((await state.load()).seeding).length,
      2,
      'records kept for the retry',
    );

    transport.available = true;
    const up = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });
    assert.equal(up.removed, 2);
    assert.equal(transport.entry(sub), undefined);
  });

  it('counts a failure and keeps its record when the engine fails mid-pass', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    const { sub } = await setUp(transport);
    // Answers the availability check, then fails every call.
    transport.isAvailable = async () => true;
    transport.available = false;

    const result = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });

    assert.deepEqual(result, { engineAvailable: true, removed: 0, failed: 2 });
    assert(
      (await state.load()).seeding[seedingKey('subscriber', sub)] !== undefined,
    );
  });

  it('drops records of torrents the engine no longer holds', async () => {
    const transport = new RecordingTransport(new MemorySwarm());
    const { sub, dl } = await setUp(transport);
    await transport.remove(sub);
    await transport.remove(dl);
    transport.removed.length = 0;

    const result = await stopSubscriberTorrents({
      log,
      state,
      transport,
      swarmDir,
    });

    assert.deepEqual(result, { engineAvailable: true, removed: 0, failed: 0 });
    const current = await state.load();
    assert.deepEqual(
      Object.values(current.seeding).map((s) => s.owner),
      ['publisher'],
    );
    assert.deepEqual(current.downloads, {});
  });
});
