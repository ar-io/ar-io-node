/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';

import { StandaloneSqliteDatabaseWorker } from '../database/standalone-sqlite.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  bundlesDbPath,
  chunksDb,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';

const log = createTestLogger();

/**
 * chunks.db is deliberately isolated -- it is not ATTACHed in either direction,
 * so it never rides another database's checkpoint, and it had no WAL cleanup
 * worker at all before the chunk data cache index (ADR 005) put a high-write
 * table in it. These guard that `cleanupWal` can actually name it.
 */
describe('cleanupWal database targeting', () => {
  let worker: StandaloneSqliteDatabaseWorker;

  before(() => {
    worker = new StandaloneSqliteDatabaseWorker({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
  });

  it('checkpoints chunks.db', () => {
    const result = worker.cleanupWal('chunks');

    // wal_checkpoint(TRUNCATE) returns {busy, log, checkpointed}; busy must be
    // 0, otherwise the WAL was not actually truncated and it keeps growing.
    assert.ok(result !== undefined);
    assert.equal((result as any).busy, 0);
  });

  it('truncates chunks.db WAL on disk, and targets chunks.db alone', () => {
    // Dirty chunks.db so it has WAL content to reclaim.
    for (let i = 0; i < 500; i++) {
      chunksDb
        .prepare(
          `INSERT INTO chunk_data_cache
             (data_root, size, chunk_count, last_write, last_access, tier)
           VALUES (?, 1, 1, 1, 1, 0)
           ON CONFLICT (data_root) DO NOTHING`,
        )
        .run(`wal-test-${i}`);
    }
    const walPath = `${chunksDbPath}-wal`;
    const before = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    assert.ok(before > 0, 'expected a non-empty WAL to reclaim');

    // data.db must be untouched by a chunks checkpoint. Capturing it proves the
    // dbName selects the database, not just any handle the worker holds.
    const dataWalPath = `${dataDbPath}-wal`;
    const dataBefore = fs.existsSync(dataWalPath)
      ? fs.statSync(dataWalPath).size
      : 0;

    worker.cleanupWal('chunks');

    const after = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    assert.ok(
      after < before,
      `chunks.db WAL not truncated: ${before} -> ${after}`,
    );
    const dataAfter = fs.existsSync(dataWalPath)
      ? fs.statSync(dataWalPath).size
      : 0;
    assert.equal(dataAfter, dataBefore, 'a chunks checkpoint touched data.db');
  });

  // NOTE: the pre-existing databases are not checkpointed here. The shared test
  // harness keeps core/data/bundles/moderation open and ATTACHed to each other,
  // so TRUNCATE blocks with SQLITE_LOCKED. chunks.db checkpoints cleanly
  // precisely because it is ATTACHed to nothing -- the same isolation that
  // leaves it out of every other checkpoint and motivated this worker.
});
