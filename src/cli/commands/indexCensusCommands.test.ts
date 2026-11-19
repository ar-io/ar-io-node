/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Sqlite from 'better-sqlite3';

import { createTestLogger } from '../../../test/test-logger.js';
import type { ClickHouseQuerier } from '../../index-export/kinds/root-tx/sources/clickhouse.js';
import { MAX_HEIGHT_QUERY } from '../../lib/index-census/census.js';
import { indexCensusCLICommand } from './indexCensusCommands.js';

/** An empty ClickHouse: top height 0, no rows for anything else. */
const emptyClickHouse = (): ClickHouseQuerier => ({
  async query({ query }) {
    const rows = query === MAX_HEIGHT_QUERY ? [{ top: 0 }] : [];
    return {
      async *stream() {
        yield rows.map((row) => ({
          text: JSON.stringify(row),
          json: <T>() => row as T,
        }));
      },
    };
  },
  async close() {},
});

describe('indexCensusCLICommand', () => {
  const log = createTestLogger({ suite: 'indexCensusCLICommand' });
  let dir: string;
  let bundlesDb: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-census-cli-'));
    bundlesDb = path.join(dir, 'bundles.db');
    const db = new Sqlite(bundlesDb);
    db.exec(`
      CREATE TABLE bundles (id BLOB PRIMARY KEY, root_transaction_id BLOB,
        index_filter_id INTEGER, matched_data_item_count INTEGER,
        last_queued_at INTEGER, last_unbundled_at INTEGER,
        last_fully_indexed_at INTEGER);
      CREATE TABLE bundle_data_items (id BLOB, parent_id BLOB,
        parent_index INTEGER, filter_id INTEGER, root_transaction_id BLOB,
        first_indexed_at INTEGER, last_indexed_at INTEGER);
    `);
    db.close();
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates a missing output directory and writes the header', async () => {
    const output = path.join(dir, 'census', 'nested', 'short-roots.tsv');
    const result = (await indexCensusCLICommand(
      { bundlesDb, output },
      { log, clickhouse: emptyClickHouse() },
    )) as { output: string };
    assert.equal(result.output, output);
    assert.match(fs.readFileSync(output, 'utf8'), /^root\theight\t/);
  });

  it('refuses an output that a symlink leads out of the data root', async () => {
    const dataRoot = path.join(dir, 'indexes');
    const elsewhere = path.join(dir, 'sqlite');
    fs.mkdirSync(dataRoot);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'bundles.db'), 'sentinel');
    fs.symlinkSync(elsewhere, path.join(dataRoot, 'live'));
    const saved = process.env.AR_IO_NODE_CLI_DATA_DIR;
    process.env.AR_IO_NODE_CLI_DATA_DIR = dataRoot;
    try {
      for (const output of [
        path.join(dataRoot, 'live', 'bundles.db'),
        path.join(dataRoot, 'live', 'new', 'short-roots.tsv'),
        path.join(dir, 'short-roots.tsv'),
      ]) {
        await assert.rejects(
          indexCensusCLICommand(
            { bundlesDb, output },
            { log, clickhouse: emptyClickHouse() },
          ),
          /outside data\/indexes/,
        );
      }
      // Normalizes to data/indexes/sqlite/bundles.db; the filesystem would
      // follow live -> sqlite before the '..'. Written where it normalizes,
      // never over the sibling's bundles.db.
      const dotted = `${dataRoot}/live/../sqlite/bundles.db`;
      const result = (await indexCensusCLICommand(
        { bundlesDb, output: dotted, force: true },
        { log, clickhouse: emptyClickHouse() },
      )) as { output: string };
      assert.equal(result.output, path.join(dataRoot, 'sqlite', 'bundles.db'));
      assert.ok(fs.existsSync(result.output));
      assert.deepEqual(fs.readdirSync(elsewhere), ['bundles.db']);
      assert.equal(
        fs.readFileSync(path.join(elsewhere, 'bundles.db'), 'utf8'),
        'sentinel',
      );
      const inside = path.join(dataRoot, 'census', 'short-roots.tsv');
      await indexCensusCLICommand(
        { bundlesDb, output: inside },
        { log, clickhouse: emptyClickHouse() },
      );
      assert.ok(fs.existsSync(inside));
    } finally {
      if (saved === undefined) delete process.env.AR_IO_NODE_CLI_DATA_DIR;
      else process.env.AR_IO_NODE_CLI_DATA_DIR = saved;
    }
  });

  it('refuses a pre-existing partial path instead of following it', async () => {
    const target = path.join(dir, 'precious.db');
    fs.writeFileSync(target, 'sentinel');
    const output = path.join(dir, 'planted', 'short-roots.tsv');
    fs.mkdirSync(path.dirname(output));
    const planted = `${output}.${process.pid}.partial`;
    fs.symlinkSync(target, planted);
    await assert.rejects(
      indexCensusCLICommand(
        { bundlesDb, output },
        { log, clickhouse: emptyClickHouse() },
      ),
      /EEXIST/,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
    // Not created by this run, so not removed by its cleanup either.
    assert.ok(fs.lstatSync(planted).isSymbolicLink());
    assert.equal(fs.existsSync(output), false);
  });

  it('fails cleanly, leaving no partial file, when the output cannot be written', async () => {
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, '');
    const output = path.join(blocker, 'short-roots.tsv');
    await assert.rejects(
      indexCensusCLICommand(
        { bundlesDb, output },
        { log, clickhouse: emptyClickHouse() },
      ),
      /ENOTDIR|EEXIST/,
    );
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.partial')),
      [],
    );
  });
});
