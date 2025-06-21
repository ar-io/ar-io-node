/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
import { KvB64UrlStore } from '../store/kv-b64url-store.js';
import {
  KvDataItemAttributesStore,
  KvTransactionAttributesStore,
} from '../store/kv-attributes-store.js';

const createKvBufferStore = ({
  pathKey,
  type,
  log,
  redisUrl = config.REDIS_CACHE_URL,
  redisTtlSeconds = config.REDIS_CACHE_TTL_SECONDS,
  redisKeyPrefix,
}: {
  pathKey: string;
  type: string;
  log: winston.Logger;
  redisUrl?: string;
  redisTtlSeconds?: number;
  redisKeyPrefix?: string;
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
        keyPrefix: redisKeyPrefix,
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
    // NOTE: KvBlockStore handles its own key prefixing
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
        redisKeyPrefix: 'TH',
      }),
    });
  }
};

export const makeDataItemAttributesStore = ({
  log,
}: {
  log: winston.Logger;
}) => {
  return new KvDataItemAttributesStore({
    log,
    kvBufferStore: createKvBufferStore({
      log,
      pathKey: 'diAttributes',
      type: config.CHAIN_CACHE_TYPE,
      redisTtlSeconds: 60 * 60 * 4, // 4 hours
      redisKeyPrefix: 'DIA',
    }),
  });
};

export const makeTransactionAttributesStore = ({
  log,
}: {
  log: winston.Logger;
}) => {
  return new KvTransactionAttributesStore({
    log,
    kvBufferStore: createKvBufferStore({
      log,
      pathKey: 'txAttributes',
      type: config.CHAIN_CACHE_TYPE,
      redisTtlSeconds: 60 * 60 * 4, // 4 hours
      redisKeyPrefix: 'TXA',
    }),
  });
};

export const makeSignatureStore = ({ log }: { log: winston.Logger }) => {
  return new KvB64UrlStore({
    log,
    kvBufferStore: createKvBufferStore({
      log,
      pathKey: 'signatures',
      type: config.CHAIN_CACHE_TYPE,
      redisTtlSeconds: 60 * 60 * 4, // 4 hours
      redisKeyPrefix: 'SIG',
    }),
  });
};

export const makeOwnerStore = ({ log }: { log: winston.Logger }) => {
  return new KvB64UrlStore({
    log,
    kvBufferStore: createKvBufferStore({
      log,
      pathKey: 'owners',
      type: config.CHAIN_CACHE_TYPE,
      redisTtlSeconds: 60 * 60 * 4, // 4 hours
      redisKeyPrefix: 'OWN',
    }),
  });
};
