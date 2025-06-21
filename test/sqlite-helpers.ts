/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';
import fs from 'node:fs';
import { afterEach, before } from 'node:test';

import log from '../src/log.js';

export const coreDbPath = `test/tmp/core.db`;
export const dataDbPath = `test/tmp/data.db`;
export const moderationDbPath = `test/tmp/moderation.db`;
export const bundlesDbPath = `test/tmp/bundles.db`;
export let coreDb: Sqlite.Database;
export let dataDb: Sqlite.Database;
export let moderationDb: Sqlite.Database;
export let bundlesDb: Sqlite.Database;

before(async () => {
  log.transports.forEach((t) => (t.silent = true));
  fs.readdirSync('test/tmp').forEach((file) => {
    if (file !== '.gitkeep') {
      fs.unlinkSync(`test/tmp/${file}`);
    }
  });

  // Core DB
  coreDb = new Sqlite(coreDbPath);
  const coreSchema = fs.readFileSync('test/core-schema.sql', 'utf8');
  coreDb.exec(coreSchema);

  // Data DB
  dataDb = new Sqlite(dataDbPath);
  const dataSchema = fs.readFileSync('test/data-schema.sql', 'utf8');
  dataDb.exec(dataSchema);

  // Moderation DB
  moderationDb = new Sqlite(moderationDbPath);
  const moderationSchema = fs.readFileSync(
    'test/moderation-schema.sql',
    'utf8',
  );
  moderationDb.exec(moderationSchema);

  // Bundles DB
  bundlesDb = new Sqlite(bundlesDbPath);
  const bundlesSchema = fs.readFileSync('test/bundles-schema.sql', 'utf8');
  bundlesDb.exec(bundlesSchema);
});

afterEach(async () => {
  [coreDb, dataDb, moderationDb, bundlesDb].forEach((db) => {
    db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND tbl_name != 'bundle_formats'",
    )
      .all()
      .forEach((row) => {
        db.prepare(`DELETE FROM ${row.name}`).run();
      });
  });
});
