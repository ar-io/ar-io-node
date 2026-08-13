/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import axios from 'axios';
import { CachedPeerOffsets, PeersRootTxIndex } from './peers-root-tx-index.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'PeersRootTxIndex' });

const DATA_ITEM_ID = '0_pwOe0QSOnK8v-jkHuQDJxRz-bPDcXzGODGtXeKRQk';
const ROOT_TX_ID = 'MOXw-sA3FeiSRCfXlohVkwKKoUioYYIFmSawV3UzgSg';

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    rootTxId: ROOT_TX_ID,
    rootOffset: 19512,
    rootDataOffset: 20788,
    contentType: 'application/json',
    size: 1293,
    dataSize: 17,
    ...overrides,
  };
}

function createMockAxiosInstance(responseOrFn: any) {
  const getInstance =
    typeof responseOrFn === 'function' ? responseOrFn : () => responseOrFn;
  return {
    get: mock.fn((url: string) => getInstance(url)),
    defaults: { raxConfig: {} },
    interceptors: {
      request: { use: mock.fn(), eject: mock.fn() },
      response: { use: mock.fn(), eject: mock.fn() },
    },
  };
}

function notFound() {
  const error: any = new Error('Request failed with status code 404');
  error.response = { status: 404 };
  return Promise.reject(error);
}

// No limiter priming here on purpose: the index seeds each TokenBucket at
// burst capacity on construction, so a freshly built index can spend
// immediately. If that regresses, every request-making test below fails.
function createIndex(overrides: Record<string, any> = {}) {
  return new PeersRootTxIndex({
    log,
    peerUrls: { 'http://peer-a:4000': 1 },
    rateLimitBurstSize: 1000,
    rateLimitTokensPerInterval: 1000,
    rateLimitInterval: 'second' as const,
    ...overrides,
  });
}

describe('PeersRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const index = createIndex();
      assert(typeof index.getRootTx === 'function');
    });

    it('should reject an empty peer list', () => {
      assert.throws(
        () => createIndex({ peerUrls: {} }),
        /At least one peer URL must be provided/,
      );
    });

    it('seeds each rate limiter at burst capacity so boot-time lookups go out', () => {
      const index = createIndex({
        peerUrls: { 'http://peer-a:4000': 1, 'http://peer-b:4000': 2 },
        rateLimitBurstSize: 7,
      });

      const limiters = [...(index as any)['limiters'].values()];
      assert.equal(limiters.length, 2);
      for (const limiter of limiters) {
        assert.equal(limiter.content, 7);
      }
    });

    it('refuses to follow peer-supplied redirects', () => {
      const created: any[] = [];
      mock.method(axios, 'create', (cfg: any) => {
        created.push(cfg);
        return createMockAxiosInstance(Promise.resolve({ data: okBody() }));
      });

      createIndex();

      assert.equal(created[0].maxRedirects, 0);
    });
  });

  describe('getRootTx', () => {
    it('resolves offsets from the peer offsets endpoint', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.deepEqual(result, {
        rootTxId: ROOT_TX_ID,
        path: undefined,
        rootOffset: 19512,
        rootDataOffset: 20788,
        contentType: 'application/json',
        size: 1293,
        dataSize: 17,
      });
    });

    it('requests the dedicated offsets route, never HEAD /raw', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      await createIndex().getRootTx(DATA_ITEM_ID);

      assert.equal(mockAxios.get.mock.calls.length, 1);
      assert.equal(
        mockAxios.get.mock.calls[0].arguments[0],
        `http://peer-a:4000/ar-io/offsets/${DATA_ITEM_ID}`,
      );
      // No HEAD fallback exists — degrading to HEAD /raw would reintroduce the
      // expensive retrieval-cascade probe this source exists to avoid.
      assert.equal((mockAxios as any).head, undefined);
    });

    it('returns undefined when the peer cannot resolve the ID', async () => {
      const mockAxios = createMockAxiosInstance(() => notFound());
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.equal(result, undefined);
    });

    it('falls through priority tiers in order', async () => {
      const requested: string[] = [];
      const mockAxios = createMockAxiosInstance((url: string) => {
        requested.push(url);
        return url.includes('peer-b')
          ? Promise.resolve({ data: okBody() })
          : notFound();
      });
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex({
        peerUrls: { 'http://peer-a:4000': 1, 'http://peer-b:4000': 2 },
      });
      const result = await index.getRootTx(DATA_ITEM_ID);

      assert.equal(result?.rootTxId, ROOT_TX_ID);
      assert.equal(requested.length, 2);
      assert(requested[0].includes('peer-a'));
      assert(requested[1].includes('peer-b'));
    });

    it('accepts a traversal path of valid IDs', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody({ path: [ROOT_TX_ID] }) }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.deepEqual(result?.path, [ROOT_TX_ID]);
    });

    it('discards a malformed traversal path but keeps the root', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody({ path: ['not-a-valid-id'] }) }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.equal(result?.rootTxId, ROOT_TX_ID);
      assert.equal(result?.path, undefined);
    });

    it('rejects a body without a usable root TX ID and tries the next peer', async () => {
      const mockAxios = createMockAxiosInstance((url: string) =>
        url.includes('peer-a')
          ? Promise.resolve({ data: { rootTxId: 'bogus' } })
          : Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex({
        peerUrls: { 'http://peer-a:4000': 1, 'http://peer-b:4000': 2 },
      });
      const result = await index.getRootTx(DATA_ITEM_ID);

      assert.equal(result?.rootTxId, ROOT_TX_ID);
      assert.equal(mockAxios.get.mock.calls.length, 2);
    });

    it('tolerates offsets serialized as strings', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({
          data: okBody({ rootOffset: '19512', rootDataOffset: '20788' }),
        }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.equal(result?.rootOffset, 19512);
      assert.equal(result?.rootDataOffset, 20788);
    });

    it('drops negative and non-numeric offsets', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({
          data: okBody({ rootOffset: -1, rootDataOffset: 'abc' }),
        }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx(DATA_ITEM_ID);

      assert.equal(result?.rootTxId, ROOT_TX_ID);
      assert.equal(result?.rootOffset, undefined);
      assert.equal(result?.rootDataOffset, undefined);
    });

    it('serves a cached result without re-querying the peer', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const cache = new LRUCache<string, CachedPeerOffsets>({ max: 10 });
      const index = createIndex({ cache });

      await index.getRootTx(DATA_ITEM_ID);
      const second = await index.getRootTx(DATA_ITEM_ID);

      assert.equal(second?.rootTxId, ROOT_TX_ID);
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });

    it('skips a peer whose rate limit is exhausted', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      // Seeded at burst capacity (1), so exactly one request is affordable.
      const index = createIndex({
        rateLimitBurstSize: 1,
        rateLimitTokensPerInterval: 1,
        rateLimitInterval: 'hour' as const,
      });

      await index.getRootTx(DATA_ITEM_ID);
      const second = await index.getRootTx(DATA_ITEM_ID);

      assert.equal(second, undefined);
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });

    it('refuses to query peers for a malformed ID', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: okBody() }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const result = await createIndex().getRootTx('../../etc/passwd');

      assert.equal(result, undefined);
      assert.equal(mockAxios.get.mock.calls.length, 0);
    });

    it('returns undefined when every peer errors', async () => {
      const mockAxios = createMockAxiosInstance(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex({
        peerUrls: { 'http://peer-a:4000': 1, 'http://peer-b:4000': 2 },
      });

      assert.equal(await index.getRootTx(DATA_ITEM_ID), undefined);
      assert.equal(mockAxios.get.mock.calls.length, 2);
    });
  });
});
