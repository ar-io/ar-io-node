import Sqlite from 'better-sqlite3';
import fs from 'fs';

import log from '../src/log.js';

export const coreDbPath = `test/tmp/core.db`;
export let coreDb: Sqlite.Database;

/* eslint-disable */
before(async () => {
  log.transports.forEach((t) => (t.silent = true));
  fs.readdirSync('test/tmp').forEach((file) => {
    fs.unlinkSync(`test/tmp/${file}`);
  });
  coreDb = new Sqlite(coreDbPath);
  const schema = fs.readFileSync('test/schema.sql', 'utf8');
  coreDb.exec(schema);
});

afterEach(async () => {
  coreDb
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()
    .forEach((row) => {
      coreDb.prepare(`DELETE FROM ${row.name}`).run();
    });
});
