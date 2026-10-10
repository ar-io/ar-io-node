/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { BandDescriptor, IndexPublication } from '../lib/index-publication.js';
import type { PublicationView } from '../routes/published-indexes.js';
import {
  buildIndexBandFeed,
  INDEX_FEED_HEADER,
  IndexBandFeedSource,
} from './index-bands.js';

const log = createTestLogger({ suite: 'index-bands feed' });
const BASE = 'https://gateway.example';
const hex = (c: string, n: number) => c.repeat(n);

const band = (
  id: string,
  options: {
    heightRange?: [number, number | null];
    torrent?: string;
    schema?: string;
  } = {},
): BandDescriptor => ({
  id,
  ...(options.heightRange !== undefined
    ? { heightRange: options.heightRange }
    : {}),
  files: [
    { name: 'manifest.json', size: 1000, sha256: hex('1', 64) },
    { name: '00.cdb', size: 1_500_000, sha256: hex('2', 64) },
  ],
  ...(options.torrent !== undefined
    ? {
        torrent: {
          infohashV1: hex(options.torrent, 40),
          infohashV2: hex(options.torrent, 64),
          magnet: `magnet:?xt=urn:btih:${hex(options.torrent, 40)}&dn=x`,
          torrentUrl: `/ar-io/indexes/torrents/${hex(options.torrent, 40)}.torrent`,
        },
      }
    : {}),
  ...(options.schema !== undefined
    ? { metadata: { schema: options.schema } }
    : {}),
});

const publication = (bands: BandDescriptor[]): IndexPublication =>
  ({
    version: 1,
    publisher: 'W'.repeat(43),
    sequence: 131,
    issuedAt: '2026-10-10T04:12:00.000Z',
    expiresAt: '2026-10-11T04:12:00.000Z',
    indexes: [{ name: 'parquet-l1', kind: 'parquet-l1', bands }],
    signature: { alg: 'ed25519', keyId: 'K', sig: 'S' },
  }) as IndexPublication;

const sizesFor = (bands: BandDescriptor[], size = 48_213) =>
  new Map(
    bands
      .filter((b) => b.torrent !== undefined)
      .map((b) => [b.torrent!.infohashV1, size]),
  );

describe('buildIndexBandFeed', () => {
  const bands = [
    band('l1-h100000-199999', {
      heightRange: [100000, 199999],
      torrent: 'a',
      schema: 'l1-3',
    }),
    band('l1-h2000000-tip', { heightRange: [2000000, null], torrent: 'b' }),
    band('l1-http-only', { heightRange: [300000, 399999] }),
    band('l1-no-range', { torrent: 'c' }),
    band('l1-h0-99999', { heightRange: [0, 99999], torrent: 'd' }),
  ];

  it('lists the torrent bands, newest heights first, ranged before unranged', () => {
    const feed = buildIndexBandFeed({
      publication: publication(bands),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(bands),
    })!;
    assert.deepEqual(
      feed.items.map((i) => i.elements?.find((e) => e.name === 'band')?.value),
      ['l1-h2000000-tip', 'l1-h100000-199999', 'l1-h0-99999', 'l1-no-range'],
    );
  });

  it('describes each band as its torrent, with the signed magnet and an absolute .torrent URL', () => {
    const feed = buildIndexBandFeed({
      publication: publication(bands),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(bands),
    })!;
    const item = feed.items.find((i) => i.id === `urn:btih:${hex('a', 40)}`)!;
    assert.equal(item.title, 'l1-h100000-199999 (heights 100000 to 199999)');
    assert.equal(item.description, '2 files, 1.5 MB, layout l1-3');
    assert.equal(item.link, `magnet:?xt=urn:btih:${hex('a', 40)}&dn=x`);
    assert.deepEqual(item.enclosure, {
      url: `${BASE}/ar-io/indexes/torrents/${hex('a', 40)}.torrent`,
      length: 48_213,
      type: 'application/x-bittorrent',
    });
    assert.deepEqual(item.published, new Date('2026-10-10T04:12:00.000Z'));
    const facts = Object.fromEntries(
      (item.elements ?? []).map((e) => [e.name, e.value]),
    );
    assert.deepEqual(facts, {
      band: 'l1-h100000-199999',
      infohashV2: hex('a', 64),
      heightFrom: '100000',
      heightTo: '199999',
    });
    const tip = feed.items.find((i) => i.id === `urn:btih:${hex('b', 40)}`)!;
    assert.equal(tip.title, 'l1-h2000000-tip (heights 2000000 to tip)');
    assert.equal(
      tip.elements?.some((e) => e.name === 'heightTo'),
      false,
      'a band open at the tip has no upper height',
    );
  });

  it('names the publisher and the publication it was built from', () => {
    const feed = buildIndexBandFeed({
      publication: publication(bands),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(bands),
    })!;
    assert.equal(feed.title, 'gateway.example: parquet-l1');
    // The kind is named only when it differs from the index's name.
    assert.match(
      feed.description,
      /^Bands of the parquet-l1 index published by gateway W+, one torrent each\./,
    );
    assert.equal(feed.link, `${BASE}/ar-io/indexes`);
    assert.equal(feed.ttlMinutes, 30);
    const facts = Object.fromEntries(
      (feed.elements ?? []).map((e) => [e.name, e.value]),
    );
    assert.deepEqual(facts, {
      publisher: 'W'.repeat(43),
      sequence: '131',
      publication: 'f'.repeat(64),
      index: 'parquet-l1',
      kind: 'parquet-l1',
    });
  });

  it('leaves out a band whose .torrent is not there yet', () => {
    const sizes = sizesFor(bands);
    sizes.delete(hex('b', 40));
    const feed = buildIndexBandFeed({
      publication: publication(bands),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizes,
    })!;
    assert.equal(feed.items.length, 3);
    assert.ok(!feed.items.some((i) => i.id === `urn:btih:${hex('b', 40)}`));
  });

  it('is undefined for an index the publication does not have, and empty for one with no torrents', () => {
    const args = {
      publicationSha256: 'f'.repeat(64),
      baseUrl: BASE,
      torrentSizes: new Map<string, number>(),
    };
    assert.equal(
      buildIndexBandFeed({
        ...args,
        publication: publication(bands),
        index: 'root-tx-index',
      }),
      undefined,
    );
    assert.deepEqual(
      buildIndexBandFeed({
        ...args,
        publication: publication([band('x', { heightRange: [0, 1] })]),
        index: 'parquet-l1',
      })!.items,
      [],
    );
  });
});

