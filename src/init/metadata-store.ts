/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import * as config from '../config.js';
import { RedisKvStore } from '../store/redis-kv-store.js';
import { NodeKvStore } from '../store/node-kv-store.js';
import { KVBufferStore } from '../types.js';
import { KvJsonStore } from '../store/kv-attributes-store.js';
import { ContiguousMetadata } from '../types.js';

const DEFAULT_NODE_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const DEFAULT_NODE_MAX_KEYS = 10_000;

const createKvBufferStore = ({
  type,
  log,
  nodeMaxKeys = DEFAULT_NODE_MAX_KEYS,
  nodeTtlSeconds = DEFAULT_NODE_TTL_SECONDS,
  redisUrl = config.REDIS_CACHE_URL,
  redisTtlSeconds = config.REDIS_CACHE_TTL_SECONDS,
}: {
  type: string;
  log: winston.Logger;
  nodeMaxKeys?: number;
  nodeTtlSeconds?: number;
  redisUrl?: string;
  redisTtlSeconds?: number;
}): KVBufferStore => {
  log.info(
    `Using ${type} for KVBufferStore for contiguous data metadata cache`,
  );
  switch (type) {
    case 'node': {
      return new NodeKvStore({
        maxKeys: nodeMaxKeys,
        ttlSeconds: nodeTtlSeconds,
      });
    }
    case 'redis': {
      return new RedisKvStore({
        redisUrl,
        ttlSeconds: redisTtlSeconds,
        keyPrefix: 'CM',
        log,
      });
    }

    default: {
      throw new Error(`Invalid chain cache type: ${type}`);
    }
  }
};

export const makeContiguousMetadataStore = ({
  log,
  type,
}: {
  log: winston.Logger;
  type: string;
}) => {
  return new KvJsonStore<ContiguousMetadata>({
    log,
    allowOverwrite: true,
    kvBufferStore: createKvBufferStore({
      log,
      type,
    }),
  });
};
