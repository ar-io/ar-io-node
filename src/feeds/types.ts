/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The feed layer's model and interfaces.
 *
 * Three parts, each knowing nothing of the others' details:
 *
 * - A {@link FeedSource} turns something the gateway holds (a publication,
 *   later an ArNS name or an address) into a {@link Feed}: what is in the
 *   feed, with no wire format.
 * - A {@link FeedFormat} renders a feed (RSS 2.0 today; Atom or JSON Feed
 *   would be another implementation).
 * - `serveFeed` (./http.ts) answers a request with any snapshot in any
 *   format: entity tags, `304`, digests and the source's headers.
 *
 * So a new feed is a new source, and a new format is a new renderer; neither
 * touches the serving code or the other.
 */

/** A feed, independent of its wire format. */
export interface Feed {
  title: string;
  /** Absolute URL of what the feed describes. */
  link: string;
  description: string;
  /** When the content last changed (RSS `lastBuildDate`). */
  updated?: Date;
  /** How long a reader may wait between polls, in minutes (RSS `ttl`). */
  ttlMinutes?: number;
  /** Namespaced, machine-readable facts about the feed. */
  elements?: FeedElement[];
  items: FeedItem[];
}

/** One entry of a feed. */
export interface FeedItem {
  /**
   * Stable, and unique within the feed. Readers de-duplicate on it, so it
   * must change exactly when the item is a different thing.
   */
  id: string;
  title: string;
  /** Absolute URL or URI; a `magnet:` link is allowed. */
  link?: string;
  description?: string;
  published?: Date;
  enclosure?: FeedEnclosure;
  elements?: FeedElement[];
}

/** A file an item carries, which a reader can fetch. */
export interface FeedEnclosure {
  /** Absolute URL. */
  url: string;
  /** Bytes. */
  length: number;
  /** Media type, such as `application/x-bittorrent`. */
  type: string;
}

/** An XML namespace for extension elements. */
export interface FeedNamespace {
  prefix: string;
  uri: string;
}

/** One namespaced element, `<prefix:name>value</prefix:name>`. */
export interface FeedElement {
  namespace: FeedNamespace;
  name: string;
  value: string;
}

/** What a source returns for one request. */
export interface FeedSnapshot {
  feed: Feed;
  /**
   * Changes whenever the feed's content may differ. The entity tag is
   * derived from it, and two snapshots with equal versions must render
   * identically.
   */
  version: string;
  /**
   * Response headers the source vouches for, such as a signing trigger
   * naming what the feed was built from.
   */
  headers?: Record<string, string>;
}

/**
 * Anything that can be a feed.
 *
 * @typeParam P what selects one feed among those the source offers (for
 *   the index feeds, the index name).
 */
export interface FeedSource<P> {
  /** The feed now, or undefined when there is none for these parameters. */
  snapshot(params: P): Promise<FeedSnapshot | undefined>;
}

/** A wire format for feeds. */
export interface FeedFormat {
  /** Short and stable, such as `rss2`; part of the entity tag. */
  name: string;
  /**
   * Bumped whenever the same feed would render differently, so a reader's
   * cached copy is not taken for the new rendering.
   */
  version: number;
  contentType: string;
  render(feed: Feed): Buffer;
}
