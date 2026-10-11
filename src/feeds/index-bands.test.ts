/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  BandDescriptor,
  IndexPublication,
  torrentNameForFiles,
} from '../lib/index-publication.js';
import type { PublicationView } from '../routes/published-indexes.js';
import type {
  ServedTorrent,
  TorrentMetainfoSource,
} from '../routes/published-torrents.js';
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
    supersedes?: string | string[];
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
  ...(options.schema !== undefined || options.supersedes !== undefined
    ? {
        metadata: {
          ...(options.schema !== undefined ? { schema: options.schema } : {}),
          ...(options.supersedes !== undefined
            ? { supersedes: options.supersedes }
            : {}),
        },
      }
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

/** An in-memory torrent source: each served torrent `size` bytes long. */
const servedOf = (size: number): ServedTorrent => ({
  body: Buffer.alloc(size),
  sha256: 'f'.repeat(64),
});
const torrentsOf = (
  size: (infohashV1: string) => number | undefined,
): TorrentMetainfoSource => ({
  torrent: async (infohashV1) => {
    const n = size(infohashV1);
    return n === undefined ? undefined : servedOf(n);
  },
});

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
    const folder = torrentNameForFiles(bands[0].files);
    assert.equal(
      item.description,
      `2 files, 1.5 MB, layout l1-3, saved in folder ${folder}`,
    );
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
      torrentName: folder,
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

  it('names, for each band, the bands it supersedes, so a follower can drop them', () => {
    const replacing = [
      band('l1-h0-99999', {
        heightRange: [0, 99999],
        torrent: 'e',
        supersedes: ['l1-h0-99999-old-1', 'l1-h0-99999-old-2'],
      }),
      band('l1-h100000-tip', {
        heightRange: [100000, null],
        torrent: 'f',
        supersedes: 'l1-h100000-tip-old',
      }),
      band('l1-h200000-299999', {
        heightRange: [200000, 299999],
        torrent: 'a',
      }),
    ];
    const feed = buildIndexBandFeed({
      publication: publication(replacing),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(replacing),
    })!;
    const supersedes = (id: string) =>
      feed.items
        .find((i) => i.elements?.some((e) => e.value === id))!
        .elements!.filter((e) => e.name === 'supersedes')
        .map((e) => e.value);
    assert.deepEqual(supersedes('l1-h0-99999'), [
      'l1-h0-99999-old-1',
      'l1-h0-99999-old-2',
    ]);
    assert.deepEqual(supersedes('l1-h100000-tip'), ['l1-h100000-tip-old']);
    assert.deepEqual(supersedes('l1-h200000-299999'), []);
  });

  it('names only the supersessions the publisher honours', () => {
    const claims = [
      band('a', {
        heightRange: [0, 1],
        torrent: 'a',
        supersedes: ['b', 'gone-too'],
      }),
      band('b', { heightRange: [0, 1], torrent: 'b', supersedes: ['a'] }),
      band('c', { heightRange: [2, 3], torrent: 'c', supersedes: 'c' }),
      band('d', { heightRange: [4, 5], torrent: 'd', supersedes: 'gone' }),
      band('e', { heightRange: [6, 9], torrent: 'e', supersedes: ['f'] }),
      band('f', { heightRange: [6, 7], torrent: 'f' }),
    ];
    const feed = buildIndexBandFeed({
      publication: publication(claims),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(claims),
    })!;
    const named = Object.fromEntries(
      feed.items.map((i) => [
        i.elements!.find((e) => e.name === 'band')!.value,
        i.elements!.filter((e) => e.name === 'supersedes').map((e) => e.value),
      ]),
    );
    assert.deepEqual(named, {
      // A cycle and a band naming itself retire nothing at the publisher:
      // not even a cycle member's claim on a band no longer offered.
      a: [],
      b: [],
      c: [],
      // A band no longer offered was retired for its replacement.
      d: ['gone'],
      // One still offered, in its grace period, is being retired.
      e: ['f'],
      f: [],
    });
  });

  it('leaves out of the description a layout that is not a plain name', () => {
    const odd = [
      band('x', {
        heightRange: [0, 1],
        torrent: 'a',
        schema: '<img src=x onerror=alert(1)>',
      }),
    ];
    const feed = buildIndexBandFeed({
      publication: publication(odd),
      publicationSha256: 'f'.repeat(64),
      index: 'parquet-l1',
      baseUrl: BASE,
      torrentSizes: sizesFor(odd),
    })!;
    assert.doesNotMatch(feed.items[0].description!, /layout|img/);
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
    let reads = 0;
    const source = new IndexBandFeedSource({
      log,
      published: { current: async () => current },
      baseUrl: BASE,
      torrents: torrentsOf(() => {
        reads += 1;
        return 100;
      }),
    });
    const first = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(first?.headers?.[INDEX_FEED_HEADER], '1'.repeat(64));
    assert.equal(first?.feed.items.length, 1);
    const again = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(again, first, 'the same snapshot, not rebuilt');
    assert.equal(reads, 1);

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
      baseUrl: BASE,
      torrents: torrentsOf((ih) => (present.has(ih) ? 100 : undefined)),
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
      baseUrl: undefined,
      torrents: torrentsOf(() => 100),
    });
    assert.equal(await noBase.snapshot({ index: 'parquet-l1' }), undefined);
    const source = new IndexBandFeedSource({
      log,
      published,
      baseUrl: BASE,
      torrents: torrentsOf(() => 100),
    });
    assert.equal(await source.snapshot({ index: 'root-tx-index' }), undefined);
    const nothing = new IndexBandFeedSource({
      log,
      published: { current: async () => undefined },
      baseUrl: BASE,
      torrents: torrentsOf(() => 100),
    });
    assert.equal(await nothing.snapshot({ index: 'parquet-l1' }), undefined);
  });

  it('never leaves an older publication’s feed in a newer one’s memo', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    let current = view(publication(bands), '1'.repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const source = new IndexBandFeedSource({
      log,
      published: { current: async () => current },
      baseUrl: BASE,
      torrents: {
        // The first read, for the first publication, is slow.
        torrent: async () => {
          if (first) {
            first = false;
            await gate;
          }
          return servedOf(100);
        },
      },
    });
    const slow = source.snapshot({ index: 'parquet-l1' });
    await new Promise((resolve) => setImmediate(resolve));
    current = view(
      publication([...bands, band('b', { heightRange: [2, 3], torrent: 'b' })]),
      '2'.repeat(64),
    );
    await source.snapshot({ index: 'parquet-l1' });
    release();
    assert.equal((await slow)?.headers?.[INDEX_FEED_HEADER], '1'.repeat(64));

    const after = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(after?.headers?.[INDEX_FEED_HEADER], '2'.repeat(64));
    assert.equal(after?.feed.items.length, 2);
  });

  it('gives each enclosure the length of the torrent the gateway serves', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    const source = new IndexBandFeedSource({
      log,
      published: {
        current: async () => view(publication(bands), '1'.repeat(64)),
      },
      baseUrl: BASE,
      torrents: torrentsOf(() => 4_584),
    });
    const snapshot = await source.snapshot({ index: 'parquet-l1' });
    assert.equal(snapshot?.feed.items[0].enclosure?.length, 4_584);
  });

  it('gives equal versions for equal content', async () => {
    const bands = [band('a', { heightRange: [0, 1], torrent: 'a' })];
    const make = () =>
      new IndexBandFeedSource({
        log,
        published: {
          current: async () => view(publication(bands), '1'.repeat(64)),
        },
        baseUrl: BASE,
        torrents: torrentsOf(() => 100),
      });
    const [a, b] = await Promise.all([
      make().snapshot({ index: 'parquet-l1' }),
      make().snapshot({ index: 'parquet-l1' }),
    ]);
    assert.equal(a?.version, b?.version);
  });
});
