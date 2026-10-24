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
