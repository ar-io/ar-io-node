/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
