/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { TxBoundary, TxBoundarySource } from '../types.js';
import { StandaloneSqliteDatabase } from '../database/standalone-sqlite.js';

/**
 * Database-backed transaction boundary source.
 * Retrieves transaction boundaries by offset from the local database.
 * This is the fastest lookup strategy when the transaction is indexed.
 */
export class DatabaseTxBoundarySource implements TxBoundarySource {
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

  async getTxBoundary(absoluteOffset: bigint): Promise<TxBoundary | null> {
    const log = this.log.child({
      method: 'getTxBoundary',
      absoluteOffset: absoluteOffset.toString(),
    });

    try {
      log.debug('Attempting database lookup');
      const result = await this.db.getTxByOffset(Number(absoluteOffset));

      // Check if result has all required fields
      if (
        result.data_root === undefined ||
        result.offset === undefined ||
        result.data_size === undefined
      ) {
        log.debug('Database lookup returned incomplete result', {
          hasDataRoot: result.data_root !== undefined,
          hasOffset: result.offset !== undefined,
          hasDataSize: result.data_size !== undefined,
        });
        return null;
      }

      log.debug('Database lookup completed', {
        txId: result.id,
        dataRoot: result.data_root,
      });

      return {
        id: result.id,
        dataRoot: result.data_root,
        dataSize: result.data_size,
        weaveOffset: result.offset,
      };
    } catch (error: any) {
      log.debug('Database lookup failed', { error: error.message });
      throw error;
    }
  }
}
