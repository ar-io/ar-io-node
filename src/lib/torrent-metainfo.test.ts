/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildTorrent,
  sanitizeTorrent,
  torrentIds,
} from '../index-swarm/torrent.js';
import { bdecode, bdecodeWithSpans, bencode } from './bencode.js';
import { infohashV1Of, withWebSeeds } from './torrent-metainfo.js';

const SEED = 'https://gateway.example/ar-io/indexes/webseed/';

describe('withWebSeeds', () => {
  let dir: string;
  let torrent: Buffer;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-metainfo-'));
    // Two files, the first not a whole number of pieces, so the info
    // dictionary carries a pad file and the torrent a v2 piece layer.
    await fs.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(40_000, 1));
    await fs.writeFile(path.join(dir, 'b.bin'), Buffer.alloc(70_000, 2));
    torrent = (
      await buildTorrent({
        dir,
        name: '0123456789abcdef',
        pieceLength: 16 * 1024,
        trackers: [
          'https://gateway.example/ar-io/indexes/announce',
          'udp://tracker.example:6969/announce',
        ],
      })
    ).torrent;
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const infoBytes = (t: Buffer) => {
    const span = bdecodeWithSpans(t).spans.get('info')!;
    return t.subarray(span[0], span[1]);
  };

  it('names the WebSeed and leaves the torrent otherwise as it was', () => {
    const served = withWebSeeds(torrent, [SEED]);
    const decoded = bdecode(served) as any;
    assert.deepEqual(
      decoded['url-list'].map((u: Buffer) => u.toString()),
      [SEED],
    );
    // The same torrent: identical info bytes, so identical infohashes.
    assert.deepEqual(infoBytes(served), infoBytes(torrent));
    assert.deepEqual(torrentIds(served), torrentIds(torrent));
    const original = bdecode(torrent) as any;
    assert.deepEqual(decoded['announce'], original['announce']);
    assert.deepEqual(decoded['announce-list'], original['announce-list']);
    assert.deepEqual(decoded['piece layers'], original['piece layers']);
  });

  it('writes keys in BEP 3 order, so a strict decoder takes it', () => {
    // bdecode refuses unsorted or duplicate keys.
    const served = withWebSeeds(torrent, [SEED]);
    assert.deepEqual(Object.keys(bdecode(served) as object), [
      'announce',
      'announce-list',
      'info',
      'piece layers',
      'url-list',
    ]);
  });

  it('replaces the WebSeeds a torrent already names, and removes them for none', async () => {
    const seeded = (
      await buildTorrent({
        dir,
        name: '0123456789abcdef',
        pieceLength: 16 * 1024,
        webSeeds: ['https://elsewhere.example/'],
      })
    ).torrent;
    const replaced = bdecode(withWebSeeds(seeded, [SEED, `${SEED}x/`])) as any;
    assert.deepEqual(
      replaced['url-list'].map((u: Buffer) => u.toString()),
      [SEED, `${SEED}x/`],
    );
    const none = withWebSeeds(seeded, []);
    assert.equal((bdecode(none) as any)['url-list'], undefined);
    assert.deepEqual(torrentIds(none), torrentIds(seeded));
    // Nothing to remove: the bytes come back unchanged.
    assert.deepEqual(withWebSeeds(torrent, []), torrent);
  });

  it('keeps keys it does not know, wherever they sort', () => {
    const decoded = bdecode(torrent) as any;
    const extended = bencode({
      ...decoded,
      comment: 'kept',
      'zz-extension': [1, 2],
    });
    const served = bdecode(withWebSeeds(extended, [SEED])) as any;
    assert.equal(served.comment.toString(), 'kept');
    assert.deepEqual(served['zz-extension'], [1, 2]);
    assert.deepEqual(torrentIds(bencode(served)), torrentIds(torrent));
  });

  it('refuses what is not a torrent', () => {
    for (const [label, input] of [
      ['not bencode', Buffer.from('not a torrent')],
      ['a list', bencode([1, 2])],
      ['no info', bencode({ announce: 'x' })],
      ['info not a dictionary', bencode({ info: 'x' })],
      ['unsorted keys', Buffer.from('d4:infod1:ai1ee1:a1:xe')],
    ] as const) {
      assert.throws(() => withWebSeeds(input, [SEED]), Error, label);
    }
  });

  it('is undone by a subscriber, which takes no WebSeed from a torrent', () => {
    // What a gateway subscriber does with every torrent it fetches: the
    // WebSeed a publisher's gateway adds never reaches the subscriber's
    // engine, which turns on the publisher's own only when peers stall.
    const served = withWebSeeds(torrent, [SEED]);
    const sanitized = sanitizeTorrent(served, torrentIds(torrent));
    assert.equal((bdecode(sanitized) as any)['url-list'], undefined);
    assert.deepEqual(torrentIds(sanitized), torrentIds(torrent));
  });
});

describe('infohashV1Of', () => {
  it('is the SHA-1 of the info dictionary as written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infohash-of-'));
    try {
      await fs.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(30_000, 3));
      const built = await buildTorrent({ dir, name: 'abcdefabcdefabcd' });
      assert.equal(infohashV1Of(built.torrent), built.infohashV1);
      assert.equal(
        infohashV1Of(withWebSeeds(built.torrent, [SEED])),
        built.infohashV1,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses what is not a torrent', () => {
    assert.throws(() => infohashV1Of(Buffer.from('nope')), Error);
    assert.throws(() => infohashV1Of(bencode({ announce: 'x' })), Error);
    // An info that is not a dictionary is no torrent, whatever it hashes to.
    for (const info of ['a string', [1, 2], 7]) {
      assert.throws(
        () => infohashV1Of(bencode({ info } as any)),
        Error,
        JSON.stringify(info),
      );
    }
  });
});
