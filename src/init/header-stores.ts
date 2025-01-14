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
import { KvBlockStore } from '../store/kv-block-store.js';
import { KvTransactionStore } from '../store/kv-transaction-store.js';
import { FsBlockStore } from '../store/fs-block-store.js';
import { FsTransactionStore } from '../store/fs-transaction-store.js';
import { KvSignatureStore } from '../store/kv-signature-store.js';

const createKvBufferStore = ({
  pathKey,
  type,
  log,
  redisUrl = config.REDIS_CACHE_URL,
  redisTtlSeconds = config.REDIS_CACHE_TTL_SECONDS,
}: {
  pathKey: string;
  type: string;
  log: winston.Logger;
  redisUrl?: string;
  redisTtlSeconds?: number;
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
        redisUrl,
        ttlSeconds: redisTtlSeconds,
        log,
      });
    }
    case 'fs': {
      return new FsKVStore({
        baseDir: `data/headers/${pathKey}`,
        tmpDir: `data/tmp/${pathKey}`,
      });
    }

    default: {
      throw new Error(`Invalid chain cache type: ${type}`);
    }
  }
};

export const makeBlockStore = ({
  log,
  type,
}: {
  log: winston.Logger;
  type: string;
}) => {
  const pathKey = 'partial-blocks';
  if (type === 'fs') {
    log.info('Using FsBlockStore');
    return new FsBlockStore({
      log,
      baseDir: `data/headers/${pathKey}`,
      tmpDir: `data/tmp/${pathKey}`,
    });
  } else {
    return new KvBlockStore({
      log,
      kvBufferStore: createKvBufferStore({
        log,
        pathKey,
        type: config.CHAIN_CACHE_TYPE,
      }),
    });
  }
};

export const makeTxStore = ({
  log,
  type,
}: {
  log: winston.Logger;
  type: string;
}) => {
  const pathKey = 'partial-txs';
  if (type === 'fs') {
    log.info('Using FsTransactionStore');
    return new FsTransactionStore({
      log,
      baseDir: `data/headers/${pathKey}`,
      tmpDir: `data/tmp/${pathKey}`,
    });
  } else {
    return new KvTransactionStore({
      log,
      kvBufferStore: createKvBufferStore({
        log,
        pathKey,
        type: config.CHAIN_CACHE_TYPE,
      }),
    });
  }
};

export const makeSignatureStore = ({ log }: { log: winston.Logger }) => {
  return new KvSignatureStore({
    log,
    kvBufferStore: createKvBufferStore({
      log,
      pathKey: 'signatures',
      type: config.CHAIN_CACHE_TYPE,
      redisTtlSeconds: 60 * 60 * 4, // 4 hours
    }),
  });
};
