/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { buildTorrent, torrentIds } from '../index-swarm/torrent.js';
import { bdecode } from '../lib/bencode.js';
import { PUBLISHED_TORRENT_DIR } from '../lib/index-publication.js';
import { PublishedTorrents } from './published-torrents.js';

const log = createTestLogger({ suite: 'published torrents' });
const ORIGIN = 'https://gateway.example';

describe('PublishedTorrents', () => {
  let tempDir: string;
  let publishedDir: string;
  let infohashV1: string;
  let stored: Buffer;

  const write = async (ih: string, bytes: Buffer | string) =>
    fs.writeFile(
      path.join(publishedDir, PUBLISHED_TORRENT_DIR, `${ih}.torrent`),
      bytes,
    );

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'published-torrents-'));
    publishedDir = path.join(tempDir, 'published');
    const band = path.join(tempDir, 'band');
    await fs.mkdir(band, { recursive: true });
    await fs.mkdir(path.join(publishedDir, PUBLISHED_TORRENT_DIR), {
      recursive: true,
    });
    await fs.writeFile(path.join(band, 'a.bin'), Buffer.alloc(20_000, 7));
    const built = await buildTorrent({
      dir: band,
      name: 'fedcba9876543210',
      pieceLength: 16 * 1024,
    });
    infohashV1 = built.infohashV1;
    stored = built.torrent;
    await write(infohashV1, stored);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves each torrent with the gateway’s WebSeed, under the same infohashes', async () => {
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: ORIGIN,
    });
    const served = (await torrents.torrent(infohashV1))!;
    assert.deepEqual(
      (bdecode(served.body) as any)['url-list'].map((u: Buffer) =>
        u.toString(),
      ),
      [`${ORIGIN}/ar-io/indexes/webseed/`],
    );
    assert.deepEqual(torrentIds(served.body), torrentIds(stored));
    assert.equal(
      served.sha256,
      crypto.createHash('sha256').update(served.body).digest('hex'),
    );
  });

  it('serves the stored bytes unchanged without a public origin', async () => {
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: undefined,
    });
    assert.deepEqual((await torrents.torrent(infohashV1))!.body, stored);
  });

  it('has nothing for a torrent not built, or for a name that is not an infohash', async () => {
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: ORIGIN,
    });
    assert.equal(await torrents.torrent('c'.repeat(40)), undefined);
    for (const name of ['../publication', 'C'.repeat(40), '']) {
      assert.equal(await torrents.torrent(name), undefined, name);
    }
  });

  it('remembers a served torrent until its file changes', async () => {
    const ih = 'd'.repeat(40);
    await write(ih, stored);
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: ORIGIN,
    });
    const first = await torrents.torrent(ih);
    assert.equal(await torrents.torrent(ih), first, 'the same object');

    // The publisher rewrites it, say with a new tracker list.
    const rebuilt = await buildTorrent({
      dir: path.join(tempDir, 'band'),
      name: 'fedcba9876543210',
      pieceLength: 16 * 1024,
      trackers: ['https://gateway.example/ar-io/indexes/announce'],
    });
    await write(ih, rebuilt.torrent);
    const next = (await torrents.torrent(ih))!;
    assert.notEqual(next.sha256, first!.sha256);
    assert.equal(
      (bdecode(next.body) as any).announce.toString(),
      'https://gateway.example/ar-io/indexes/announce',
    );
  });

  it('serves nothing for a stored file that does not parse', async () => {
    const ih = 'e'.repeat(40);
    await write(ih, 'not a torrent');
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: ORIGIN,
    });
    assert.equal(await torrents.torrent(ih), undefined);
    assert.equal(await torrents.torrent(ih), undefined);
  });

  it('keeps only the most recently served', async () => {
    const torrents = new PublishedTorrents({
      log,
      publishedDir,
      publicOrigin: ORIGIN,
      maxEntries: 1,
    });
    const ih = 'f'.repeat(40);
    await write(ih, stored);
    const a = await torrents.torrent(infohashV1);
    await torrents.torrent(ih);
    // Evicted, so made again: equal bytes, a new object.
    const again = await torrents.torrent(infohashV1);
    assert.notEqual(again, a);
    assert.deepEqual(again!.body, a!.body);
  });
});
