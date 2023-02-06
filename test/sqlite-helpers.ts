import Sqlite from 'better-sqlite3';
import fs from 'fs';

import log from '../src/log.js';

export const coreDbPath = `test/tmp/core.db`;
export const dataDbPath = `test/tmp/data.db`;
export let coreDb: Sqlite.Database;
export let dataDb: Sqlite.Database;

/* eslint-disable */
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
});

afterEach(async () => {
  [coreDb, dataDb].forEach((db) => {
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .forEach((row) => {
        db.prepare(`DELETE FROM ${row.name}`).run();
      });
  });
});
