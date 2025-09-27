/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import winston from 'winston';
import { LRUCache } from 'lru-cache';
import { TurboRootTxIndex } from './turbo-root-tx-index.js';

const log = winston.createLogger({ silent: true });

describe('TurboRootTxIndex', () => {
  describe('getRootTxId', () => {
    it('should implement DataItemRootTxIndex interface', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
      });

      assert(typeof turboIndex.getRootTxId === 'function');
    });

    it('should accept cache in constructor', () => {
      const cache = new LRUCache<
        string,
        {
          parentDataItemId?: string;
          rootBundleId?: string;
          startOffsetInParentDataItemPayload?: number;
          startOffsetInRootBundle?: number;
          rawContentLength: number;
          payloadContentType: string;
          payloadDataStart: number;
          payloadContentLength: number;
        }
      >({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        cache,
      });

      assert(typeof turboIndex.getRootTxId === 'function');
    });

    it('should use default endpoint when not provided', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
      });

      assert(typeof turboIndex.getRootTxId === 'function');
    });

    it('should accept request configuration options', () => {
      const turboIndex = new TurboRootTxIndex({
        log,
        turboEndpoint: 'https://turbo.example.com',
        requestTimeoutMs: 5000,
        requestRetryCount: 5,
      });

      assert(typeof turboIndex.getRootTxId === 'function');
    });
  });
});
