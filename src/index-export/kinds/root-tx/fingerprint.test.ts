/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { BandRecord } from '../../../lib/index-band/build.js';
import {
  BandFingerprint,
  combineFingerprints,
  compareFingerprints,
  fingerprintBand,
  FINGERPRINT_VERSION,
  recordsDigest,
  subRanges,
  withoutSources,
} from './fingerprint.js';
import { newSourceStats, RecordSource } from './sources/rows.js';

const record = (n: number, more: Partial<BandRecord> = {}): BandRecord => ({
  id: Buffer.alloc(32, n),
  rootTxId: Buffer.alloc(32, 200),
  height: 100_000 + n,
  rootOffset: n * 1000,
  rootDataOffset: n * 1000 + 100,
  size: 900,
  source: 'gw1',
  ...more,
});

async function* from(records: BandRecord[]) {
  yield* records;
}

const source = (
  name: string,
  records: () => BandRecord[],
  more: Partial<RecordSource> = {},
): RecordSource => ({
  name,
  rank: 0,
  stats: newSourceStats(),
  stableHeight: async () => 200_000,
  async *records(lo: number, hi: number) {
    for (const r of records()) {
      if ((r.height ?? 0) >= lo && (r.height ?? 0) <= hi) yield r;
    }
  },
  close: async () => undefined,
  ...more,
});

const band = (
  sources: Record<string, Record<string, string>>,
  identity = (name: string) => `${name} rank 0`,
): BandFingerprint => ({
  version: FINGERPRINT_VERSION,
  sources: Object.fromEntries(
    Object.entries(sources).map(([name, ranges]) => [
      name,
      { identity: identity(name), ranges },
    ]),
  ),
});

describe('subRanges', () => {
  it('cuts a band into its 5,000-height sub-ranges', () => {
    assert.deepEqual(subRanges(2_000_000, 2_004_999), [[2_000_000, 2_004_999]]);
    const h = subRanges(2_000_000, 2_099_999);
    assert.equal(h.length, 20);
    assert.deepEqual(h[1], [2_005_000, 2_009_999]);
    assert.deepEqual(h[19], [2_095_000, 2_099_999]);
  });
});

describe('recordsDigest', () => {
  it('is the same for the same records in any order, and changes with any field', async () => {
    const records = [record(1), record(2), record(3)];
    const digest = await recordsDigest(from(records));
    assert.equal(await recordsDigest(from([...records].reverse())), digest);
    for (const changed of [
      { rootOffset: 1 },
      { rootDataOffset: 99 },
      { size: 1 },
      { height: 1 },
      { rootTxId: Buffer.alloc(32, 9) },
      { rank: 1 as const },
      { coverageTo: 200_000, rank: 1 as const },
      { source: 'gw2' },
      { sampleTag: 'repaired' },
    ]) {
      assert.notEqual(
        await recordsDigest(from([record(1, changed), record(2), record(3)])),
        digest,
        JSON.stringify(changed),
      );
    }
    assert.notEqual(
      await recordsDigest(from([...records, record(2)])),
      digest,
      'a record given twice',
    );
  });
});

describe('fingerprintBand', () => {
  it("takes a source's own fingerprint, else digests its records, per sub-range", async () => {
    const rows = [record(1), record(6000)];
    const asked: Array<[number, number]> = [];
    const { fingerprint, failed } = await fingerprintBand(
      [
        source('ch', () => rows, {
          identity: 'clickhouse http://ch user u',
          fingerprint: async (lo, hi) => {
            asked.push([lo, hi]);
            return `fp ${lo}`;
          },
        }),
        source('sqlite', () => rows),
      ],
      100_000,
      109_999,
    );
    assert.deepEqual(failed, {});
    assert.deepEqual(asked, [
      [100_000, 104_999],
      [105_000, 109_999],
    ]);
    assert.deepEqual(fingerprint.sources.ch, {
      identity: 'ch rank 0 clickhouse http://ch user u',
      ranges: { 100000: 'fp 100000', 105000: 'fp 105000' },
    });
    assert.match(fingerprint.sources.sqlite.ranges[100000], /^records 1 /);
  });

  it('leaves out a source that fails, naming it', async () => {
    const { fingerprint, failed } = await fingerprintBand(
      [
        source('ch', () => [], {
          fingerprint: async () => {
            throw new Error('Code: 241 memory');
          },
        }),
      ],
      100_000,
      104_999,
    );
    assert.deepEqual(fingerprint.sources, {});
    assert.match(failed.ch, /Code: 241/);
  });
});

