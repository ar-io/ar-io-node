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
import { RootDatabase, RootDatabaseOptionsWithPath, open } from 'lmdb';
import winston from 'winston';

import { KVBufferStore } from '../types';

export class LmdbKVStore implements KVBufferStore {
  private log: winston.Logger;
  private db: RootDatabase<Buffer, string>;

  constructor({
    log,
    lmdbOptions,
  }: {
    log: winston.Logger;
    lmdbOptions: Pick<
      RootDatabaseOptionsWithPath,
      'compression' | 'mapSize' | 'noSync' | 'path'
    >;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.log.info('Opening LMDB database', { lmdbOptions });
    this.db = open({
      ...lmdbOptions,
      encoding: 'binary',
    });
  }

  async get(key: string): Promise<Buffer | undefined> {
    if (await this.has(key)) {
      return this.db.getBinary(key);
    }
    return undefined;
  }

  async has(key: string): Promise<boolean> {
    return this.db.doesExist(key);
  }

  async del(key: string): Promise<void> {
    if (await this.has(key)) {
      await this.db.remove(key);
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    if (!(await this.has(key))) {
      await this.db.put(key, buffer);
    }
  }
}
