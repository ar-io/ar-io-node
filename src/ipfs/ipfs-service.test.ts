/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { once } from 'node:events';

import { createTestLogger } from '../../test/test-logger.js';
import { IpfsService } from './ipfs-service.js';
import {
  KuboDataSource,
  IpfsNotFoundError,
  IpfsTimeoutError,
  IpfsUnavailableError,
} from './kubo-data-source.js';
import { IpfsFsCache } from './ipfs-cache.js';
import { DataBlockListValidator } from '../types.js';
import { NegativeDataCache } from '../data/negative-data-cache.js';
import * as metrics from '../metrics.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

// A never-ending readable so the returned stream stays live until we destroy it.
function makeInfiniteStream(): Readable {
  const s = new Readable({ read() {} });
  s.push(Buffer.alloc(8));
  return s;
}

async function counterValue(counter: {
  get: () => Promise<{ values: { value: number }[] }>;
}): Promise<number> {
  const m = await counter.get();
  return m.values.reduce((sum, v) => sum + v.value, 0);
}

describe('IpfsService', () => {
  const log = createTestLogger({ suite: 'IpfsService' });

  let dataSource: KuboDataSource;
  let cache: IpfsFsCache;
  let blockListValidator: DataBlockListValidator;
  let negativeCache: NegativeDataCache;

  const buildService = (maxResponseSizeBytes = 10_000_000) =>
    new IpfsService({
      log,
      dataSource,
      cache,
      blockListValidator,
      maxResponseSizeBytes,
      negativeCache,
    });

  beforeEach(() => {
    cache = {
      get: mock.fn(async () => null),
      getDigest: mock.fn(async () => undefined),
      getCachePath: mock.fn(() => '/nonexistent-cache-dir'),
      putFromFile: mock.fn(async () => {}),
    } as unknown as IpfsFsCache;

    blockListValidator = {
      isIdBlocked: mock.fn(async () => false),
      isHashBlocked: mock.fn(async () => false),
    } as unknown as DataBlockListValidator;

    negativeCache = {
      isNegativelyCached: mock.fn(() => false),
      recordMiss: mock.fn(() => {}),
      recordSuccess: mock.fn(() => {}),
      evict: mock.fn(() => {}),
    } as unknown as NegativeDataCache;
  });

  describe('M1: guardSize teardown', () => {
    it('destroys the underlying Kubo source when the returned format stream is destroyed', async () => {
      const source = makeInfiniteStream();
      dataSource = {
        getContent: mock.fn(async () => ({
          stream: source,
          size: 0,
          contentType: 'application/vnd.ipld.car',
          statusCode: 200,
        })),
      } as unknown as KuboDataSource;

      const service = buildService();
      const result = await service.getContent({
        cidString: CID,
        format: 'car',
      });

      // The returned stream is the size-guard wrapper, not the source.
      assert.notEqual(result.stream, source);
      assert.equal(source.destroyed, false);

      // Destroying the wrapper (as HEAD / a rate-limit teardown does) must tear
      // down the underlying source so its socket + concurrency slot release.
      result.stream.destroy();
      await once(source, 'close');
      assert.equal(source.destroyed, true);
    });
  });

  describe('negative cache is keyed by CID+path (regression)', () => {
    it('records a miss under `${cid}/${path}`, not the bare CID', async () => {
      dataSource = {
        getContent: mock.fn(async () => {
          throw new IpfsNotFoundError('nope');
        }),
      } as unknown as KuboDataSource;

      const service = buildService();
      await assert.rejects(
        () => service.getContent({ cidString: CID, path: 'sub/leaf.png' }),
        (e: any) => e instanceof IpfsNotFoundError,
      );

      const recordMiss = (negativeCache.recordMiss as any).mock;
      assert.equal(recordMiss.calls.length, 1);
      assert.equal(recordMiss.calls[0].arguments[0], `${CID}/sub/leaf.png`);
      // The bare-CID (root) key must be untouched, so a bad sub-path can't
      // blackhole the whole site.
      assert.notEqual(recordMiss.calls[0].arguments[0], CID);
    });
  });

  describe('negative cache records unretrievable content (no-provider defaults)', () => {
    it('records a miss on a retrieval TIMEOUT (the no-provider case)', async () => {
      dataSource = {
        getContent: mock.fn(async () => {
          throw new IpfsTimeoutError('kubo timed out');
        }),
      } as unknown as KuboDataSource;

      const service = buildService();
      await assert.rejects(
        () => service.getContent({ cidString: CID }),
        (e: any) => e instanceof IpfsTimeoutError,
      );

      const recordMiss = (negativeCache.recordMiss as any).mock;
      assert.equal(recordMiss.calls.length, 1);
      assert.equal(recordMiss.calls[0].arguments[0], CID);
      // A timeout MUST be recorded as a soft miss (short, self-healing TTL, no
      // escalation) — a regression to a hard miss would restore the multi-hour
      // blackhole of recovering content.
      assert.deepEqual(recordMiss.calls[0].arguments[1], { softMiss: true });
    });

    it('does NOT negatively cache an IpfsUnavailableError (Kubo itself down)', async () => {
      dataSource = {
        getContent: mock.fn(async () => {
          throw new IpfsUnavailableError('kubo down');
        }),
      } as unknown as KuboDataSource;

      const service = buildService();
      await assert.rejects(
        () => service.getContent({ cidString: CID }),
        (e: any) => e instanceof IpfsUnavailableError,
      );

      const recordMiss = (negativeCache.recordMiss as any).mock;
      assert.equal(recordMiss.calls.length, 0);
    });
  });

  describe('local-only (holding primitive) is isolated from the negative cache', () => {
    it('threads localOnly to the data source and does NOT record a negative-cache miss on a local miss', async () => {
      const getContent = mock.fn(async () => {
        throw new IpfsNotFoundError('not held locally');
      });
      dataSource = { getContent } as unknown as KuboDataSource;

      const service = buildService();
      await assert.rejects(
        () =>
          service.getContent({
            cidString: CID,
            format: 'raw',
            localOnly: true,
          }),
        (e: any) => e instanceof IpfsNotFoundError,
      );

      // localOnly is passed through to the source...
      assert.equal(getContent.mock.calls[0].arguments[0].localOnly, true);
      // ...and a local miss must NOT poison the negative cache (which would
      // blackhole the CID for the normal peer/public fallback path).
      assert.equal((negativeCache.recordMiss as any).mock.calls.length, 0);
    });

    it('ignores an existing negative-cache entry under local-only (reflects true current local state)', async () => {
      negativeCache.isNegativelyCached = mock.fn(() => true) as any;
      const getContent = mock.fn(async () => ({
        stream: makeInfiniteStream(),
        size: 8,
        contentType: 'application/vnd.ipld.raw',
        statusCode: 200,
      }));
      dataSource = { getContent } as unknown as KuboDataSource;

      const service = buildService();
      const result = await service.getContent({
        cidString: CID,
        format: 'raw',
        localOnly: true,
      });

      // Reached the data source despite the negative-cache entry.
      assert.equal(getContent.mock.calls.length, 1);
      result.stream.destroy();
    });

    it('does NOT write the on-disk cache under local-only (avoids persisting the octet-stream default)', async () => {
      const source = makeInfiniteStream();
      dataSource = {
        getContent: mock.fn(async () => ({
          stream: source,
          size: 8,
          // no format => this would normally be tee'd to the on-disk cache
          contentType: 'application/octet-stream',
          statusCode: 200,
        })),
      } as unknown as KuboDataSource;

      const service = buildService();
      const result = await service.getContent({
        cidString: CID,
        localOnly: true,
      });
      result.stream.destroy();

      assert.equal((cache.putFromFile as any).mock.calls.length, 0);
    });

    it('serves an on-disk cache hit as a local hold and leaves the negative cache untouched', async () => {
      cache.get = mock.fn(async () => ({
        stream: makeInfiniteStream(),
        size: 8,
        contentType: 'image/png',
        digest: undefined,
      })) as any;
      dataSource = {
        getContent: mock.fn(async () => {
          throw new Error('must not reach the data source on a cache hit');
        }),
      } as unknown as KuboDataSource;

      const service = buildService();
      const result = await service.getContent({
        cidString: CID,
        localOnly: true,
      });

      assert.equal(result.cached, true);
      assert.equal(result.contentType, 'image/png');
      // Negative-cache health is not touched under local-only.
      assert.equal((negativeCache.evict as any).mock.calls.length, 0);
      assert.equal((negativeCache.recordSuccess as any).mock.calls.length, 0);
      result.stream.destroy();
    });
  });

  describe('L1: cache hit/miss counters increment once, in the service', () => {
    it('increments the miss counter exactly once per uncached fetch', async () => {
      dataSource = {
        getContent: mock.fn(async () => ({
          stream: makeInfiniteStream(),
          size: 8,
          contentType: 'application/vnd.ipld.raw',
          statusCode: 200,
        })),
      } as unknown as KuboDataSource;

      const before = await counterValue(metrics.ipfsCacheMissTotal);
      const service = buildService();
      const result = await service.getContent({
        cidString: CID,
        format: 'raw',
      });
      result.stream.destroy();
      const after = await counterValue(metrics.ipfsCacheMissTotal);

      assert.equal(after - before, 1);
    });
  });
});