describe('IndexBandFeedSource', () => {
  const view = (pub: IndexPublication, sha256: string): PublicationView =>
    ({ sha256, publication: pub }) as unknown as PublicationView;

  it('builds a snapshot naming the publication, and memoises it per publication', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    let current = view(publication(bands), '1'.repeat(64));
    let stats = 0;
    const source = new IndexBandFeedSource({
      log,
      published: { current: async () => current },
      publishedDir: '/nowhere',
      baseUrl: BASE,
      torrentSize: async () => {
        stats += 1;
        return 100;
      },
    });
    const first = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(first?.headers?.[INDEX_FEED_HEADER], '1'.repeat(64));
    assert.equal(first?.feed.items.length, 1);
    const again = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(again, first, 'the same snapshot, not rebuilt');
    assert.equal(stats, 1);

    current = view(
      publication([...bands, band('b', { heightRange: [2, 3], torrent: 'b' })]),
      '2'.repeat(64),
    );
    const next = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(next?.headers?.[INDEX_FEED_HEADER], '2'.repeat(64));
    assert.equal(next?.feed.items.length, 2);
    assert.notEqual(next?.version, first?.version);
  });

  it('looks again for a .torrent that was missing, and adds its band when it appears', async () => {
    const bands = [
      band('a', { heightRange: [0, 1], torrent: 'a' }),
      band('b', { heightRange: [2, 3], torrent: 'b' }),
    ];
    const present = new Set([hex('a', 40)]);
    const source = new IndexBandFeedSource({
      log,
      published: {
        current: async () => view(publication(bands), '1'.repeat(64)),
      },
      publishedDir: '/nowhere',
      baseUrl: BASE,
      torrentSize: async (ih) => (present.has(ih) ? 100 : undefined),
    });
    const before = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(before?.feed.items.length, 1);
    present.add(hex('b', 40));
    const after = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(after?.feed.items.length, 2);
    assert.notEqual(after?.version, before?.version);
  });

  it('offers no feed without a base URL, without a publication, or for an unknown index', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    const published = {
      current: async (): Promise<PublicationView | undefined> =>
        view(publication(bands), '1'.repeat(64)),
    };
    const noBase = new IndexBandFeedSource({
      log,
      published,
      publishedDir: '/nowhere',
      baseUrl: undefined,
      torrentSize: async () => 100,
    });
    assert.equal(await noBase.snapshot({ index: 'parquet-l1' }), undefined);
    const source = new IndexBandFeedSource({
      log,
      published,
      publishedDir: '/nowhere',
      baseUrl: BASE,
      torrentSize: async () => 100,
    });
    assert.equal(await source.snapshot({ index: 'root-tx-index' }), undefined);
    const nothing = new IndexBandFeedSource({
      log,
      published: { current: async () => undefined },
      publishedDir: '/nowhere',
      baseUrl: BASE,
      torrentSize: async () => 100,
    });
    assert.equal(await nothing.snapshot({ index: 'parquet-l1' }), undefined);
  });

  it('gives equal versions for equal content', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    const make = () =>
      new IndexBandFeedSource({
        log,
        published: {
          current: async () => view(publication(bands), '1'.repeat(64)),
        },
        publishedDir: '/nowhere',
        baseUrl: BASE,
        torrentSize: async () => 100,
      });
    const [a, b] = await Promise.all([
      make().snapshot({ index: 'parquet-l1' }),
      make().snapshot({ index: 'parquet-l1' }),
    ]);
    assert.equal(a?.version, b?.version);
  });
});
