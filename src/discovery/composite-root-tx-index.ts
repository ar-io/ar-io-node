/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { DataItemRootTxIndex } from '../types.js';

export class CompositeRootTxIndex implements DataItemRootTxIndex {
  private log: winston.Logger;
  private indexes: DataItemRootTxIndex[];

  constructor({
    log,
    indexes,
  }: {
    log: winston.Logger;
    indexes: DataItemRootTxIndex[];
  }) {
    this.log = log.child({ class: this.constructor.name });

    if (indexes.length === 0) {
      throw new Error('At least one index must be provided');
    }

    this.indexes = indexes;
  }

  async getRootTxId(id: string): Promise<string | undefined> {
    const log = this.log.child({ method: 'getRootTxId', id });

    for (let i = 0; i < this.indexes.length; i++) {
      const index = this.indexes[i];

      try {
        log.debug('Trying index', {
          indexNumber: i + 1,
          totalIndexes: this.indexes.length,
          indexClass: index.constructor.name,
        });

        const rootTxId = await index.getRootTxId(id);

        if (rootTxId !== undefined) {
          log.debug('Found root TX ID', {
            rootTxId,
            indexNumber: i + 1,
            indexClass: index.constructor.name,
          });
          return rootTxId;
        }

        log.debug('Index returned undefined', {
          indexNumber: i + 1,
          indexClass: index.constructor.name,
        });
      } catch (error: any) {
        log.debug('Index failed with error', {
          indexNumber: i + 1,
          indexClass: index.constructor.name,
          error: error.message,
        });
        // Continue to next index
      }
    }

    log.debug('All indexes failed to find root TX ID', {
      id,
      triedIndexes: this.indexes.length,
    });

    return undefined;
  }
}
