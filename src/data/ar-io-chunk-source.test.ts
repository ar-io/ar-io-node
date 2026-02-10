/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { ArIOChunkSource } from './ar-io-chunk-source.js';
import { createTestLogger } from '../../test/test-logger.js';
import { ArIOPeerManager } from '../peers/ar-io-peer-manager.js';
import { ChunkWithValidationParams } from '../types.js';

let log: ReturnType<typeof createTestLogger>;
let arIOChunkSource: ArIOChunkSource;
let mockPeerManager: {
  selectPeers: ReturnType<typeof mock.fn>;
  reportSuccess: ReturnType<typeof mock.fn>;
  reportFailure: ReturnType<typeof mock.fn>;
  getPeerUrls: ReturnType<typeof mock.fn>;
};
let originalFetch: typeof global.fetch;

// Test fixture for chunk params
const testChunkParams: ChunkWithValidationParams = {
  txSize: 1000,
  dataRoot: 'dGVzdC1kYXRhLXJvb3Q', // base64url encoded
  absoluteOffset: 12345,
  relativeOffset: 100,
};

before(async () => {
  log = createTestLogger({ suite: 'ArIOChunkSource' });
  originalFetch = global.fetch;
});

beforeEach(async () => {
  mockPeerManager = {
    selectPeers: mock.fn(() => ['http://peer1.example.com']),
    reportSuccess: mock.fn(),
    reportFailure: mock.fn(),
    getPeerUrls: mock.fn(() => ['http://peer1.example.com']),
  };

  arIOChunkSource = new ArIOChunkSource({
    log,
    peerManager: mockPeerManager as unknown as ArIOPeerManager,
  });
});

afterEach(async () => {
  global.fetch = originalFetch;
  mock.restoreAll();
});

describe('ArIOChunkSource', () => {
  describe('skipRemoteForwarding', () => {
    it('should throw when skipRemoteForwarding is set on getChunkByAny', async () => {
      await assert.rejects(
        arIOChunkSource.getChunkByAny({
          ...testChunkParams,
          requestAttributes: { hops: 0, skipRemoteForwarding: true },
        }),
        /Remote forwarding skipped for compute-origin request/,
      );

      // Verify no peers were selected
      assert.equal(mockPeerManager.selectPeers.mock.callCount(), 0);
    });

    it('should throw when skipRemoteForwarding is set on getUnvalidatedChunk', async () => {
      await assert.rejects(
        arIOChunkSource.getUnvalidatedChunk(12345, {
          hops: 0,
          skipRemoteForwarding: true,
        }),
        /Remote forwarding skipped for compute-origin request/,
      );

      // Verify no peers were selected
      assert.equal(mockPeerManager.selectPeers.mock.callCount(), 0);
    });
  });

  describe('getChunkByAny abort signal handling', () => {
    it('should throw immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        arIOChunkSource.getChunkByAny(testChunkParams, controller.signal),
        { name: 'AbortError' },
      );

      // Verify no peers were selected (request aborted before network call)
      assert.equal(mockPeerManager.selectPeers.mock.callCount(), 0);
    });

    it('should allow cache-hit caller to abort while first continues waiting', async () => {
      // This tests the core fix: when using a cached promise (cache hit),
      // the caller should be able to abort independently via their own signal
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      let fetchResolve: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        fetchResolve = resolve;
      });

      // Mock fetch that waits for external resolution
      global.fetch = mock.fn(() => fetchPromise) as typeof global.fetch;

      // Start first request (cache miss - creates promise)
      // Note: controller1 signal is passed to fetch internally
      const promise1 = arIOChunkSource.getChunkByAny(
        testChunkParams,
        controller1.signal,
      );

      // Wait a tick for the promise to be cached
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Start second request (cache hit - reuses promise via withAbortSignal)
      const promise2 = arIOChunkSource.getChunkByAny(
        testChunkParams,
        controller2.signal,
      );

      // Abort second request only
      controller2.abort();

      // Second request (cache hit) should reject with AbortError immediately
      // This is the key behavior we're testing - before the fix,
      // the second caller could NOT abort because the cached promise
      // didn't respect their abort signal
      await assert.rejects(promise2, { name: 'AbortError' });

      // Resolve the fetch to clean up the first request
      fetchResolve!(
        new Response(
          JSON.stringify({
            chunk: 'dGVzdA',
            data_path: 'dGVzdA',
          }),
        ),
      );

      // First request should NOT have been aborted by second caller's abort
      // (may fail for other reasons like validation, but not AbortError)
      try {
        await promise1;
      } catch (error: any) {
        assert.notEqual(
          error.name,
          'AbortError',
          "First caller's request should not be aborted by second caller's abort",
        );
      }
    });

    it('should work normally without abort signal', async () => {
      // Mock fetch to return a response (will fail validation, which is expected)
      global.fetch = mock.fn(async () => {
        return new Response(
          JSON.stringify({
            chunk: 'dGVzdA',
            data_path: 'dGVzdA',
          }),
        );
      }) as typeof global.fetch;

      // Call without signal - should not throw AbortError
      try {
        await arIOChunkSource.getChunkByAny(testChunkParams);
      } catch (error: any) {
        // May fail for validation reasons, but NOT AbortError
        assert.notEqual(
          error.name,
          'AbortError',
          'Should not throw AbortError when no signal provided',
        );
      }
    });

    it('should handle multiple cache-hit callers aborting independently', async () => {
      // Test that multiple cache-hit callers can each abort independently
      // without affecting each other or the underlying fetch
      const controller1 = new AbortController(); // First caller (cache miss)
      const controller2 = new AbortController(); // Second caller (cache hit)
      const controller3 = new AbortController(); // Third caller (cache hit)
      // Fourth caller has no signal (cache hit)

      let fetchResolve: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        fetchResolve = resolve;
      });

      global.fetch = mock.fn(() => fetchPromise) as typeof global.fetch;

      // Start four concurrent requests
      const promise1 = arIOChunkSource.getChunkByAny(
        testChunkParams,
        controller1.signal,
      ); // cache miss
      const promise2 = arIOChunkSource.getChunkByAny(
        testChunkParams,
        controller2.signal,
      ); // cache hit
      const promise3 = arIOChunkSource.getChunkByAny(
        testChunkParams,
        controller3.signal,
      ); // cache hit
      const promise4 = arIOChunkSource.getChunkByAny(testChunkParams); // cache hit, no signal

      // Wait for promises to be set up
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Abort only the cache-hit callers (2 and 3)
      controller2.abort();
      controller3.abort();

      // Cache-hit requests 2 and 3 should reject with AbortError
      await assert.rejects(promise2, { name: 'AbortError' });
      await assert.rejects(promise3, { name: 'AbortError' });

      // Resolve fetch
      fetchResolve!(
        new Response(
          JSON.stringify({
            chunk: 'dGVzdA',
            data_path: 'dGVzdA',
          }),
        ),
      );

      // Promise 1 (cache miss) and Promise 4 (no signal) should NOT be aborted
      // They may fail for validation reasons, but not AbortError
      try {
        await promise1;
      } catch (error: any) {
        assert.notEqual(
          error.name,
          'AbortError',
          'Cache-miss caller should not be aborted by cache-hit callers',
        );
      }

      try {
        await promise4;
      } catch (error: any) {
        assert.notEqual(
          error.name,
          'AbortError',
          'Caller without signal should not be aborted',
        );
      }
    });
  });
});
