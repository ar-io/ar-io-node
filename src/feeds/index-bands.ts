/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from 'winston';

import {
  BandDescriptor,
  IndexPublication,
  PUBLISHED_TORRENT_DIR,
} from '../lib/index-publication.js';
import type { PublicationView } from '../routes/published-indexes.js';
import {
  Feed,
  FeedElement,
  FeedItem,
  FeedNamespace,
  FeedSnapshot,
  FeedSource,
} from './types.js';

/**
 * A feed of one published index's bands, for BitTorrent clients: one item
 * per band offered as a torrent, so a client subscribed with an
 * auto-download rule takes every band now and every new band as it is
 * published, over BitTorrent.
 *
 * A view of the gateway's own signed publication and nothing else: every
 * infohash in it is one the publication lists, so trusting the feed is
 * trusting that publisher, and the publication stays the authority.
 */

/**
 * The response header naming the publication a feed was built from (its
 * SHA-256). A signing trigger: a signed feed response binds the feed's
 * bytes, through Content-Digest, to that publication.
 */
export const INDEX_FEED_HEADER = 'x-ar-io-index-feed';

/** The index feed's own elements. A URN: nothing is fetched from it. */
export const INDEX_FEED_NAMESPACE: FeedNamespace = {
  prefix: 'ario',
  uri: 'urn:ar-io:index-feed:1',
};

/** How long a reader may wait between polls. */
export const INDEX_FEED_TTL_MINUTES = 30;

export interface IndexFeedParams {
  index: string;
}

const ario = (name: string, value: string | number): FeedElement => ({
  namespace: INDEX_FEED_NAMESPACE,
  name,
  value: String(value),
});

/** Bytes for people: 1 decimal place in the largest unit that fits. */
function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Newest heights first; bands without a range last, then by id. */
function byNewestHeights(a: BandDescriptor, b: BandDescriptor): number {
  const from = (band: BandDescriptor) => band.heightRange?.[0];
  const to = (band: BandDescriptor) =>
    band.heightRange === undefined
      ? undefined
      : (band.heightRange[1] ?? Number.MAX_SAFE_INTEGER);
  const [fa, fb] = [from(a), from(b)];
  if (fa !== undefined && fb !== undefined && fa !== fb) return fb - fa;
  if (fa === undefined && fb !== undefined) return 1;
  if (fa !== undefined && fb === undefined) return -1;
  const [ta, tb] = [to(a), to(b)];
  if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function bandItem(
  band: BandDescriptor,
  options: {
    baseUrl: string;
    published: Date;
    torrentSize: number;
  },
): FeedItem {
  // Only bands with a torrent reach here.
  const torrent = band.torrent!;
  const range = band.heightRange;
  const heights =
    range === undefined ? '' : ` (heights ${range[0]} to ${range[1] ?? 'tip'})`;
  const size = band.files.reduce((sum, file) => sum + file.size, 0);
  const schema = band.metadata?.schema;
  const elements: FeedElement[] = [ario('band', band.id)];
  if (torrent.infohashV2 !== undefined) {
    elements.push(ario('infohashV2', torrent.infohashV2));
  }
  if (range !== undefined) {
    elements.push(ario('heightFrom', range[0]));
    if (range[1] !== null) elements.push(ario('heightTo', range[1]));
  }
  return {
    // A band rebuilt under the same id has new bytes and a new infohash,
    // so it is a new item; an unchanged band is never fetched twice.
    id: `urn:btih:${torrent.infohashV1}`,
    title: `${band.id}${heights}`,
    description:
      `${band.files.length} files, ${formatBytes(size)}` +
      (typeof schema === 'string' ? `, layout ${schema}` : ''),
    // The publication does not record when each band first appeared;
    // inventing a time would be wrong, so every item carries its issue time.
    published: options.published,
    link: torrent.magnet,
    enclosure: {
      url: `${options.baseUrl}/ar-io/indexes/torrents/${torrent.infohashV1}.torrent`,
      length: options.torrentSize,
      type: 'application/x-bittorrent',
    },
    elements,
  };
}

/**
 * The feed for one index of a publication. Pure.
 *
 * @param input.torrentSizes the size of each band's `.torrent`, by v1
 *   infohash. A band offered as a torrent whose file is not there (yet) is
 *   left out, as the torrent route would answer 404 for it.
 * @returns undefined when the publication has no such index
 */
export function buildIndexBandFeed(input: {
  publication: IndexPublication;
  publicationSha256: string;
  index: string;
  baseUrl: string;
  torrentSizes: ReadonlyMap<string, number>;
}): Feed | undefined {
  const { publication, publicationSha256, index, baseUrl, torrentSizes } =
    input;
  const entry = publication.indexes.find(({ name }) => name === index);
  if (entry === undefined) return undefined;
  const published = new Date(publication.issuedAt);
  const items = entry.bands
    .filter(
      (band) =>
        band.torrent !== undefined && torrentSizes.has(band.torrent.infohashV1),
    )
    .sort(byNewestHeights)
    .map((band) =>
      bandItem(band, {
        baseUrl,
        published,
        torrentSize: torrentSizes.get(band.torrent!.infohashV1)!,
      }),
    );
  return {
    title: `${new URL(baseUrl).host}: ${index}`,
    link: `${baseUrl}/ar-io/indexes`,
    description:
      `Bands of the ${index} index` +
      (entry.kind !== index ? ` (${entry.kind})` : '') +
      ` published by gateway ` +
      `${publication.publisher}, one torrent each. Verify them against the ` +
      `signed publication at ${baseUrl}/ar-io/indexes.`,
    updated: published,
    ttlMinutes: INDEX_FEED_TTL_MINUTES,
    elements: [
      ario('publisher', publication.publisher),
      ario('sequence', publication.sequence),
      ario('publication', publicationSha256),
      ario('index', index),
      ario('kind', entry.kind),
    ],
    items,
  };
}

/** A version that changes exactly when the feed's content does. */
function feedVersion(feed: Feed): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(feed, (_key, value) =>
        value instanceof Date ? value.toISOString() : value,
      ),
    )
    .digest('hex');
}

