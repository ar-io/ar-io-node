/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import {
  sanitizeTagHeaderName,
  sanitizeTagHeaderValue,
  resolveItemHeaders,
} from './handlers.js';

describe('sanitizeTagHeaderName', () => {
  it('should pass through simple alphanumeric names', () => {
    assert.strictEqual(sanitizeTagHeaderName('ContentType'), 'ContentType');
  });

  it('should preserve hyphens and underscores', () => {
    assert.strictEqual(sanitizeTagHeaderName('Content-Type'), 'Content-Type');
    assert.strictEqual(sanitizeTagHeaderName('App_Name'), 'App_Name');
    assert.strictEqual(sanitizeTagHeaderName('My-Tag_Name'), 'My-Tag_Name');
  });

  it('should replace special characters with dashes', () => {
    assert.strictEqual(sanitizeTagHeaderName('Content Type'), 'Content-Type');
    assert.strictEqual(sanitizeTagHeaderName('tag.name'), 'tag-name');
    assert.strictEqual(sanitizeTagHeaderName('tag@name!'), 'tag-name');
  });

  it('should collapse consecutive dashes into a single dash', () => {
    assert.strictEqual(sanitizeTagHeaderName('a---b'), 'a-b');
    assert.strictEqual(sanitizeTagHeaderName('a..b'), 'a-b');
    assert.strictEqual(sanitizeTagHeaderName('a @@ b'), 'a-b');
  });

  it('should trim leading and trailing dashes', () => {
    assert.strictEqual(sanitizeTagHeaderName('-name-'), 'name');
    assert.strictEqual(sanitizeTagHeaderName('---name---'), 'name');
    assert.strictEqual(sanitizeTagHeaderName('.name.'), 'name');
    assert.strictEqual(sanitizeTagHeaderName('!tag!'), 'tag');
  });

  it('should return empty string for empty input', () => {
    assert.strictEqual(sanitizeTagHeaderName(''), '');
  });

  it('should return empty string when all characters are stripped', () => {
    assert.strictEqual(sanitizeTagHeaderName('...'), '');
    assert.strictEqual(sanitizeTagHeaderName('!!!'), '');
  });

  it('should truncate names longer than 128 characters', () => {
    const longName = 'a'.repeat(200);
    const result = sanitizeTagHeaderName(longName);
    assert.strictEqual(result.length, 128);
    assert.strictEqual(result, 'a'.repeat(128));
  });

  it('should truncate after sanitization', () => {
    // Build a name that is exactly 128 valid chars followed by more
    const longName = 'x'.repeat(130);
    const result = sanitizeTagHeaderName(longName);
    assert.strictEqual(result.length, 128);
  });

  it('should handle unicode characters by replacing them with dashes', () => {
    assert.strictEqual(sanitizeTagHeaderName('tag\u00e9name'), 'tag-name');
    assert.strictEqual(sanitizeTagHeaderName('\u4f60\u597d'), ''); // all non-ASCII replaced and trimmed
  });

  it('should handle mixed valid and invalid characters', () => {
    assert.strictEqual(sanitizeTagHeaderName('My (Cool) Tag!'), 'My-Cool-Tag');
  });

  it('should handle names with only dashes and underscores', () => {
    assert.strictEqual(sanitizeTagHeaderName('---'), '');
    assert.strictEqual(sanitizeTagHeaderName('___'), '___');
    assert.strictEqual(sanitizeTagHeaderName('-_-'), '_');
  });
});

