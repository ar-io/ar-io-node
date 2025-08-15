/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatContentDigest } from './digest.js';

describe('formatContentDigest', () => {
  it('should convert base64url to standard base64 with RFC 9530 format', () => {
    const base64url = '4ROTs2lTPAKbr8Y41WrjHu-2q-7S-m-yTuO7fAUzZI4';
    const expected = 'sha-256=:4ROTs2lTPAKbr8Y41WrjHu+2q+7S+m+yTuO7fAUzZI4=:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should handle base64url without padding correctly', () => {
    const base64url = 'YjNkZjM1YThhNjIxOGY2MTZlNTQ3YzFmZGE2YzE4ZjE';
    const expected = 'sha-256=:YjNkZjM1YThhNjIxOGY2MTZlNTQ3YzFmZGE2YzE4ZjE=:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should handle base64url that needs double padding', () => {
    const base64url = 'dGVzdA';
    const expected = 'sha-256=:dGVzdA==:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should handle base64url that needs single padding', () => {
    const base64url = 'dGVzdDE';
    const expected = 'sha-256=:dGVzdDE=:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should handle base64url that needs no padding', () => {
    const base64url = 'dGVzdDEyMw';
    const expected = 'sha-256=:dGVzdDEyMw==:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should handle empty string', () => {
    const base64url = '';
    const expected = 'sha-256=::';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should preserve characters that are same in base64 and base64url', () => {
    const base64url =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    // 62 chars % 4 = 2, so needs 2 padding chars
    const expected =
      'sha-256=:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789==:';

    const result = formatContentDigest(base64url);

    assert.strictEqual(result, expected);
  });

  it('should wrap value in colons as per RFC 9530 dictionary syntax', () => {
    const base64url = 'test';
    const result = formatContentDigest(base64url);

    assert(result.startsWith('sha-256=:'));
    assert(result.endsWith(':'));
  });

  it('should use sha-256 algorithm by default', () => {
    const base64url = 'test';
    const result = formatContentDigest(base64url);

    assert(result.startsWith('sha-256=:'));
  });

  it('should allow explicit sha-256 algorithm parameter', () => {
    const base64url = 'test';
    const result = formatContentDigest(base64url, 'sha-256');

    assert(result.startsWith('sha-256=:'));
  });
});
