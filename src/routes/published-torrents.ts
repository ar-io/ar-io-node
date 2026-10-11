/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * The `.torrent` files a gateway serves for the bands its sidecar publishes.
 *
 * The publisher builds each torrent deterministically, with nothing
 * publisher-specific in it, and keeps it under `published/.torrents/`. What
 * the gateway serves is that torrent plus one thing only the gateway knows:
 * its own WebSeed (BEP 19), the public URL its `/ar-io/indexes/webseed/`
 * route answers on. A stock BitTorrent client then has somewhere to fetch
 * pieces from when no peer can deliver them, which a gateway subscriber
 * never needs: it strips WebSeeds from every torrent it is given, and adds
 * the publisher's own only once peers stall.
 *
 * The info dictionary is copied byte for byte, so the infohashes the signed
 * publication names are the served torrent's.
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  PUBLISHED_TORRENT_DIR,
  WEBSEED_PATH,
} from '../lib/index-publication.js';
import { withWebSeeds } from '../lib/torrent-metainfo.js';

/** A `.torrent` as the gateway serves it. */
export interface ServedTorrent {
  body: Buffer;
  /** SHA-256 of `body`, hex. */
  sha256: string;
}

/** The `.torrent` a gateway serves for each band, by v1 infohash. */
export interface TorrentMetainfoSource {
  /**
   * The served `.torrent` for a v1 infohash, or undefined when there is
   * none (not built yet, or not a torrent). Whether the publication still
   * offers it is the caller's question, not this one's.
   */
  torrent(infohashV1: string): Promise<ServedTorrent | undefined>;
}

const INFOHASH_V1 = /^[0-9a-f]{40}$/;

export class PublishedTorrents implements TorrentMetainfoSource {
  private readonly log: Logger;
  private readonly dir: string;
  private readonly webSeeds: string[];
  private readonly maxEntries: number;
  /** Served torrents by infohash, with the file stat they were made from. */
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; served: ServedTorrent }
  >();
  private readonly warned = new Set<string>();

  /**
   * @param options.publicOrigin the gateway's public origin
   *   (`INDEXES_PUBLIC_URL`). Its WebSeed goes into every torrent served.
   *   Without it torrents are served exactly as the publisher wrote them: a
   *   URL from a request's Host header could be pointed anywhere.
   * @param options.maxEntries served torrents kept in memory, a few
   *   kilobytes each.
   */
  constructor(options: {
    log: Logger;
    publishedDir: string;
    publicOrigin: string | undefined;
    maxEntries?: number;
  }) {
    this.log = options.log.child({ class: 'PublishedTorrents' });
    this.dir = path.join(options.publishedDir, PUBLISHED_TORRENT_DIR);
    this.webSeeds =
      options.publicOrigin !== undefined
        ? [new URL(WEBSEED_PATH, options.publicOrigin).toString()]
        : [];
    this.maxEntries = options.maxEntries ?? 256;
  }

  async torrent(infohashV1: string): Promise<ServedTorrent | undefined> {
    if (!INFOHASH_V1.test(infohashV1)) return undefined;
    const file = path.join(this.dir, `${infohashV1}.torrent`);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat === undefined) return undefined;

    const cached = this.entries.get(infohashV1);
    if (
      cached !== undefined &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      // Most recently used goes last.
      this.entries.delete(infohashV1);
      this.entries.set(infohashV1, cached);
      return cached.served;
    }

    let stored: Buffer;
    try {
      stored = await fs.readFile(file);
    } catch {
      return undefined;
    }
    let body: Buffer;
    try {
      body =
        this.webSeeds.length > 0 ? withWebSeeds(stored, this.webSeeds) : stored;
    } catch (error: any) {
      // The publisher wrote it, so this is a fault, not an attack; say so
      // once rather than on every poll of the feed.
      if (!this.warned.has(infohashV1)) {
        this.warned.add(infohashV1);
        this.log.warn('Not serving a .torrent that does not parse', {
          infohashV1,
          error: error?.message,
        });
      }
      return undefined;
    }
    const served: ServedTorrent = {
      body,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    };
    this.entries.delete(infohashV1);
    this.entries.set(infohashV1, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      served,
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return served;
  }
}
