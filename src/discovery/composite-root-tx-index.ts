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
