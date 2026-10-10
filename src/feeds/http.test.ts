/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import {
  feedEntityTag,
  ifNoneMatchMatches,
  RenderingCache,
  serveFeed,
} from './http.js';
import { Feed, FeedFormat, FeedSnapshot } from './types.js';

/** A format that counts its renders, so memoisation shows. */
const countingFormat = (): FeedFormat & { renders: number } => {
  const format = {
    name: 'test',
    version: 1,
    contentType: 'text/plain; charset=utf-8',
    renders: 0,
    render(feed: Feed) {
      format.renders += 1;
      return Buffer.from(`${feed.title}:${feed.items.length}`);
    },
  };
  return format;
};

const snapshot = (version: string, title = 'T'): FeedSnapshot => ({
  feed: { title, link: 'https://g.example/', description: '', items: [] },
  version,
  headers: { 'x-test-source': 'vouched' },
});

const appServing = (
  current: () => FeedSnapshot,
  format: FeedFormat,
  renderings = new RenderingCache(),
) => {
  const app = express();
  app.get('/feed', (req, res) => {
    serveFeed(req, res, {
      snapshot: current(),
      format,
      cacheControl: 'public, max-age=60',
      renderings,
    });
  });
  return app;
};

describe('serveFeed', () => {
  it('sends the rendering with its digest, tag, cache policy and the source’s headers', async () => {
    const format = countingFormat();
    const res = await request(appServing(() => snapshot('v1'), format))
      .get('/feed')
      .expect(200);
    const body = Buffer.from(res.text);
    assert.equal(res.text, 'T:0');
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['content-length'], String(body.length));
    assert.equal(
      res.headers['content-digest'],
      `sha-256=:${crypto.createHash('sha256').update(body).digest('base64')}:`,
    );
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
    assert.equal(res.headers['etag'], feedEntityTag(format, snapshot('v1')));
    assert.equal(res.headers['x-test-source'], 'vouched');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await request(
      appServing(() => snapshot('v1'), countingFormat()),
    )
      .head('/feed')
      .expect(200);
    assert.equal(res.headers['content-length'], '3');
    assert.equal(res.text, undefined);
  });

  it('answers a current copy with 304, by exact, listed, weak or wildcard tag', async () => {
    const format = countingFormat();
    const app = appServing(() => snapshot('v1'), format);
    const etag = feedEntityTag(format, snapshot('v1'));
    for (const header of [etag, `"x", ${etag}`, `W/${etag}`, '*']) {
      const res = await request(app)
        .get('/feed')
        .set('If-None-Match', header)
        .expect(304);
      assert.equal(res.headers['etag'], etag, header);
      assert.equal(res.headers['x-test-source'], undefined, header);
    }
    await request(app).get('/feed').set('If-None-Match', '"other"').expect(200);
  });

  it('renders a version once, and again when it changes', async () => {
    const format = countingFormat();
    let current = snapshot('v1');
    const app = appServing(() => current, format);
    await request(app).get('/feed').expect(200);
    await request(app).get('/feed').expect(200);
    assert.equal(format.renders, 1);
    current = snapshot('v2', 'U');
    const res = await request(app).get('/feed').expect(200);
    assert.equal(res.text, 'U:0');
    assert.equal(format.renders, 2);
  });

  it('names the format and its version in the tag, so a new rendering is a new tag', () => {
    const a = countingFormat();
    const b = { ...countingFormat(), version: 2 };
    assert.notEqual(
      feedEntityTag(a, snapshot('v1')),
      feedEntityTag(b, snapshot('v1')),
    );
  });

  it('keeps only the most recent renderings', () => {
    const format = countingFormat();
    const cache = new RenderingCache(2);
    cache.get(format, snapshot('a'));
    cache.get(format, snapshot('b'));
    cache.get(format, snapshot('a'));
    cache.get(format, snapshot('c'));
    assert.equal(format.renders, 3);
    cache.get(format, snapshot('a'));
    assert.equal(format.renders, 3, '"a" was used most recently, so kept');
    cache.get(format, snapshot('b'));
    assert.equal(format.renders, 4, '"b" was evicted');
  });
});

describe('ifNoneMatchMatches', () => {
  it('is false without a header and for other tags', () => {
    assert.equal(ifNoneMatchMatches(undefined, '"a"'), false);
    assert.equal(ifNoneMatchMatches('"b", W/"c"', '"a"'), false);
  });
});
