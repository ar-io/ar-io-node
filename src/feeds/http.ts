/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import { Request, Response } from 'express';

import { formatContentDigest } from '../lib/digest.js';
import { FeedFormat, FeedSnapshot } from './types.js';

/** One rendering of a snapshot in a format, ready to send. */
export interface Rendering {
  body: Buffer;
  /** Strong entity tag, quoted. */
  etag: string;
  /** SHA-256 of the body, base64url. */
  digest: string;
}

/**
 * The entity tag for a snapshot in a format. It names the format and its
 * version, so a reader's copy in one rendering is never taken for another.
 */
export function feedEntityTag(
  format: FeedFormat,
  snapshot: FeedSnapshot,
): string {
  const version = crypto
    .createHash('sha256')
    .update(snapshot.version)
    .digest('hex')
    .slice(0, 32);
  return `"${format.name}-${format.version}-${version}"`;
}

/**
 * Whether an `If-None-Match` header matches an entity tag: `*`, or any tag
 * in the list compared weakly (RFC 9110 13.1.2), as a cache revalidating a
 * copy is entitled to.
 */
export function ifNoneMatchMatches(
  header: string | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || opaque(tag) === wanted);
}

/**
 * The last renderings made, by format and snapshot version, so a poll that
 * is not a `304` costs a lookup rather than a render. Small and bounded: a
 * gateway has a handful of feeds, each in one current version.
 */
export class RenderingCache {
  private readonly entries = new Map<string, Rendering>();

  constructor(private readonly max = 32) {}

  get(format: FeedFormat, snapshot: FeedSnapshot): Rendering {
    const etag = feedEntityTag(format, snapshot);
    const cached = this.entries.get(etag);
    if (cached !== undefined) {
      // Most recently used last, so eviction takes the oldest.
      this.entries.delete(etag);
      this.entries.set(etag, cached);
      return cached;
    }
    const body = format.render(snapshot.feed);
    const rendering: Rendering = {
      body,
      etag,
      digest: crypto.createHash('sha256').update(body).digest('base64url'),
    };
    this.entries.set(etag, rendering);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return rendering;
  }
}

/**
 * Answer a request with a feed: `304` when the reader's copy is current,
 * else `200` with the rendering, its `Content-Digest` (which signing binds
 * to the body) and the headers the source vouches for. `HEAD` gets the
 * headers alone.
 *
 * @returns the status sent and the body bytes written
 */
export function serveFeed(
  req: Request,
  res: Response,
  options: {
    snapshot: FeedSnapshot;
    format: FeedFormat;
    cacheControl: string;
    renderings: RenderingCache;
  },
): { status: 200 | 304; bytes: number } {
  const { snapshot, format, cacheControl, renderings } = options;
  const rendering = renderings.get(format, snapshot);
  res.setHeader('ETag', rendering.etag);
  res.setHeader('Cache-Control', cacheControl);
  if (ifNoneMatchMatches(req.headers['if-none-match'], rendering.etag)) {
    res.status(304).end();
    return { status: 304, bytes: 0 };
  }
  for (const [name, value] of Object.entries(snapshot.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.setHeader('Content-Type', format.contentType);
  res.setHeader('Content-Digest', formatContentDigest(rendering.digest));
  res.setHeader('Content-Length', String(rendering.body.byteLength));
  const head = req.method === 'HEAD';
  res.status(200).end(head ? undefined : rendering.body);
  return { status: 200, bytes: head ? 0 : rendering.body.byteLength };
}
