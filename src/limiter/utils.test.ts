/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Request } from 'express';
import {
  normalizeHost,
  normalizePath,
  getCanonicalPathFromRequest,
  buildBucketKeys,
} from './utils.js';

describe('Rate Limiter Utils', () => {
  describe('normalizeHost', () => {
    it('should return host unchanged if under 256 chars', () => {
      const host = 'example.com';
      assert.strictEqual(normalizeHost(host), 'example.com');
    });

    it('should trim host to 256 characters', () => {
      const longHost = 'a'.repeat(300);
      const result = normalizeHost(longHost);
      assert.strictEqual(result.length, 256);
      assert.strictEqual(result, 'a'.repeat(256));
    });

    it('should handle empty string', () => {
      assert.strictEqual(normalizeHost(''), '');
    });
  });

  describe('normalizePath', () => {
    it('should return path unchanged if already normalized', () => {
      const path = '/foo/bar';
      assert.strictEqual(normalizePath(path), '/foo/bar');
    });

    it('should collapse repeated slashes', () => {
      const path = '//foo///bar////baz';
      assert.strictEqual(normalizePath(path), '/foo/bar/baz');
    });

    it('should handle empty string by defaulting to /', () => {
      assert.strictEqual(normalizePath(''), '/');
    });

    it('should trim path to 256 characters', () => {
      const longPath = '/' + 'a'.repeat(300);
      const result = normalizePath(longPath);
      assert.strictEqual(result.length, 256);
      assert.strictEqual(result, '/' + 'a'.repeat(255));
    });

    it('should collapse slashes and then trim', () => {
      const path = '//' + 'a'.repeat(300);
      const result = normalizePath(path);
      assert.strictEqual(result.length, 256);
      assert.strictEqual(result[0], '/');
      assert.strictEqual(result[1], 'a');
    });

    it('should handle path with only slashes', () => {
      assert.strictEqual(normalizePath('////'), '/');
    });
  });

  describe('getCanonicalPathFromRequest', () => {
    const createMockRequest = (baseUrl: string, path: string): Request => {
      return {
        baseUrl,
        path,
      } as Request;
    };

    it('should combine baseUrl and path', () => {
      const req = createMockRequest('/api', '/users');
      assert.strictEqual(getCanonicalPathFromRequest(req), '/api/users');
    });

    it('should handle empty baseUrl', () => {
      const req = createMockRequest('', '/users');
      assert.strictEqual(getCanonicalPathFromRequest(req), '/users');
    });

    it('should handle empty path', () => {
      const req = createMockRequest('/api', '');
      assert.strictEqual(getCanonicalPathFromRequest(req), '/api');
    });

    it('should handle both empty by defaulting to /', () => {
      const req = createMockRequest('', '');
      assert.strictEqual(getCanonicalPathFromRequest(req), '/');
    });

    it('should collapse repeated slashes in combined path', () => {
      const req = createMockRequest('/api/', '//users');
      assert.strictEqual(getCanonicalPathFromRequest(req), '/api/users');
    });

    it('should trim combined path to 256 characters', () => {
      const req = createMockRequest('/api', '/' + 'a'.repeat(300));
      const result = getCanonicalPathFromRequest(req);
      assert.strictEqual(result.length, 256);
    });

    it('should handle null/undefined baseUrl and path', () => {
      const req = { baseUrl: undefined, path: undefined } as unknown as Request;
      assert.strictEqual(getCanonicalPathFromRequest(req), '/');
    });
  });

  describe('buildBucketKeys', () => {
    it('should build correct resource and IP keys', () => {
      const result = buildBucketKeys(
        'GET',
        '/api/users',
        '127.0.0.1',
        'example.com',
      );
      assert.deepStrictEqual(result, {
        resourceKey: 'rl:resource:example.com:GET:/api/users',
        ipKey: 'rl:ip:127.0.0.1',
      });
    });

    it('should handle different HTTP methods', () => {
      const result = buildBucketKeys(
        'POST',
        '/api/users',
        '127.0.0.1',
        'example.com',
      );
      assert.deepStrictEqual(result, {
        resourceKey: 'rl:resource:example.com:POST:/api/users',
        ipKey: 'rl:ip:127.0.0.1',
      });
    });

    it('should handle IPv6 addresses', () => {
      const result = buildBucketKeys('GET', '/api/users', '::1', 'example.com');
      assert.deepStrictEqual(result, {
        resourceKey: 'rl:resource:example.com:GET:/api/users',
        ipKey: 'rl:ip:::1',
      });
    });

    it('should build keys with normalized inputs', () => {
      const normalizedHost = normalizeHost('example.com');
      const normalizedPath = normalizePath('//api///users');
      const result = buildBucketKeys(
        'GET',
        normalizedPath,
        '127.0.0.1',
        normalizedHost,
      );
      assert.deepStrictEqual(result, {
        resourceKey: 'rl:resource:example.com:GET:/api/users',
        ipKey: 'rl:ip:127.0.0.1',
      });
    });
  });

  describe('normalization consistency', () => {
    it('should produce same path from direct normalization and getCanonicalPathFromRequest', () => {
      const rawPath = '//foo///bar';
      const normalizedDirect = normalizePath(rawPath);

      const req = { baseUrl: '', path: rawPath } as Request;
      const normalizedFromRequest = getCanonicalPathFromRequest(req);

      assert.strictEqual(normalizedDirect, normalizedFromRequest);
    });

    it('should ensure buildBucketKeys works with normalized inputs', () => {
      const rawHost = 'example.com' + 'x'.repeat(300);
      const rawPath = '//api///users';

      const normalizedHost = normalizeHost(rawHost);
      const normalizedPath = normalizePath(rawPath);

      const keys = buildBucketKeys(
        'GET',
        normalizedPath,
        '127.0.0.1',
        normalizedHost,
      );

      // Verify the keys contain the normalized values
      assert.ok(keys.resourceKey.includes(':GET:/api/users'));
      assert.strictEqual(normalizedHost.length, 256);
    });
  });
});
