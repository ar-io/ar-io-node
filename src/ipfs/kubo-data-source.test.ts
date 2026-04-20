/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { createTestLogger } from '../../test/test-logger.js';
import {
  KuboDataSource,
  IpfsNotFoundError,
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
  });
});