describe('sanitizeTagHeaderValue', () => {
  it('should pass through normal printable ASCII text', () => {
    assert.strictEqual(
      sanitizeTagHeaderValue('Hello, World!'),
      'Hello, World!',
    );
  });

  it('should preserve tab characters (0x09)', () => {
    assert.strictEqual(sanitizeTagHeaderValue('a\tb'), 'a\tb');
    assert.strictEqual(sanitizeTagHeaderValue('\t'), '\t');
  });

  it('should remove control characters (0x00-0x08, 0x0A-0x1F)', () => {
    // null
    assert.strictEqual(sanitizeTagHeaderValue('a\x00b'), 'ab');
    // bell
    assert.strictEqual(sanitizeTagHeaderValue('a\x07b'), 'ab');
    // newline
    assert.strictEqual(sanitizeTagHeaderValue('a\nb'), 'ab');
    // carriage return
    assert.strictEqual(sanitizeTagHeaderValue('a\rb'), 'ab');
    // escape
    assert.strictEqual(sanitizeTagHeaderValue('a\x1Bb'), 'ab');
    // unit separator (0x1F)
    assert.strictEqual(sanitizeTagHeaderValue('a\x1Fb'), 'ab');
  });

  it('should remove DEL character (0x7F)', () => {
    assert.strictEqual(sanitizeTagHeaderValue('a\x7Fb'), 'ab');
  });

  it('should preserve space (0x20) and printable characters', () => {
    assert.strictEqual(sanitizeTagHeaderValue(' '), ' ');
    assert.strictEqual(sanitizeTagHeaderValue('~'), '~'); // 0x7E
    assert.strictEqual(sanitizeTagHeaderValue('abc 123 !@#'), 'abc 123 !@#');
  });

  it('should truncate values longer than 4096 characters', () => {
    const longValue = 'x'.repeat(5000);
    const result = sanitizeTagHeaderValue(longValue);
    assert.strictEqual(result.length, 4096);
  });

  it('should count only kept characters toward the 4096 limit', () => {
    // Create a value with control chars interspersed - removed chars should not count
    const controlChars = '\x00'.repeat(100);
    const validChars = 'a'.repeat(4096);
    const result = sanitizeTagHeaderValue(controlChars + validChars);
    assert.strictEqual(result.length, 4096);
    assert.strictEqual(result, 'a'.repeat(4096));
  });

  it('should return empty string for empty input', () => {
    assert.strictEqual(sanitizeTagHeaderValue(''), '');
  });

  it('should return empty string when all characters are control characters', () => {
    assert.strictEqual(sanitizeTagHeaderValue('\x00\x01\x02\x03'), '');
  });

  it('should preserve Latin-1 characters (0x80-0xFF) and strip non-Latin-1', () => {
    // Latin-1 extended chars (0x80-0xFF) are valid in HTTP headers
    assert.strictEqual(sanitizeTagHeaderValue('\u00e9'), '\u00e9'); // e-acute (0xE9)
    assert.strictEqual(sanitizeTagHeaderValue('\u00ff'), '\u00ff'); // y-diaeresis (0xFF)
    // Non-Latin-1 chars (> 0xFF) are stripped to avoid ERR_INVALID_CHAR
    assert.strictEqual(sanitizeTagHeaderValue('\u4f60\u597d'), ''); // Chinese stripped
    assert.strictEqual(sanitizeTagHeaderValue('hello\u4f60'), 'hello'); // mixed
  });

  it('should handle mixed control and valid characters', () => {
    assert.strictEqual(sanitizeTagHeaderValue('He\x00ll\x01o\x7F!'), 'Hello!');
  });
});

describe('resolveItemHeaders', () => {
  let resolveFromLocalMock: ReturnType<typeof mock.fn>;
  let resolveMock: ReturnType<typeof mock.fn>;
  let dataItemMetaResolver: any;

  const TEST_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';

  beforeEach(() => {
    resolveFromLocalMock = mock.fn(() => Promise.resolve(undefined));
    resolveMock = mock.fn(() => Promise.resolve(undefined));

    dataItemMetaResolver = {
      resolve: resolveMock,
      resolveFromLocal: resolveFromLocalMock,
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return tags from resolver', async () => {
    const tags = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'MyApp' },
    ];
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags }),
    );

    const result = await resolveItemHeaders(TEST_ID, dataItemMetaResolver);

    assert.deepStrictEqual(result?.tags, tags);
    assert.strictEqual(resolveFromLocalMock.mock.calls.length, 1);
  });

  it('should return undefined when resolver returns nothing', async () => {
    const result = await resolveItemHeaders(TEST_ID, dataItemMetaResolver);
    assert.strictEqual(result, undefined);
  });

  it('should return empty tags array when resolver returns meta without tags', async () => {
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags: undefined }),
    );

    const result = await resolveItemHeaders(TEST_ID, dataItemMetaResolver);
    assert.deepStrictEqual(result?.tags, []);
  });

  it('should propagate errors from resolver', async () => {
    const resolverError = new Error('Resolver failed');
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.reject(resolverError),
    );

    await assert.rejects(
      () => resolveItemHeaders(TEST_ID, dataItemMetaResolver),
      resolverError,
    );
  });

  it('should return all verification fields from resolver', async () => {
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        signature: 'test-sig',
        signatureType: 1,
        owner: 'test-owner-key',
        ownerAddress: 'test-owner-address',
        target: 'test-target',
        anchor: 'test-anchor',
        tags: [{ name: 'App-Name', value: 'TestApp' }],
        dataSize: 100,
      }),
    );

    const result = await resolveItemHeaders(TEST_ID, dataItemMetaResolver);

    assert.strictEqual(result?.signature, 'test-sig');
    assert.strictEqual(result?.owner, 'test-owner-key');
    assert.strictEqual(result?.ownerAddress, 'test-owner-address');
    assert.strictEqual(result?.target, 'test-target');
    assert.strictEqual(result?.anchor, 'test-anchor');
    assert.strictEqual(result?.signatureType, 1);
  });

  it('should return empty signature and owner when DB lacks them', async () => {
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        signature: '',
        owner: '',
        ownerAddress: 'some-address',
        target: '',
        anchor: '',
        tags: [{ name: 'Content-Type', value: 'image/png' }],
        dataSize: 50,
      }),
    );

    const result = await resolveItemHeaders(TEST_ID, dataItemMetaResolver);

    assert.strictEqual(result?.signature, '');
    assert.strictEqual(result?.owner, '');
    assert.deepStrictEqual(result?.tags, [
      { name: 'Content-Type', value: 'image/png' },
    ]);
  });
});
