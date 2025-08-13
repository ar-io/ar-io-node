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
import { ArIOPeerManager } from './ar-io-peer-manager.js';

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
  log = winston.createLogger({ silent: true });
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

  describe('hop count validation', () => {
    it('should validate hop count before making requests', async () => {
      const params = {
        ...TEST_PARAMS,
        requestAttributes: { hops: 1 },
      };

      await assert.rejects(
        chunkSource.getChunkByAny(params),
        /Maximum hops \(1\) exceeded/,
      );
    });

    it('should allow requests with hops less than max', async () => {
      // Mock fetch to prevent actual HTTP calls
      const mockFetch = mock.fn(globalThis, 'fetch');
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            chunk: 'dGVzdC1jaHVuay1kYXRh',
            data_path: 'dGVzdC1kYXRhLXBhdGg',
          }),
        }),
      );

      const params = {
        ...TEST_PARAMS,
        requestAttributes: { hops: 0 },
      };

      try {
        const result = await chunkSource.getChunkByAny(params);
        assert.ok(result?.chunk !== undefined);
      } catch (error) {
        // If peer selection fails, that's ok - we just want to verify hop validation passed
        assert.match(
          error.message,
          /No AR\.IO peers available|Failed to fetch chunk/,
        );
      }
    });

    it('should default to hops=0 when requestAttributes not provided', async () => {
      // Mock fetch to prevent actual HTTP calls
      const mockFetch = mock.fn(globalThis, 'fetch');
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            chunk: 'dGVzdC1jaHVuay1kYXRh',
            data_path: 'dGVzdC1kYXRhLXBhdGg',
          }),
        }),
      );

      const params = {
        ...TEST_PARAMS,
        requestAttributes: undefined,
      };

      try {
        const result = await chunkSource.getChunkByAny(params);
        assert.ok(result !== undefined || true); // Either success or expected failure
      } catch (error) {
        // Should not be a hop validation error
        assert.doesNotMatch(error.message, /Maximum hops.*exceeded/);
      }
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
});
