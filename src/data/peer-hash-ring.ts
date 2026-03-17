/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';

function hashToUint32(input: string): number {
  const hash = createHash('sha256').update(input).digest();
  return hash.readUInt32BE(0);
}

interface RingEntry {
  hash: number;
  peerUrl: string;
}

export class PeerHashRing {
  private ring: RingEntry[] = [];
  private virtualNodesPerPeer: number;

  constructor(virtualNodesPerPeer: number) {
    this.virtualNodesPerPeer = virtualNodesPerPeer;
  }

  rebuild(peerUrls: string[]): void {
    const entries: RingEntry[] = [];
    for (const peerUrl of peerUrls) {
      for (let i = 0; i < this.virtualNodesPerPeer; i++) {
        entries.push({
          hash: hashToUint32(`${peerUrl}:${i}`),
          peerUrl,
        });
      }
    }
    entries.sort((a, b) => a.hash - b.hash);
    this.ring = entries;
  }

  getHomeSet(key: string, count: number): string[] {
    if (this.ring.length === 0) {
      return [];
    }

    const keyHash = hashToUint32(key);
    const result: string[] = [];
    const seen = new Set<string>();

    // Binary search for the first entry >= keyHash
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < keyHash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Walk clockwise from the insertion point
    for (let i = 0; i < this.ring.length && result.length < count; i++) {
      const idx = (lo + i) % this.ring.length;
      const entry = this.ring[idx];
      if (!seen.has(entry.peerUrl)) {
        seen.add(entry.peerUrl);
        result.push(entry.peerUrl);
      }
    }

    return result;
  }
}
