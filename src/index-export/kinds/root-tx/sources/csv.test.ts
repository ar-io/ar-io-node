/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { BandRecord } from '../../../../lib/index-band/build.js';
import { writeBandRecordsCsv } from '../../../../lib/index-band/csv.js';
import { toB64Url } from '../../../../lib/encoding.js';
import { CsvOverlaySource, listOverlayFiles } from './csv.js';

const id = (seed: number) => Buffer.alloc(32, seed);
const line = (seed: number, height: number, offset = 1000) =>
  `${toB64Url(id(seed))},${toB64Url(id(200))},,${offset},${offset + 100},500,${height}`;

const collect = async (records: AsyncIterable<BandRecord>) => {
  const out: BandRecord[] = [];
  for await (const record of records) out.push(record);
  return out;
};

describe('CsvOverlaySource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-export-overlay-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]) =>
    fs.writeFile(path.join(dir, name), lines.join('\n') + '\n');

  it('lists coverage-named files only, skipping temp and dot files', async () => {
    await write('100-199.csv', []);
    await write('200-299.csv.tmp', []);
    await write('300-399.csv.partial', []);
    await write('.400-499.csv', []);
    await write('notes.csv', []);
    await write('600-500.csv', []);
    await write('500-599.csv', []);
    assert.deepEqual(
      (await listOverlayFiles(dir)).map((f) => [f.name, f.from, f.to]),
      [
        ['100-199.csv', 100, 199],
        ['500-599.csv', 500, 599],
      ],
    );
  });

  it('gives rank-1 records, only inside each file coverage and the range asked for', async () => {
    await write('100-199.csv', [
      line(1, 150),
      line(2, 99), // below its file's coverage
      line(3, 250), // above it
      `${toB64Url(id(4))},${toB64Url(id(200))},,1000,1100,500,`, // no height
    ]);
    await write('200-299.csv', [line(5, 250), line(6, 290)]);
    const source = new CsvOverlaySource('bundler', dir);
    const records = await collect(source.records(120, 260));
    assert.deepEqual(
      records.map((r) => r.id[0]),
      [1, 5],
    );
    for (const record of records) {
      assert.equal(record.rank, 1);
      assert.equal(record.source, 'bundler');
    }
    assert.deepEqual(
      records.map((r) => r.coverageTo),
      [199, 299],
    );
    assert.deepEqual(source.stats.dropped, {
      outside_coverage: 2,
      no_height: 1,
    });
    assert.equal(source.stats.records, 2);
  });

  it('skips files whose coverage misses the range without reading them', async () => {
    await write('100-199.csv', [line(1, 150)]);
    await write('300-399.csv', ['not,a,valid,file']);
    const source = new CsvOverlaySource('bundler', dir);
    assert.equal((await collect(source.records(100, 250))).length, 1);
  });

  it('fails the read on a malformed row, naming the overlay and file', async () => {
    await write('100-199.csv', ['not,a,valid,file']);
    const source = new CsvOverlaySource('bundler', dir);
    await assert.rejects(
      collect(source.records(100, 199)),
      /Overlay bundler, .*100-199\.csv: Line 1/,
    );
  });

  it('refuses overlapping files rather than choose between them', async () => {
    await write('100-199.csv', [line(1, 150)]);
    await write('150-250.csv', [line(1, 160)]);
    const source = new CsvOverlaySource('bundler', dir);
    await assert.rejects(
      collect(source.records(100, 300)),
      /100-199\.csv and 150-250\.csv overlap/,
    );
  });

  it('reads a file saved with a byte-order mark, header and all', async () => {
    await fs.writeFile(
      path.join(dir, '100-199.csv'),
      '\uFEFF' +
        (await text(
          writeBandRecordsCsv([{ id: id(1), rootTxId: id(200), height: 150 }]),
        )),
    );
    await write('200-299.csv', ['\uFEFF' + line(2, 250)]);
    const records = await collect(
      new CsvOverlaySource('bundler', dir).records(100, 299),
    );
    assert.deepEqual(
      records.map((r) => r.id[0]),
      [1, 2],
    );
  });

  it('reads files written by writeBandRecordsCsv, header included', async () => {
    const records: BandRecord[] = [
      {
        id: id(1),
        rootTxId: id(200),
        rootOffset: 1000,
        rootDataOffset: 1100,
        size: 500,
        height: 150,
      },
      { id: id(2), rootTxId: id(201), height: 151 },
    ];
    await fs.writeFile(
      path.join(dir, '100-199.csv'),
      await text(writeBandRecordsCsv(records)),
    );
    const back = await collect(
      new CsvOverlaySource('bundler', dir).records(100, 199),
    );
    assert.deepEqual(
      back.map(({ rank, source, coverageTo, ...rest }) => rest),
      records,
    );
  });

  it('reports the top of its coverage, or -1 with no files', async () => {
    const source = new CsvOverlaySource('bundler', dir);
    assert.equal(await source.stableHeight(), -1);
    await write('100-199.csv', []);
    await write('200-250.csv', []);
    assert.equal(await source.stableHeight(), 250);
  });

  it('prunes files wholly within the range written before the band, and no others', async () => {
    await write('50-99.csv', [line(1, 60)]);
    await write('100-199.csv', [line(2, 150)]);
    await write('200-299.csv', [line(3, 250)]);
    await write('300-399.csv', [line(4, 350)]);
    await write('scratch.csv.tmp', []);
    const builtAt = Date.now();
    const before = new Date(builtAt - 3600_000);
    for (const name of ['50-99.csv', '100-199.csv', '300-399.csv']) {
      await fs.utimes(path.join(dir, name), before, before);
    }
    // 200-299.csv was replaced after the band was built: never read into it.
    const after = new Date(builtAt + 60_000);
    await fs.utimes(path.join(dir, '200-299.csv'), after, after);
    const source = new CsvOverlaySource('bundler', dir);
    assert.deepEqual(await source.prune(100, 350, builtAt), ['100-199.csv']);
    assert.deepEqual((await fs.readdir(dir)).sort(), [
      '200-299.csv',
      '300-399.csv',
      '50-99.csv',
      'scratch.csv.tmp',
    ]);
  });

  it('reports the age of its newest file', async () => {
    const source = new CsvOverlaySource('bundler', dir);
    assert.equal(await source.ageSeconds(), undefined);
    await write('100-199.csv', []);
    const old = new Date(Date.now() - 3600 * 1000);
    await fs.utimes(path.join(dir, '100-199.csv'), old, old);
    await write('200-299.csv', []);
    const twoHoursAgo = new Date(Date.now() - 7200 * 1000);
    await fs.utimes(path.join(dir, '200-299.csv'), twoHoursAgo, twoHoursAgo);
    const age = await source.ageSeconds();
    assert.ok(age !== undefined && age > 3590 && age < 3700, `age ${age}`);
  });
});
