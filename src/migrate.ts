/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Sqlite from 'better-sqlite3';
import fs from 'node:fs';
import { Umzug, UmzugStorage } from 'umzug';

function extractDbName(path: string) {
  return (path.match(/.*\.([^.]+)\..+\.sql/) || [])[1];
}

function toDownPath(path: string) {
  return path.replace(/^(.*)\/([^/]*)$/, '$1/down/$2');
}

class Storage implements UmzugStorage {
  ensureMigrationsTable(db: Sqlite.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async logMigration({ name: migrationName }: { name: string }): Promise<void> {
    const db = new Sqlite(`data/sqlite/core.db`);
    try {
      this.ensureMigrationsTable(db);
      db.exec(`INSERT INTO migrations (name) VALUES ('${migrationName}')`);
    } finally {
      db.close();
    }
  }

  async unlogMigration({
    name: migrationName,
  }: {
    name: string;
  }): Promise<void> {
    const db = new Sqlite(`data/sqlite/core.db`);
    try {
      this.ensureMigrationsTable(db);
      db.exec(`DELETE FROM migrations WHERE name='${migrationName}'`);
    } finally {
      db.close();
    }
  }

  async executed(): Promise<string[]> {
    const db = new Sqlite(`data/sqlite/core.db`);
    try {
      this.ensureMigrationsTable(db);
      const rows = db.prepare('SELECT name FROM migrations').all();
      return rows.map((row) => row.name);
    } finally {
      db.close();
    }
  }
}

const umzug = new Umzug({
  migrations: {
    glob: 'migrations/*.sql',
    resolve: (params) => {
      const path = params.path as string;
      if (!path?.endsWith('.sql')) {
        return Umzug.defaultResolver(params);
      }
      return {
        name: params.name,
        up: async () => {
          const sql = fs.readFileSync(path).toString();
          const dbname = extractDbName(path);
          const db = new Sqlite(`data/sqlite/${dbname}.db`);
          try {
            return db.exec(sql);
          } finally {
            db.close();
          }
        },
        down: async () => {
          const downPath = toDownPath(path);
          const dbname = extractDbName(downPath);
          const sql = fs.readFileSync(downPath).toString();
          const db = new Sqlite(`data/sqlite/${dbname}.db`);
          try {
            return db.exec(sql);
          } finally {
            db.close();
          }
        },
      };
    },
  },
  storage: new Storage(),
  logger: console,
});

umzug.runAsCLI();
