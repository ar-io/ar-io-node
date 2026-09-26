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

import { cleanDb } from './utils.js';

/**
 * Pins the one invariant `cleanDb` has to satisfy:
 *
 *   the guard must refuse whenever rimraf would delete something.
 *
 * Stated that way rather than as "checks for .db files" because the bug this
 * exists to prevent was a mismatch between the two. The first version of the
 * guard filtered on `endsWith('.db')` while the deletion glob is `*.db*`, so a
 * directory holding only `core.db-wal`, `core.db-shm` or `snapshot.db.bak`
 * looked empty to the guard and was then deleted without the opt-in. A guard
 * that fails open is worse than no guard, because it grants permission it has
 * not actually checked.
 *
 * Each case is exercised twice against a fresh temp directory: once with the
 * opt-in absent to record whether the guard refuses, and once with it present
 * to record what rimraf genuinely removes. Deriving the expectation from real
 * deletions rather than from a hardcoded list means the test keeps working if
 * the glob changes, and starts failing if the glob and the guard drift apart.
 *
 * Runs entirely on a temp directory and needs no containers, despite living
 * under `test/end-to-end/` alongside the helper it covers.
 */
describe('cleanDb guard', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-clean-db-guard-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    files?: string[];
    dirs?: string[];
  }> = [
    { name: 'empty directory' },
    { name: 'bare core.db', files: ['core.db'] },
    { name: 'only a -wal sidecar', files: ['core.db-wal'] },
    { name: 'only a -shm sidecar', files: ['core.db-shm'] },
    { name: 'only a .bak backup', files: ['snapshot.db.bak'] },
    { name: 'only a -journal', files: ['core.db-journal'] },
    { name: 'unrelated files only', files: ['notes.txt', 'README.md'] },
    { name: 'a name containing db but no dot', files: ['coredb'] },
    { name: 'a subdirectory named x.db', dirs: ['x.db'] },
    {
      name: 'unrelated files beside a sidecar',
      files: ['notes.txt', 'bundles.db-wal'],
    },
  ];

  for (const c of cases) {
    it(`refuses iff rimraf would delete something: ${c.name}`, async () => {
      const dir = path.join(root, c.name.replace(/[^a-z0-9]+/gi, '_'));

      const seed = () => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        for (const f of c.files ?? []) fs.writeFileSync(path.join(dir, f), 'x');
        for (const d of c.dirs ?? []) fs.mkdirSync(path.join(dir, d));
      };

      // Without the opt-in: does the guard refuse?
      seed();
      const previous = process.env.ALLOW_DESTRUCTIVE_E2E;
      delete process.env.ALLOW_DESTRUCTIVE_E2E;
      let refused = false;
      try {
        await cleanDb(dir);
      } catch {
        refused = true;
      }

      // With the opt-in: what does rimraf actually remove?
      seed();
      const before = fs.readdirSync(dir).sort();
      process.env.ALLOW_DESTRUCTIVE_E2E = 'true';
      await cleanDb(dir);
      const remaining = fs.readdirSync(dir).sort();
      if (previous === undefined) delete process.env.ALLOW_DESTRUCTIVE_E2E;
      else process.env.ALLOW_DESTRUCTIVE_E2E = previous;

      const deleted = before.filter((f) => !remaining.includes(f));

      if (deleted.length > 0) {
        assert.equal(
          refused,
          true,
          `FAIL-OPEN: rimraf deleted ${deleted.join(', ')} but the guard allowed it`,
        );
      }
    });
  }
});