describe('compareFingerprints', () => {
  const recorded = band({ gw1: { 1: 'a' }, bundler: { 1: 'b' } });

  it('finds the same sources the same', () => {
    assert.deepEqual(
      compareFingerprints(
        recorded,
        band({ bundler: { 1: 'b' }, gw1: { 1: 'a' } }),
      ),
      { verdict: 'same_sources' },
    );
  });

  it('calls any difference a change', () => {
    for (const [current, more, pattern] of [
      [band({ gw1: { 1: 'x' }, bundler: { 1: 'b' } }), {}, /gw1 changed/],
      [
        band({ gw1: { 1: 'a', 2: 'a' }, bundler: { 1: 'b' } }),
        {},
        /gw1 changed/,
      ],
      [
        band({ gw1: { 1: 'a' }, bundler: { 1: 'b' } }, (n) => `${n} rank 1`),
        {},
        /changed/,
      ],
      [
        band({ gw1: { 1: 'a' }, bundler: { 1: 'b' }, gw2: { 1: 'c' } }),
        {},
        /gw2 is new/,
      ],
      [band({ gw1: { 1: 'a' } }), {}, /bundler is no longer a source/],
      [
        band({ gw1: { 1: 'a' } }),
        { failed: { bundler: 'EACCES' } },
        /bundler could not be fingerprinted: EACCES/,
      ],
    ] as const) {
      const result = compareFingerprints(recorded, current, more);
      assert.equal(result.verdict, 'changed');
      assert.match(result.detail ?? '', pattern);
    }
  });

  it('waits when only a source that is down differs, but not when another changed', () => {
    assert.deepEqual(
      compareFingerprints(recorded, band({ gw1: { 1: 'a' } }), {
        down: ['bundler'],
      }),
      { verdict: 'source_down', detail: 'bundler down' },
    );
    assert.equal(
      compareFingerprints(recorded, band({ gw1: { 1: 'x' } }), {
        down: ['bundler'],
      }).verdict,
      'changed',
    );
  });

  it('has nothing to compare with no record, or one of another version', () => {
    assert.equal(
      compareFingerprints(undefined, recorded).verdict,
      'unrecorded',
    );
    assert.deepEqual(
      compareFingerprints({ ...recorded, version: 0 }, recorded),
      {
        verdict: 'unrecorded',
        detail: `recorded under fingerprint version 0, now ${FINGERPRINT_VERSION}`,
      },
    );
  });
});

describe('combineFingerprints and withoutSources', () => {
  it("joins the d bands' sub-ranges per source, keeping only sources all share", () => {
    const combined = combineFingerprints([
      band({ gw1: { 100000: 'a' }, bundler: { 100000: 'b' } }),
      band({ gw1: { 105000: 'c' } }),
    ]);
    assert.deepEqual(combined, band({ gw1: { 100000: 'a', 105000: 'c' } }));
    assert.equal(
      combineFingerprints([band({ gw1: { 1: 'a' } }), undefined]),
      undefined,
    );
    assert.equal(
      combineFingerprints([{ ...band({ gw1: { 1: 'a' } }), version: 0 }]),
      undefined,
    );
  });

  it('drops the named sources', () => {
    assert.deepEqual(
      withoutSources(band({ gw1: { 1: 'a' }, gw2: { 1: 'b' } }), ['gw2']),
      band({ gw1: { 1: 'a' } }),
    );
  });
});