/**
 * The index feeds of what this gateway publishes. Reads the publication
 * view and the size of each band's `.torrent`; memoised per publication, so
 * a poll costs a map lookup.
 */
export class IndexBandFeedSource implements FeedSource<IndexFeedParams> {
  private readonly log: Logger;
  private readonly published: {
    current(): Promise<PublicationView | undefined>;
  };
  private readonly baseUrl: string | undefined;
  private readonly torrentSize: (
    infohashV1: string,
  ) => Promise<number | undefined>;
  /** Snapshots of the current publication, by index name. */
  private memo = new Map<string, FeedSnapshot>();
  private memoFor: string | undefined;
  private warnedNoBaseUrl = false;

  /**
   * @param options.baseUrl the gateway's public origin, the base of the
   *   feed's absolute URLs (`INDEXES_PUBLIC_URL`). Without it there are no
   *   feeds: a URL from the request's Host header could be pointed anywhere.
   * @param options.publishedDir where the `.torrent` files are, under
   *   `.torrents/`; used by the default `torrentSize`.
   */
  constructor(options: {
    log: Logger;
    published: { current(): Promise<PublicationView | undefined> };
    publishedDir: string;
    baseUrl: string | undefined;
    torrentSize?: (infohashV1: string) => Promise<number | undefined>;
  }) {
    this.log = options.log.child({ class: 'IndexBandFeedSource' });
    this.published = options.published;
    this.baseUrl = options.baseUrl;
    this.torrentSize =
      options.torrentSize ??
      (async (infohashV1) => {
        try {
          return (
            await fs.stat(
              path.join(
                options.publishedDir,
                PUBLISHED_TORRENT_DIR,
                `${infohashV1}.torrent`,
              ),
            )
          ).size;
        } catch {
          return undefined;
        }
      });
  }

  async snapshot(params: IndexFeedParams): Promise<FeedSnapshot | undefined> {
    if (this.baseUrl === undefined) {
      if (!this.warnedNoBaseUrl) {
        this.warnedNoBaseUrl = true;
        this.log.warn(
          'Index feeds are off: set INDEXES_PUBLIC_URL (or ARNS_ROOT_HOST) to the gateway’s public origin',
        );
      }
      return undefined;
    }
    const view = await this.published.current();
    if (view === undefined) return undefined;
    if (this.memoFor !== view.sha256) {
      this.memo = new Map();
      this.memoFor = view.sha256;
    }
    const cached = this.memo.get(params.index);
    if (cached !== undefined) return cached;

    const entry = view.publication.indexes.find(
      ({ name }) => name === params.index,
    );
    if (entry === undefined) return undefined;
    const torrentSizes = new Map<string, number>();
    let complete = true;
    await Promise.all(
      entry.bands.map(async (band) => {
        if (band.torrent === undefined) return;
        const size = await this.torrentSize(band.torrent.infohashV1);
        if (size === undefined) {
          complete = false;
        } else {
          torrentSizes.set(band.torrent.infohashV1, size);
        }
      }),
    );
    const feed = buildIndexBandFeed({
      publication: view.publication,
      publicationSha256: view.sha256,
      index: params.index,
      baseUrl: this.baseUrl,
      torrentSizes,
    });
    if (feed === undefined) return undefined;
    const snapshot: FeedSnapshot = {
      feed,
      version: feedVersion(feed),
      headers: { [INDEX_FEED_HEADER]: view.sha256 },
    };
    // A band whose .torrent is not there yet is left out; look again next
    // time rather than keep the feed without it.
    if (complete) this.memo.set(params.index, snapshot);
    return snapshot;
  }
}
