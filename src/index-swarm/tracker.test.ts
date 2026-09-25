/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';

import { bdecode } from '../lib/bencode.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  ClosedTracker,
  parseAnnounceQuery,
  trackedInfohashes,
} from './tracker.js';

const log = createTestLogger({ suite: 'ClosedTracker' });

const OURS = Buffer.from('0123456789abcdef0123', 'latin1');
const THEIRS = Buffer.alloc(20, 0xee);

/** Percent-encode every byte, as clients do for info_hash. */
const pct = (bytes: Buffer) =>
  [...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');

const query = (
  infoHash: Buffer,
  port: number,
  extra: Record<string, string> = {},
) =>
  [
    `info_hash=${pct(infoHash)}`,
    `peer_id=${pct(Buffer.alloc(20, port % 256))}`,
    `port=${port}`,
    'uploaded=0',
    'downloaded=0',
    `left=${extra.left ?? '100'}`,
    'compact=1',
    ...Object.entries(extra)
      .filter(([k]) => k !== 'left')
      .map(([k, v]) => `${k}=${v}`),
  ].join('&');

const decode = (body: Buffer) => bdecode(body) as Record<string, any>;

const peersOf = (response: Record<string, any>) => {
  const compact = response.peers as Buffer;
  const out: string[] = [];
  for (let i = 0; i < compact.length; i += 6) {
    out.push(
      `${[...compact.subarray(i, i + 4)].join('.')}:${compact.readUInt16BE(i + 4)}`,
    );
  }
  return out;
};

const tracker = (
  opts: Partial<ConstructorParameters<typeof ClosedTracker>[0]> = {},
) =>
  new ClosedTracker({
    log,
    allowed: () => new Set([OURS.toString('hex')]),
    ...opts,
  });

describe('ClosedTracker', () => {
  it('keeps only a few ports per address in one torrent', () => {
    const t = tracker({ maxPortsPerIp: 2, maxAnnouncesPerMinute: 1000 });
    for (const port of [1001, 1002, 1003, 1004]) {
      t.announce(query(OURS, port), '203.0.113.7');
    }
    const response = decode(t.announce(query(OURS, 2000), '198.51.100.1'));
    assert.deepEqual(peersOf(response).sort(), [
      '203.0.113.7:1003',
      '203.0.113.7:1004',
    ]);
  });

  it('caps the peers kept per torrent, dropping the least recently seen', () => {
    const t = tracker({
      maxPeersPerSwarm: 3,
      maxPeers: 50,
      maxAnnouncesPerMinute: 1000,
    });
    for (const n of [1, 2, 3, 4]) {
      t.announce(query(OURS, 1000 + n), `203.0.113.${n}`);
    }
    const peers = peersOf(decode(t.announce(query(OURS, 2000), '203.0.113.9')));
    assert.equal(peers.length, 2, 'three kept, the asker included');
    assert.ok(!peers.includes('203.0.113.1:1001'), 'the oldest went first');
  });

  it('refuses an address announcing too often', () => {
    const t = tracker({ maxAnnouncesPerMinute: 3 });
    for (let i = 0; i < 3; i++)
      t.announce(query(OURS, 1000 + i), '203.0.113.5');
    const response = decode(t.announce(query(OURS, 1100), '203.0.113.5'));
    assert.equal(response['failure reason'].toString(), 'slow down');
    // Others are unaffected.
    assert.equal(
      decode(t.announce(query(OURS, 1200), '203.0.113.6'))['failure reason'],
      undefined,
    );
  });

  it('refuses a torrent this node does not publish', () => {
    const response = decode(
      tracker().announce(query(THEIRS, 1111), '10.0.0.1'),
    );
    assert.equal(response['failure reason'].toString(), 'unregistered torrent');
  });

  it('introduces peers of a band it tracks, and counts seeders', () => {
    const t = tracker();
    const first = decode(
      t.announce(query(OURS, 1111, { left: '0' }), '10.0.0.1'),
    );
    assert.deepEqual(peersOf(first), [], 'nobody else yet');

    const second = decode(t.announce(query(OURS, 2222), '10.0.0.2'));
    assert.deepEqual(peersOf(second), ['10.0.0.1:1111']);
    assert.equal(second.complete, 1);
    assert.equal(second.incomplete, 1);
    assert(second.interval > 0);
  });

  it('reads the IPv4-mapped address Node reports as IPv4', () => {
    const t = tracker();
    t.announce(query(OURS, 1111), '::ffff:10.0.0.1');
    const response = decode(t.announce(query(OURS, 2222), '10.0.0.2'));
    assert.deepEqual(peersOf(response), ['10.0.0.1:1111']);
  });

  it('forgets a peer that stopped', () => {
    const t = tracker();
    t.announce(query(OURS, 1111), '10.0.0.1');
    t.announce(query(OURS, 1111, { event: 'stopped' }), '10.0.0.1');
    assert.deepEqual(
      peersOf(decode(t.announce(query(OURS, 2222), '10.0.0.2'))),
      [],
    );
  });

  it('forgets a peer that missed two announces', () => {
    let now = 0;
    const t = tracker({ intervalSeconds: 60, now: () => now });
    t.announce(query(OURS, 1111), '10.0.0.1');
    now += (60 * 2 + 61) * 1000;
    assert.deepEqual(
      peersOf(decode(t.announce(query(OURS, 2222), '10.0.0.2'))),
      [],
    );
  });

  it('stops tracking a band once it is no longer offered', () => {
    let offered = new Set([OURS.toString('hex')]);
    const t = tracker({ allowed: () => offered });
    t.announce(query(OURS, 1111), '10.0.0.1');
    offered = new Set();
    const response = decode(t.announce(query(OURS, 2222), '10.0.0.2'));
    assert.equal(response['failure reason'].toString(), 'unregistered torrent');
  });

  it('returns IPv6 peers in peers6', () => {
    const t = tracker();
    t.announce(query(OURS, 1111), '2001:db8::1');
    const response = decode(t.announce(query(OURS, 2222), '10.0.0.2'));
    const six = response.peers6 as Buffer;
    assert.equal(six.length, 18);
    assert.equal(six.subarray(0, 2).toString('hex'), '2001');
    assert.equal(six.subarray(15, 16).toString('hex'), '01');
    assert.equal(six.readUInt16BE(16), 1111);
  });

  it('rejects a malformed announce', () => {
    const short = decode(
      tracker().announce('info_hash=%01%02&port=1', '10.0.0.1'),
    );
    assert.equal(short['failure reason'].toString(), 'invalid info_hash');
    const noPort = decode(
      tracker().announce(`info_hash=${pct(OURS)}`, '10.0.0.1'),
    );
    assert.equal(noPort['failure reason'].toString(), 'invalid port');
  });

  it('serves /announce over HTTP and nothing else', async () => {
    const server = await tracker().listen('127.0.0.1', 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/scrape`)).status, 404);
      const ok = await fetch(`${base}/announce?${query(OURS, 1111)}`);
      assert.equal(ok.status, 200);
      assert.equal(
        decode(Buffer.from(await ok.arrayBuffer()))['failure reason'],
        undefined,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('parseAnnounceQuery', () => {
  it('keeps raw bytes intact, which a URL parser would not', () => {
    const bytes = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x25, 0x26, 0x3d]);
    const parsed = parseAnnounceQuery(`info_hash=${pct(bytes)}&port=1`);
    assert.deepEqual(parsed.get('info_hash'), bytes);
    // What URLSearchParams would have produced instead.
    assert.notDeepEqual(
      Buffer.from(new URLSearchParams(`x=${pct(bytes)}`).get('x')!, 'latin1'),
      bytes,
    );
  });

  it('takes unencoded characters as themselves', () => {
    assert.equal(
      parseAnnounceQuery('info_hash=abc').get('info_hash')?.toString(),
      'abc',
    );
  });
});

describe('trackedInfohashes', () => {
  it('tracks a hybrid torrent under both of the hashes it is announced under', () => {
    const v1 = 'a'.repeat(40);
    const v2 = 'b'.repeat(64);
    assert.deepEqual(
      [
        ...trackedInfohashes([
          { torrent: { infohashV1: v1, infohashV2: v2 } },
          {},
        ]),
      ].sort(),
      [v1, 'b'.repeat(40)],
    );
  });
});
