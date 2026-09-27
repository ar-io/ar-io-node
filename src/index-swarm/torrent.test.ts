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

import { bdecode, bencode } from '../lib/bencode.js';
import {
  buildTorrent,
  checkTorrentFiles,
  isAllowedTrackerUrl,
  isPrivateAddress,
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

/**
 * A deep copy of a decoded torrent that keeps its Buffers: structuredClone
 * turns them into plain Uint8Arrays, which no longer read as paths or
 * strings, so every tampered copy would fail for that reason alone.
 */
const clone = <T>(value: T): T =>
  bdecode(bencode(value as never)) as unknown as T;

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

describe('checkTorrentFiles', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-files-'));
    for (const [name, size] of Object.entries(FIXTURE)) {
      await fs.writeFile(path.join(dir, name), fixtureBytes(name, size));
    }
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const band = () =>
    Object.entries(FIXTURE).map(([name, size]) => ({ name, size }));

  it('accepts a torrent of exactly the band files', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    checkTorrentFiles(built.torrent, band());
  });

  it('refuses a torrent carrying a file the band does not sign', async () => {
    await fs.writeFile(path.join(dir, 'zz-extra.bin'), Buffer.alloc(100_000));
    try {
      const built = await buildTorrent({
        dir,
        name: 'fixture',
        pieceLength: 32768,
      });
      assert.throws(
        () => checkTorrentFiles(built.torrent, band()),
        /not one of the band/,
      );
    } finally {
      await fs.rm(path.join(dir, 'zz-extra.bin'));
    }
  });

  it('refuses a torrent missing a band file', async () => {
    const [first, ...rest] = band();
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      files: rest.map((f) => f.name),
      pieceLength: 32768,
    });
    assert.throws(
      () => checkTorrentFiles(built.torrent, [first, ...rest]),
      /missing band files/,
    );
  });

  it('refuses a file whose size is not the signed one', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    const [first, ...rest] = band();
    assert.throws(
      () =>
        checkTorrentFiles(built.torrent, [
          { ...first, size: first.size + 1 },
          ...rest,
        ]),
      /signed as/,
    );
  });

  /** The fixture's hybrid torrent, decoded for tampering. */
  const decoded = async () =>
    bdecode(
      (await buildTorrent({ dir, name: 'fixture', pieceLength: 32768 }))
        .torrent,
    ) as Record<string, any>;

  it('refuses pad entries that are not pads: too long, or not under .pad/', async () => {
    const top = await decoded();
    const files = top.info.files as Array<Record<string, any>>;
    assert.ok(
      files.some((f) => f.attr?.toString() === 'p'),
      'the fixture has pads',
    );
    const long = clone(top);
    long.info.files = files.map((f) =>
      f.attr?.toString() === 'p' ? { ...f, length: 32768 } : f,
    );
    assert.throws(
      () => checkTorrentFiles(bencode(long), band()),
      /malformed pad/,
    );
    const elsewhere = clone(top);
    elsewhere.info.files = files.map((f) =>
      f.attr?.toString() === 'p'
        ? { ...f, path: [Buffer.from('x'), f.path[1]] }
        : f,
    );
    assert.throws(
      () => checkTorrentFiles(bencode(elsewhere), band()),
      /malformed pad/,
    );
  });

  it('refuses a piece length that is not a sane power of two', async () => {
    for (const bad of [0, 1000, 16383, 49152, 128 * 1024 * 1024]) {
      const top = await decoded();
      top.info['piece length'] = bad;
      assert.throws(
        () => checkTorrentFiles(bencode(top), band()),
        /piece length/,
        String(bad),
      );
    }
  });

  it('refuses a file list padded out far beyond the band', async () => {
    const top = await decoded();
    const pad = {
      attr: Buffer.from('p'),
      length: 1,
      path: [Buffer.from('.pad'), Buffer.from('1')],
    };
    top.info.files = [...top.info.files, ...Array(20).fill(pad)];
    assert.throws(
      () => checkTorrentFiles(bencode(top), band()),
      /more file entries/,
    );
  });

  it('refuses a v2 file tree that disagrees with the v1 file list', async () => {
    const top = await decoded();
    assert.ok(top.info['file tree'] !== undefined, 'hybrid');
    const wrongLength = clone(top);
    wrongLength.info['file tree']['a.bin'][''].length = 2;
    assert.throws(
      () => checkTorrentFiles(bencode(wrongLength), band()),
      /file tree entry a\.bin/,
    );
    const extra = clone(top);
    extra.info['file tree']['zz.bin'] = { '': { length: 1 } };
    assert.throws(
      () => checkTorrentFiles(bencode(extra), band()),
      /file tree does not match/,
    );
    const missing = clone(top);
    delete missing.info['file tree']['a.bin'];
    assert.throws(
      () => checkTorrentFiles(bencode(missing), band()),
      /file tree does not match/,
    );
  });

  it('refuses symlink and nested entries', async () => {
    const built = await buildTorrent({
      dir,
      name: 'fixture',
      pieceLength: 32768,
    });
    const top = bdecode(built.torrent) as Record<string, any>;
    const files = top.info.files as Array<Record<string, any>>;
    const link = clone(top);
    link.info.files = [
      ...files,
      {
        attr: Buffer.from('l'),
        length: 0,
        path: [Buffer.from('x')],
        'symlink path': [Buffer.from('..')],
      },
    ];
    assert.throws(
      () => checkTorrentFiles(bencode(link), band()),
      /unexpected keys|refused/,
    );
    // A real band file with a link target added: its name and size are
    // right, so only the check on unexpected keys can refuse it.
    const disguised = clone(top);
    disguised.info.files = files.map((f) =>
      f.path[0].toString() === 'a.bin'
        ? { ...f, 'symlink path': [Buffer.from('..')] }
        : f,
    );
    assert.throws(
      () => checkTorrentFiles(bencode(disguised), band()),
      /unexpected keys/,
    );
    const nested = clone(top);
    nested.info.files = files.map((f) =>
      f.attr === undefined
        ? { ...f, path: [Buffer.from('sub'), ...f.path] }
        : f,
    );
    assert.throws(
      () => checkTorrentFiles(bencode(nested), band()),
      /not one of the band/,
    );
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

  it('draws the private ranges at their exact edges', () => {
    for (const ip of [
      '10.0.0.0',
      '10.255.255.255',
      '100.64.0.0',
      '100.127.255.255',
      '127.0.0.1',
      '169.254.0.1',
      '172.16.0.0',
      '172.31.255.255',
      '192.168.0.1',
      '224.0.0.0',
      '255.255.255.255',
      '0.0.0.0',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of [
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '169.253.255.255',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '223.255.255.255',
      '2001:db8::1',
      'fec0::1',
    ]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
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
      'http://tracker.example.com:80\\@192.168.2.1:4000/announce',
      'http://user@tracker.example/announce',
      'http://tracker.example/announce#x',
      'http://[::ffff:0:a00:1]/',
      'http://[64:ff9b::a00:1]/',
      'file:///etc/passwd',
      'wss://tracker.example/',
    ]) {
      assert.equal(isAllowedTrackerUrl(bad), false, bad);
    }
  });
});
