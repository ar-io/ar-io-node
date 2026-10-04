/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { BandRecord } from '../../lib/index-band/build.js';
import { readBandRecordsCsv } from '../../lib/index-band/csv.js';
import {
  newSourceStats,
  RecordSource,
} from '../../index-export/kinds/root-tx/sources/rows.js';
import { createTestLogger } from '../../../test/test-logger.js';
import { indexBandExportCLICommand } from './indexExportCommands.js';

const log = createTestLogger({ suite: 'index-band-export' });
const id = (seed: number) => Buffer.alloc(32, seed);

/** A source over records in memory, recording what it was asked for. */
class MemorySource implements RecordSource {
  readonly name = 'memory';
  readonly rank = 0;
  readonly stats = newSourceStats();
  asked: Array<[number, number]> = [];
  closed = false;

  constructor(
    private readonly all: BandRecord[],
    private readonly failAfter?: number,
  ) {}

  async stableHeight() {
    return Math.max(...this.all.map((r) => r.height ?? 0));
  }

  async *records(from: number, to: number) {
    this.asked.push([from, to]);
    let given = 0;
    for (const record of this.all) {
      if (this.failAfter !== undefined && given === this.failAfter) {
        throw new Error('source failed');
      }
      const height = record.height ?? 0;
      if (height < from || height > to) continue;
      this.stats.records += 1;
      given += 1;
      yield record;
    }
  }

  async close() {
    this.closed = true;
  }
}

describe('index-band-export', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-band-export-'));
  });

  afterEach(async () => {
    delete process.env.AR_IO_NODE_CLI_DATA_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const records: BandRecord[] = [
    {
      id: id(1),
      rootTxId: id(100),
      height: 10,
      rootOffset: 64,
      rootDataOffset: 164,
      size: 500,
    },
    { id: id(2), rootTxId: id(101), height: 20 },
    { id: id(3), rootTxId: id(102), height: 30 },
  ];

  it('writes the range as CSV that index-band-build reads back, and reports it', async () => {
    const source = new MemorySource(records);
    const output = path.join(dir, 'out', 'records.csv');
    const result = (await indexBandExportCLICommand(
      { from: '10', to: '20', output },
      { log, source },
    )) as Record<string, unknown>;

    assert.deepEqual(source.asked, [[10, 20]]);
    assert.equal(source.closed, true);
    assert.equal(result.records, 2);
    assert.deepEqual(result.heightRange, [10, 20]);
    assert.equal(result.output, output);

    const back: BandRecord[] = [];
    for await (const record of readBandRecordsCsv(
      () => createReadStream(output),
      { skipHeader: true },
    )) {
      back.push(record);
    }
    assert.deepEqual(back, records.slice(0, 2));
    assert.deepEqual(await fs.readdir(path.join(dir, 'out')), ['records.csv']);
  });

  it('leaves no file, partial or whole, when the source fails', async () => {
    const source = new MemorySource(records, 1);
    const output = path.join(dir, 'records.csv');
    await assert.rejects(
      indexBandExportCLICommand(
        { from: '0', to: '100', output },
        { log, source },
      ),
      /source failed/,
    );
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal(source.closed, true);
  });

  it('replaces an existing output only with --force', async () => {
    const output = path.join(dir, 'records.csv');
    await fs.writeFile(output, 'keep me');
    await assert.rejects(
      indexBandExportCLICommand(
        { from: '10', to: '20', output },
        { log, source: new MemorySource(records) },
      ),
      /exists; pass --force/,
    );
    assert.equal(await fs.readFile(output, 'utf8'), 'keep me');
    await indexBandExportCLICommand(
      { from: '10', to: '20', output, force: true },
      { log, source: new MemorySource(records) },
    );
    assert.match(await fs.readFile(output, 'utf8'), /^data_item_id,/);
  });

  it('refuses bad heights, a missing output, and output outside the mount', async () => {
    const source = new MemorySource(records);
    const run = (options: Record<string, string>) =>
      indexBandExportCLICommand(options, { log, source });
    await assert.rejects(run({ to: '5', output: 'x' }), /--from is required/);
    await assert.rejects(
      run({ from: '-1', to: '5', output: 'x' }),
      /--from must be a block height/,
    );
    await assert.rejects(
      run({ from: '6', to: '5', output: 'x' }),
      /below --from/,
    );
    await assert.rejects(run({ from: '1', to: '5' }), /--output is required/);
    process.env.AR_IO_NODE_CLI_DATA_DIR = path.join(dir, 'indexes');
    await assert.rejects(
      run({ from: '1', to: '5', output: path.join(dir, 'elsewhere.csv') }),
      /outside data\/indexes/,
    );
  });

  it('opens the source named by --source', async () => {
    await fs.mkdir(path.join(dir, 'overlay'));
    await fs.writeFile(
      path.join(dir, 'overlay', '10-19.csv'),
      `${id(1).toString('base64url')},${id(100).toString('base64url')},,64,164,500,15\n`,
    );
    const output = path.join(dir, 'records.csv');
    const result = (await indexBandExportCLICommand(
      {
        source: JSON.stringify({
          type: 'csv',
          name: 'bundler',
          path: path.join(dir, 'overlay'),
        }),
        from: '0',
        to: '100',
        output,
      },
      { log, env: {} },
    )) as Record<string, unknown>;
    assert.equal(result.source, 'bundler');
    assert.equal(result.rank, 1);
    assert.equal(result.records, 1);
  });
});
