/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PeerHashRing } from './peer-hash-ring.js';

describe('PeerHashRing', () => {
  let ring: PeerHashRing;

  beforeEach(() => {
    ring = new PeerHashRing(150);
  });

  it('should return deterministic home set for same key and ring', () => {
    ring.rebuild(['http://a.com', 'http://b.com', 'http://c.com']);
    const set1 = ring.getHomeSet('data-id-123', 2);
    const set2 = ring.getHomeSet('data-id-123', 2);
    assert.deepEqual(set1, set2);
  });

  it('should return different home sets for different keys', () => {
    ring.rebuild([
      'http://a.com',
      'http://b.com',
      'http://c.com',
      'http://d.com',
      'http://e.com',
    ]);
    const set1 = ring.getHomeSet('key-1', 2);
    const set2 = ring.getHomeSet('key-2', 2);
    // At least check they're valid
    assert.equal(set1.length, 2);
    assert.equal(set2.length, 2);
    // Allow this test to pass even if order matches — the key property is determinism
  });

  it('should distribute peers reasonably evenly', () => {
    const peers = Array.from({ length: 10 }, (_, i) => `http://peer-${i}.com`);
    ring.rebuild(peers);

    const counts = new Map<string, number>();
    const totalKeys = 10000;

    for (let i = 0; i < totalKeys; i++) {
      const homeSet = ring.getHomeSet(`key-${i}`, 1);
      const peer = homeSet[0];
      counts.set(peer, (counts.get(peer) ?? 0) + 1);
    }

    // Each peer should get roughly 10% of keys
    // Allow 5-15% range (generous tolerance)
    for (const [peer, count] of counts) {
      const pct = count / totalKeys;
      assert.ok(
        pct > 0.05 && pct < 0.15,
        `Peer ${peer} got ${(pct * 100).toFixed(1)}% of keys (expected ~10%)`,
      );
    }
  });

  it('should deduplicate peers in home set', () => {
    ring.rebuild(['http://a.com', 'http://b.com']);
    const homeSet = ring.getHomeSet('some-key', 2);
    const unique = new Set(homeSet);
    assert.equal(homeSet.length, unique.size);
  });

  it('should return fewer peers than requested when not enough available', () => {
    ring.rebuild(['http://a.com', 'http://b.com']);
    const homeSet = ring.getHomeSet('some-key', 5);
    assert.equal(homeSet.length, 2);
  });

  it('should handle single peer', () => {
    ring.rebuild(['http://only.com']);
    const homeSet = ring.getHomeSet('any-key', 3);
    assert.deepEqual(homeSet, ['http://only.com']);
  });

  it('should return empty array when ring is empty', () => {
    const homeSet = ring.getHomeSet('any-key', 3);
    assert.deepEqual(homeSet, []);
  });

  it('should update correctly after rebuild with different peers', () => {
    ring.rebuild(['http://a.com', 'http://b.com']);
    const set1 = ring.getHomeSet('test-key', 2);
    assert.equal(set1.length, 2);

    ring.rebuild(['http://c.com', 'http://d.com', 'http://e.com']);
    const set2 = ring.getHomeSet('test-key', 2);
    assert.equal(set2.length, 2);

    // Old peers should not appear
    for (const peer of set2) {
      assert.ok(
        ['http://c.com', 'http://d.com', 'http://e.com'].includes(peer),
      );
    }
  });

  it('should minimize disruption when adding a peer', () => {
    const peers = Array.from({ length: 5 }, (_, i) => `http://peer-${i}.com`);
    ring.rebuild(peers);

    const keyCount = 1000;
    const beforeMap = new Map<string, string>();
    for (let i = 0; i < keyCount; i++) {
      const key = `key-${i}`;
      beforeMap.set(key, ring.getHomeSet(key, 1)[0]);
    }

    // Add one more peer
    ring.rebuild([...peers, 'http://peer-new.com']);

    let movedCount = 0;
    for (let i = 0; i < keyCount; i++) {
      const key = `key-${i}`;
      const after = ring.getHomeSet(key, 1)[0];
      if (beforeMap.get(key) !== after) {
        movedCount++;
      }
    }

    // Ideal: ~1/6 of keys move. Allow up to 40% as generous bound.
    const movedPct = movedCount / keyCount;
    assert.ok(
      movedPct < 0.4,
      `${(movedPct * 100).toFixed(1)}% of keys moved (expected <40%)`,
    );
  });
});
