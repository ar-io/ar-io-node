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

import * as config from '../config.js';
import { FsKVStore } from '../store/fs-kv-store.js';
import { LmdbKVStore } from '../store/lmdb-kv-store.js';
import { RedisKvStore } from '../store/redis-kv-store.js';
import { KVBufferStore } from '../types.js';

export const getKvBufferStore = ({
  pathKey,
  type,
  log,
}: {
  pathKey: string;
  type: string;
  log: winston.Logger;
}): KVBufferStore => {
  log.info(`Using ${type} for KVBufferStore for ${pathKey}`);
  switch (type) {
    case 'lmdb': {
      return new LmdbKVStore({
        dbPath: `data/lmdb/${pathKey}`,
      });
    }
    case 'redis': {
      return new RedisKvStore({
        redisUrl: config.REDIS_CACHE_URL,
        ttlSeconds: config.REDIS_CACHE_TTL_SECONDS,
        log,
      });
    }
    case 'fs': {
      return new FsKVStore({
        baseDir: `data/headers/${pathKey}`,
        tmpDir: `data/tmp/${pathKey}`,
      });
    }

    // TODO: implement redis
    default: {
      throw new Error(`Invalid chain cache type: ${type}`);
    }
  }
};
