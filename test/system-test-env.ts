/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Side-effect module for test files that import `src/system.ts`.
 *
 * Import it FIRST, before anything that loads `system.ts`:
 *
 * ```ts
 * import { systemTestDir } from '../../../test/system-test-env.js';
 * ```
 *
 * `system.ts` opens its SQLite databases at the fixed relative paths
 * `data/sqlite/*.db` and writes LMDB, header and cache files under `data/`.
 * In a fresh checkout (CI) those databases do not exist, so better-sqlite3
 * creates them empty and every StandaloneSqlite worker throws from
 * `prepare()` in its constructor ("no such table"), exits with code 1 and is
 * respawned -- a crash loop that runs for the life of the test file. A worker
 * that dies or is torn down while inside a native addon can abort the whole
 * process under Node 22, after every test in the file has passed.
 *
 * This module moves the process into a fresh temporary directory whose
 * `data/sqlite/` holds databases built from the checked-in test schemas
 * (`test/*-schema.sql`, kept current by `test/dump-test-schemas`), so the
 * workers start cleanly, and nothing `system.ts` writes lands in the
 * checkout's own `data/`. Test files run one per process, so the `chdir`
 * affects only the importing file. The importing file should remove
 * {@link systemTestDir} in an `after` hook once `system.ts` is stopped.
 */
import Sqlite from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(testDir);

const SCHEMAS = ['core', 'data', 'moderation', 'bundles', 'chunks'] as const;

/** The temporary directory the process now runs in. */
export const systemTestDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ar-io-system-test-'),
);

const sqliteDir = path.join(systemTestDir, 'data', 'sqlite');
fs.mkdirSync(sqliteDir, { recursive: true });
for (const name of SCHEMAS) {
  const db = new Sqlite(path.join(sqliteDir, `${name}.db`));
  try {
    db.exec(fs.readFileSync(path.join(testDir, `${name}-schema.sql`), 'utf8'));
  } finally {
    db.close();
  }
}

// Worker threads inherit `--import ./register.js` from the test script, and
// register.js resolves `ts-node/esm` against the working directory, so both
// must resolve from the new one.
for (const name of ['register.js', 'node_modules', 'tsconfig.json']) {
  fs.symlinkSync(path.join(repoDir, name), path.join(systemTestDir, name));
}

process.chdir(systemTestDir);
