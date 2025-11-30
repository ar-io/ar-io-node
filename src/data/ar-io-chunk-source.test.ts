/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import * as winston from 'winston';
import { AoARIORead } from '@ar.io/sdk';
import { ChunkDataByAnySourceParams } from '../types.js';
import { ArIOChunkSource } from './ar-io-chunk-source.js';
import { ArIOPeerManager } from '../peers/ar-io-peer-manager.js';
import { createTestLogger } from '../../test/test-logger.js';

let log: winston.Logger;
let chunkSource: ArIOChunkSource;
let peerManager: ArIOPeerManager;
let mockedArIOInstance: AoARIORead;

const TEST_PARAMS: ChunkDataByAnySourceParams = {
  txSize: 256000,
  absoluteOffset: 12345,
  dataRoot: 'test-data-root-base64url',
  relativeOffset: 67890,
  requestAttributes: { hops: 0 },
};

before(async () => {
  log = createTestLogger({ suite: 'ArIOChunkSource' });
});

beforeEach(async () => {
  mock.restoreAll();

  // Mock AR.IO SDK instance
  mockedArIOInstance = {
    getGateways: async () => ({
      items: [
        {
          gatewayAddress: 'peer1',
          settings: { protocol: 'http', fqdn: 'peer1.com' },
        },
        {
          gatewayAddress: 'peer2',
          settings: { protocol: 'https', fqdn: 'peer2.com' },
        },
      ],
      hasMore: false,
      nextCursor: undefined,
    }),
  } as AoARIORead;

  // Mock peer manager with dependency injection
  peerManager = new ArIOPeerManager({
    log,
    networkProcess: mockedArIOInstance,
    nodeWallet: 'localNode',
    initialPeers: {
      peer1: 'http://peer1.com',
      peer2: 'https://peer2.com',
    },
    initialCategories: ['chunk'],
  });

  // Create chunk source
  chunkSource = new ArIOChunkSource({
    log,
    peerManager,
  });
});

afterEach(() => {
  mock.restoreAll();
  peerManager.shutdown();
});

describe('ArIOChunkSource', () => {
  describe('constructor', () => {
    it('should initialize with peer manager and logger', () => {
      const testChunkSource = new ArIOChunkSource({
        log,
        peerManager,
      });

      assert.ok(testChunkSource !== undefined);
    });
  });

  describe('cache key generation', () => {
    it('should generate consistent cache keys', () => {
      const chunkSourceWithPeers = new ArIOChunkSource({
        log,
        peerManager,
      });

      // Access private method through bracket notation for testing
      const getCacheKey = (chunkSourceWithPeers as any).getCacheKey.bind(
        chunkSourceWithPeers,
      );

      const key1 = getCacheKey(TEST_PARAMS);
      const key2 = getCacheKey(TEST_PARAMS);

      assert.equal(key1, key2);
      assert.equal(key1, 'test-data-root-base64url:12345:256000:67890');
    });

    it('should generate different cache keys for different params', () => {
      const chunkSourceWithPeers = new ArIOChunkSource({
        log,
        peerManager,
      });

      const getCacheKey = (chunkSourceWithPeers as any).getCacheKey.bind(
        chunkSourceWithPeers,
      );

      const key1 = getCacheKey(TEST_PARAMS);
      const key2 = getCacheKey({
        ...TEST_PARAMS,
        absoluteOffset: 99999,
      });

      assert.notEqual(key1, key2);
    });
  });

  describe('interface implementations', () => {
    it('getChunkDataByAny and getChunkMetadataByAny should exist', () => {
      assert.ok(typeof chunkSource.getChunkDataByAny === 'function');
      assert.ok(typeof chunkSource.getChunkMetadataByAny === 'function');
    });
  });

  describe('hop count validation', () => {
    // MAX_CHUNK_HOPS is 1, so hops >= 1 should be rejected
    it('getChunkByAny should reject when hops equal max limit', async () => {
      await assert.rejects(
        () =>
          chunkSource.getChunkByAny({
            ...TEST_PARAMS,
            requestAttributes: { hops: 1 },
          }),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('getChunkByAny should reject when hops exceed max limit', async () => {
      await assert.rejects(
        () =>
          chunkSource.getChunkByAny({
            ...TEST_PARAMS,
            requestAttributes: { hops: 2 },
          }),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('getUnvalidatedChunk should reject when hops equal max limit', async () => {
      await assert.rejects(
        () => chunkSource.getUnvalidatedChunk(12345, { hops: 1 }),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('getUnvalidatedChunk should reject when hops exceed max limit', async () => {
      await assert.rejects(
        () => chunkSource.getUnvalidatedChunk(12345, { hops: 2 }),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('should not throw hop error when hops are below limit', async () => {
      // With hops=0 (below limit), it should proceed past hop validation
      // and fail for a different reason (peer fetch failure, not hop limit)
      await assert.rejects(
        () =>
          chunkSource.getChunkByAny({
            ...TEST_PARAMS,
            requestAttributes: { hops: 0 },
          }),
        /Failed to fetch chunk from AR.IO peers/,
      );
    });
  });
});
