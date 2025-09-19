/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxOffsetSource, TxOffsetResult } from '../types.js';
import { StandaloneSqliteDatabase } from '../database/standalone-sqlite.js';

/**
 * Database-backed transaction offset source.
 * Retrieves transaction information by offset from the local database.
 */
export class DatabaseTxOffsetSource implements TxOffsetSource {
  private log: winston.Logger;
  private db: StandaloneSqliteDatabase;

  constructor({
    log,
    db,
  }: {
    log: winston.Logger;
    db: StandaloneSqliteDatabase;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.db = db;
  }

  async getTxByOffset(offset: number): Promise<TxOffsetResult> {
    const log = this.log.child({ method: 'getTxByOffset', offset });

    try {
      log.debug('Attempting database lookup');
      const result = await this.db.getTxByOffset(offset);
      log.debug('Database lookup completed', {
        hasResult: result !== undefined,
        hasDataRoot: result?.data_root !== undefined,
        hasId: result?.id !== undefined,
      });
      return result;
    } catch (error: any) {
      log.debug('Database lookup failed', { error: error.message });
      throw error;
    }
  }
}
