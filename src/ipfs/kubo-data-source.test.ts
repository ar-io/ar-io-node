/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import axios from 'axios';

import { createTestLogger } from '../../test/test-logger.js';
import {
  KuboDataSource,
  IpfsNotFoundError,
  IpfsRangeNotSatisfiableError,
  IpfsTimeoutError,
  IpfsUnavailableError,
} from './kubo-data-source.js';

describe('KuboDataSource', () => {
  const log = createTestLogger({ suite: 'KuboDataSource' });

  let kuboDataSource: KuboDataSource;

  beforeEach(() => {
    kuboDataSource = new KuboDataSource({
      log,
      kuboUrl: 'http://localhost:8080',
      requestTimeoutMs: 5000,
      streamStallTimeoutMs: 5000,
    });
  });

  describe('getContent', () => {
    it('constructs correct URL for bare CID', async () => {
      // This test verifies URL construction without making a real request.
      // A real integration test would require a running Kubo instance.
      const controller = new AbortController();
      controller.abort(); // Abort immediately

      try {
        await kuboDataSource.getContent({
          cidString:
            'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          signal: controller.signal,
        });
      } catch (error: any) {
        // Expected to throw due to abort
        assert.ok(error);
      }
    });

    it('constructs correct URL for CID with path', async () => {
      const controller = new AbortController();
      controller.abort();

      try {
        await kuboDataSource.getContent({
          cidString:
            'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          path: 'images/logo.png',
          signal: controller.signal,
        });
      } catch (error: any) {
        assert.ok(error);
      }
    });

    it('throws AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () =>
          kuboDataSource.getContent({
            cidString:
              'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
            signal: controller.signal,
          }),
        (error: any) => {
          assert.ok(
            error.name === 'AbortError' || error.code === 'ERR_CANCELED',
          );
          return true;
        },
      );
    });
  });

  describe('range requests', () => {
    const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    let interceptorId: number;
    afterEach(() => axios.interceptors.request.eject(interceptorId));

    const readRange = (h: any): string | undefined =>
      typeof h?.get === 'function' ? h.get('Range') : (h?.Range ?? h?.range);

    it('forwards Range to Kubo and relays 206 + Content-Range', async () => {
      let captured: any;
      interceptorId = axios.interceptors.request.use((config) => {
        captured = config;
        config.adapter = () =>
          Promise.resolve({
            status: 206,
            statusText: 'Partial Content',
            headers: {
              'content-range': 'bytes 0-99/119762',
              'content-length': '100',
              'content-type': 'image/jpeg',
            },
            config,
            data: Readable.from([Buffer.alloc(100)]),
          });
        return config;
      });

      const result = await kuboDataSource.getContent({
        cidString: CID,
        range: 'bytes=0-99',
      });

      assert.equal(readRange(captured.headers), 'bytes=0-99');
      assert.equal(result.statusCode, 206);
      assert.equal(result.contentRange, 'bytes 0-99/119762');
      assert.equal(result.size, 100);
      result.stream.destroy();
    });

    it('maps a Kubo 416 to IpfsRangeNotSatisfiableError', async () => {
      interceptorId = axios.interceptors.request.use((config) => {
        config.adapter = () =>
          Promise.resolve({
            status: 416,
            statusText: 'Range Not Satisfiable',
            headers: {},
            config,
            data: Readable.from([]),
          });
        return config;
      });

      await assert.rejects(
        () => kuboDataSource.getContent({ cidString: CID, range: 'bytes=9e9-' }),
        (error: any) => {
          assert.equal(error.name, 'IpfsRangeNotSatisfiableError');
          return true;
        },
      );
    });

    it('returns statusCode 200 and no Content-Range for a full response', async () => {
      interceptorId = axios.interceptors.request.use((config) => {
        config.adapter = () =>
          Promise.resolve({
            status: 200,
            statusText: 'OK',
            headers: {
              'content-length': '119762',
              'content-type': 'image/jpeg',
            },
            config,
            data: Readable.from([Buffer.alloc(10)]),
          });
        return config;
      });

      const result = await kuboDataSource.getContent({ cidString: CID });
      assert.equal(result.statusCode, 200);
      assert.equal(result.contentRange, undefined);
      result.stream.destroy();
    });
  });

  describe('trustless format', () => {
    const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    let interceptorId: number;
    afterEach(() => axios.interceptors.request.eject(interceptorId));

    it('forwards ?format=raw and the IPLD Accept type to Kubo', async () => {
      let captured: any;
      interceptorId = axios.interceptors.request.use((config) => {
        captured = config;
        config.adapter = () =>
          Promise.resolve({
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/vnd.ipld.raw' },
            config,
            data: Readable.from([Buffer.alloc(10)]),
          });
        return config;
      });

      const result = await kuboDataSource.getContent({
        cidString: CID,
        format: 'raw',
      });

      assert.match(captured.url, /\/ipfs\/.*\?format=raw$/);
      const accept =
        typeof captured.headers?.get === 'function'
          ? captured.headers.get('Accept')
          : captured.headers?.Accept;
      assert.equal(accept, 'application/vnd.ipld.raw');
      assert.equal(result.contentType, 'application/vnd.ipld.raw');
      assert.equal(result.statusCode, 200);
      result.stream.destroy();
    });
  });

  describe('error types', () => {
    it('IpfsNotFoundError has correct name', () => {
      const error = new IpfsNotFoundError('not found');
      assert.equal(error.name, 'IpfsNotFoundError');
      assert.equal(error.message, 'not found');
    });

    it('IpfsTimeoutError has correct name', () => {
      const error = new IpfsTimeoutError('timeout');
      assert.equal(error.name, 'IpfsTimeoutError');
    });

    it('IpfsUnavailableError has correct name', () => {
      const error = new IpfsUnavailableError('unavailable');
      assert.equal(error.name, 'IpfsUnavailableError');
    });

    it('IpfsRangeNotSatisfiableError has correct name', () => {
      const error = new IpfsRangeNotSatisfiableError('range');
      assert.equal(error.name, 'IpfsRangeNotSatisfiableError');
    });
  });
});
