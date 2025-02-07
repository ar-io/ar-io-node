/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import * as winston from 'winston';
import { StandaloneSqliteDatabase } from '../database/standalone-sqlite.js';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export class SQLiteWalCleanupWorker {
  private log: winston.Logger;
  private db: StandaloneSqliteDatabase;
  private dbName: 'core' | 'bundles' | 'data' | 'moderation';
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    db,
    dbName,
  }: {
    log: winston.Logger;
    db: StandaloneSqliteDatabase;
    dbName: 'core' | 'bundles' | 'data' | 'moderation';
  }) {
    this.log = log.child({ class: 'SQLiteWalCleanupWorker' });
    this.db = db;
    this.dbName = dbName;
  }

  start(): void {
    this.intervalId = setInterval(this.cleanup.bind(this), CLEANUP_INTERVAL_MS);
    this.log.info(
      `Started SQLite WAL cleanup worker for ${this.dbName} database`,
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.log.info(
      `Stopped SQLite WAL cleanup worker for ${this.dbName} database`,
    );
  }

  private async cleanup(): Promise<void> {
    try {
      await this.db.cleanupWal(this.dbName);
      this.log.info(`Cleaned up WAL for ${this.dbName} database`);
    } catch (error) {
      this.log.error(
        `Error cleaning up WAL for ${this.dbName} database`,
        error,
      );
    }
  }
}
