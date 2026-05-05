/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import { HttpByteRangeSource } from './http-byte-range-source.js';

// PE-9081: HttpByteRangeSource passes maxContentLength: size and
// maxBodyLength: size to axios per request, so the upstream's body is
// rejected mid-allocation if it exceeds the requested size, rather than
// after the full buffer has already been materialized.
describe('HttpByteRangeSource', () => {
  describe('read', () => {
    it('should pass maxContentLength: size and maxBodyLength: size to axios', async () => {
      let capturedConfig: any;
      const fakeClient = {
        get: mock.fn(async (_url: string, config: any) => {
          capturedConfig = config;
          return {
            status: 206,
            data: Buffer.alloc(100, 0x41),
            headers: { 'content-length': '100' },
          };
        }),
      } as any;

      const source = new HttpByteRangeSource({
        url: 'http://example.test/x',
        httpClient: fakeClient,
      });

      const result = await source.read(0, 100);
      assert.equal(result.length, 100);
      assert.equal(capturedConfig.maxContentLength, 100);
      assert.equal(capturedConfig.maxBodyLength, 100);
    });

    it('should still reject post-hoc on size mismatch even if axios let bytes through', async () => {
      const fakeClient = {
        get: mock.fn(async () => ({
          status: 206,
          data: Buffer.alloc(50, 0x41), // 50 bytes returned
          headers: { 'content-length': '50' },
        })),
      } as any;

      const source = new HttpByteRangeSource({
        url: 'http://example.test/x',
        httpClient: fakeClient,
      });

      await assert.rejects(
        source.read(0, 100), // requesting 100, got 50
        /short read/,
      );
    });

    it('should reject when status is not 206', async () => {
      const fakeClient = {
        get: mock.fn(async () => ({
          status: 200,
          data: Buffer.alloc(100, 0x41),
          headers: { 'content-length': '100' },
        })),
      } as any;

      const source = new HttpByteRangeSource({
        url: 'http://example.test/x',
        httpClient: fakeClient,
      });

      await assert.rejects(source.read(0, 100), /expected 206 Partial Content/);
    });
  });
});
