/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { bdecode } from '../lib/bencode.js';
import {
  buildTorrent,
  isAllowedTrackerUrl,
  sanitizeTorrent,
  torrentIds,
} from './torrent.js';

/**
 * Sizes on every boundary that matters at a 32 KiB piece: under a block,
 * exactly a block, exactly a piece, a piece and a byte, several pieces ending
 * mid-block, and an exact power of two.
 */
const FIXTURE: Record<string, number> = {
  'a.bin': 1,
  'b.bin': 16384,
  'c.bin': 32768,
  'd.bin': 32769,
  'e.bin': 100000,
  'f.bin': 131072,
};

/** Reproducible bytes, the same generator the goldens were built from. */
const fixtureBytes = (name: string, size: number): Buffer => {
  const out = Buffer.alloc(size);
  for (let i = 0; i * 32 < size; i++) {
    crypto
      .createHash('sha256')
      .update(`${name}:${i}`)
      .digest()
      .copy(out, i * 32);
  }
  return out;
};

/**
 * Infohashes libtorrent 2.0.13 (qBittorrent-nox 5.2.3's torrent creator)
 * produced for this fixture, directory named "fixture". They are the
 * reference, not a record of this builder's output: matching them is what
 * makes a band built here join the same swarm as one built by libtorrent.
 */
const LIBTORRENT = {
  hybrid32k: {
    infohashV1: 'a56bfa2b216a200f068e8b2eee06f4d544c6264d',
    infohashV2:
      '957642eb4b9046c3e342c500c957bc39cb76dce5574ad7fd27b2279f12178930',
  },
  v132k: { infohashV1: '634d1346e74daea14c0a99631fb4af5687a75982' },
  hybrid16k: {
    infohashV1: '32da521f851a555edc043b938baeaf07b58a1c2e',
    infohashV2:
      '9e5c0d48fd77f26a633562874599531ecc71fe0e8f565b0ea1f28d70db816ba1',
  },
};

describe('buildTorrent', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-test-'));
    for (const [name, size] of Object.entries(FIXTURE)) {
      await fs.writeFile(path.join(dir, name), fixtureBytes(name, size));
    }
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ids = (t: { infohashV1: string; infohashV2?: string }) => ({
    infohashV1: t.infohashV1,
    ...(t.infohashV2 !== undefined ? { infohashV2: t.infohashV2 } : {}),
  });

  it('matches libtorrent for a hybrid torrent', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    assert.deepEqual(ids(built), LIBTORRENT.hybrid32k);
  });

  it('matches libtorrent for a v1 torrent', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      format: 'v1',
    });
    assert.deepEqual(ids(built), LIBTORRENT.v132k);
  });

  it('matches libtorrent when a piece is a single block', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 16384,
    });
    assert.deepEqual(ids(built), LIBTORRENT.hybrid16k);
  });

  it('keeps trackers and WebSeeds out of the infohash', async () => {
    const plain = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    const decorated = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      webSeeds: ['https://gw.example/ar-io/indexes/idx/'],
      trackers: ['http://t1.example/announce', 'http://t2.example/announce'],
    });
    assert.deepEqual(ids(decorated), ids(plain));
    const top = bdecode(decorated.torrent) as Record<string, unknown>;
    assert.equal(
      (top.announce as Buffer).toString(),
      'http://t1.example/announce',
    );
    assert.equal((top['announce-list'] as unknown[]).length, 2);
    assert.equal(
      (top['url-list'] as Buffer[])[0].toString(),
      'https://gw.example/ar-io/indexes/idx/',
    );
  });

  it('puts the name in the infohash', async () => {
    const a = await buildTorrent({ dir, name: 'band-a', pieceLength: 32768 });
    const b = await buildTorrent({ dir, name: 'band-b', pieceLength: 32768 });
    assert.notEqual(a.infohashV1, b.infohashV1);
  });

  it('depends on the files, not the order they are listed in', async () => {
    const listed = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      files: ['f.bin', 'a.bin', 'd.bin', 'c.bin', 'e.bin', 'b.bin'],
    });
    assert.deepEqual(ids(listed), LIBTORRENT.hybrid32k);
  });

  it('sets the private flag inside the info dictionary, changing the infohash', async () => {
    const open = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    const priv = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      private: true,
    });
    assert.notEqual(priv.infohashV1, open.infohashV1);
    assert.equal(((bdecode(priv.torrent) as any).info as any).private, 1);
  });

  it('refuses a piece length BEP 52 does not allow', async () => {
    await assert.rejects(
      buildTorrent({ dir, name: 'x', pieceLength: 3 * 16384 }),
    );
    await assert.rejects(buildTorrent({ dir, name: 'x', pieceLength: 8192 }));
  });

  it('reads the infohashes of a torrent built elsewhere from its own bytes', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    assert.deepEqual(torrentIds(built.torrent), LIBTORRENT.hybrid32k);
  });
});

describe('sanitizeTorrent', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-sanitize-'));
    for (const [name, size] of Object.entries(FIXTURE)) {
      await fs.writeFile(path.join(dir, name), fixtureBytes(name, size));
    }
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the info dictionary and public trackers, drops WebSeeds and inner-network trackers', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      // What a hostile publisher could put outside the signed info dict.
      webSeeds: ['http://observer:5050/'],
      trackers: [
        'http://core:4000/announce',
        'http://10.0.0.5/announce',
        'udp://tracker.example:6969/announce',
        'http://[::1]:6969/announce',
        'https://169.254.169.254/latest',
      ],
    });
    const clean = sanitizeTorrent(built.torrent, built);
    const top = bdecode(clean) as Record<string, unknown>;

    assert.deepEqual(torrentIds(clean), torrentIds(built.torrent));
    assert.equal(top['url-list'], undefined, 'WebSeeds dropped');
    assert.ok('piece layers' in top, 'v2 piece layers kept');
    assert.equal(top.announce, undefined, 'a private first tracker is dropped');
    assert.deepEqual(
      (top['announce-list'] as Buffer[][]).map((tier) =>
        tier.map((u) => u.toString()),
      ),
      [['udp://tracker.example:6969/announce']],
    );
  });

  it('keeps a private tracker the operator allowed', async () => {
    const lan = 'http://192.168.2.235:6969/announce';
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
      trackers: [lan, 'http://192.168.2.9:6969/announce'],
    });
    const top = bdecode(
      sanitizeTorrent(built.torrent, built, new Set([lan])),
    ) as Record<string, unknown>;
    assert.equal((top.announce as Buffer).toString(), lan);
    assert.deepEqual(
      (top['announce-list'] as Buffer[][]).map((t) =>
        t.map((u) => u.toString()),
      ),
      [[lan]],
    );
  });

  it('refuses a torrent that is not the expected one', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    assert.throws(
      () =>
        sanitizeTorrent(built.torrent, {
          infohashV1: '0'.repeat(40),
        }),
      /changed the infohash/,
    );
  });

  it('classifies tracker hosts', () => {
    for (const ok of [
      'http://tracker.example/announce',
      'https://1.2.3.4/announce',
      'udp://open.example:1337',
    ]) {
      assert.equal(isAllowedTrackerUrl(ok), true, ok);
    }
    for (const bad of [
      'http://core:4000/announce',
      'http://localhost/announce',
      'http://127.0.0.1/announce',
      'http://192.168.2.1/',
      'http://172.20.0.3/',
      'http://100.64.1.1/',
      'http://[fd00::1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://metadata.google.internal/',
      'file:///etc/passwd',
      'wss://tracker.example/',
    ]) {
      assert.equal(isAllowedTrackerUrl(bad), false, bad);
    }
  });
});
