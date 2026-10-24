/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { StandaloneSqliteDatabase } from './standalone-sqlite.js';
import wait from '../lib/wait.js';
import { createTestLogger } from '../../test/test-logger.js';

const SCHEMAS = ['core', 'data', 'moderation', 'bundles', 'chunks'] as const;

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A scratch directory with one database file per schema. With
 * `migrated: false` the files are left for better-sqlite3 to create empty,
 * as a fresh checkout's `data/sqlite/` is, so every worker's constructor
 * fails in `prepare()`.
 */
function dbPaths({ migrated }: { migrated: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-io-sqlite-stop-'));
  tmpDirs.push(dir);
  if (migrated) {
    for (const name of SCHEMAS) {
      const db = new Sqlite(path.join(dir, `${name}.db`));
      try {
        // Already WAL, as a gateway's databases are after their first run.
        // Left to the workers, all of them switch a fresh file at once, and
        // one can lose that race with SQLITE_BUSY and die at startup.
        db.pragma('journal_mode = WAL');
        db.exec(fs.readFileSync(`test/${name}-schema.sql`, 'utf8'));
      } finally {
        db.close();
      }
    }
  }
  return {
    coreDbPath: path.join(dir, 'core.db'),
    dataDbPath: path.join(dir, 'data.db'),
    moderationDbPath: path.join(dir, 'moderation.db'),
    bundlesDbPath: path.join(dir, 'bundles.db'),
    chunksDbPath: path.join(dir, 'chunks.db'),
  };
}

function liveWorkerCount(db: StandaloneSqliteDatabase): number {
  return db['liveWorkers'].size;
}

describe('StandaloneSqliteDatabase.stop', () => {
  it('resolves only once every worker thread has exited', async () => {
    const db = new StandaloneSqliteDatabase({
      log: createTestLogger({ suite: 'StandaloneSqliteDatabase.stop' }),
      ...dbPaths({ migrated: true }),
      tagSelectivity: {},
    });
    assert.ok(liveWorkerCount(db) > 0);

    // The workers are up and serving.
    assert.equal(await db.getMaxHeight(), -1);

    await db.stop();

    assert.equal(liveWorkerCount(db), 0);
  });

  it('stops workers that cannot start instead of respawning them', async () => {
    const db = new StandaloneSqliteDatabase({
      log: createTestLogger({ suite: 'StandaloneSqliteDatabase.stop' }),
      ...dbPaths({ migrated: false }),
      tagSelectivity: {},
    });
    const spawned = liveWorkerCount(db);
    assert.ok(spawned > 0);

    // Before stop() a worker that dies at startup is respawned, so the pool
    // keeps its size; stop() must still resolve, and leave nothing running.
    await db.stop();
    assert.equal(liveWorkerCount(db), 0);

    // Long enough for a respawned worker to have been created and counted.
    await wait(500);
    assert.equal(liveWorkerCount(db), 0);
  });
});
