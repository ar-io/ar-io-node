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
  let txStoreGetMock: ReturnType<typeof mock.fn>;
  let resolveFromLocalMock: ReturnType<typeof mock.fn>;
  let resolveMock: ReturnType<typeof mock.fn>;
  let txStore: any;
  let dataItemMetaResolver: any;

  const TEST_ID = 'LXCrfCRLHB7YyLGAeQoio00qb7LwT3UO3a-2TSDli8Q';

  beforeEach(() => {
    txStoreGetMock = mock.fn(() => Promise.resolve(undefined));
    resolveFromLocalMock = mock.fn(() => Promise.resolve(undefined));
    resolveMock = mock.fn(() => Promise.resolve(undefined));

    txStore = {
      get: txStoreGetMock,
      has: mock.fn(),
      set: mock.fn(),
      del: mock.fn(),
    };

    dataItemMetaResolver = {
      resolve: resolveMock,
      resolveFromLocal: resolveFromLocalMock,
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('should return decoded tags from L1 txStore when tags are present', async () => {
    const b64Name = Buffer.from('Content-Type').toString('base64url');
    const b64Value = Buffer.from('application/json').toString('base64url');

    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        tags: [{ name: b64Name, value: b64Value }],
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, [
      { name: 'Content-Type', value: 'application/json' },
    ]);
    // Should not call the resolver when L1 has tags
    assert.strictEqual(resolveFromLocalMock.mock.calls.length, 0);
  });

  it('should return multiple decoded tags from L1 txStore', async () => {
    const tags = [
      {
        name: Buffer.from('Content-Type').toString('base64url'),
        value: Buffer.from('text/html').toString('base64url'),
      },
      {
        name: Buffer.from('App-Name').toString('base64url'),
        value: Buffer.from('MyApp').toString('base64url'),
      },
      {
        name: Buffer.from('App-Version').toString('base64url'),
        value: Buffer.from('1.0.0').toString('base64url'),
      },
    ];

    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.strictEqual(result.tags.length, 3);
    assert.deepStrictEqual(result.tags[0], {
      name: 'Content-Type',
      value: 'text/html',
    });
    assert.deepStrictEqual(result.tags[1], {
      name: 'App-Name',
      value: 'MyApp',
    });
    assert.deepStrictEqual(result.tags[2], {
      name: 'App-Version',
      value: '1.0.0',
    });
  });

  it('should fall back to L2 resolver when txStore returns undefined', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));

    const l2Tags = [
      { name: 'Content-Type', value: 'image/png' },
      { name: 'Bundle-Version', value: '2.0.0' },
    ];
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags: l2Tags }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, l2Tags);
    assert.strictEqual(txStoreGetMock.mock.calls.length, 1);
    assert.strictEqual(resolveFromLocalMock.mock.calls.length, 1);
  });

  it('should return L1 tx with empty tags without falling through to L2', async () => {
    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags: [], owner: 'some-key', target: '' }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, []);
    // Should NOT call the L2 resolver — L1 tx is a valid hit even with no tags
    assert.strictEqual(resolveFromLocalMock.mock.calls.length, 0);
  });

  it('should return L1 tx with null tags as empty array', async () => {
    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        tags: null,
        owner: 'some-key',
        target: '',
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, []);
    assert.strictEqual(resolveFromLocalMock.mock.calls.length, 0);
  });

  it('should return empty array when both L1 and L2 return nothing', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve(undefined),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, []);
  });

  it('should return empty array when L2 resolver returns meta without tags', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags: undefined }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, []);
  });

  it('should return L2 tags (already UTF-8, not base64url encoded)', async () => {
    // L2 tags come from the data item resolver and are already decoded strings
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));

    const l2Tags = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Custom-Tag', value: 'some value with spaces' },
    ];
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({ id: TEST_ID, tags: l2Tags }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    // L2 tags should be returned as-is (not double-decoded)
    assert.deepStrictEqual(result.tags, l2Tags);
  });

  it('should handle L1 tags with unicode values encoded in base64url', async () => {
    const unicodeValue = '\u4f60\u597d'; // Chinese characters
    const b64Name = Buffer.from('Greeting').toString('base64url');
    const b64Value = Buffer.from(unicodeValue, 'utf8').toString('base64url');

    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        tags: [{ name: b64Name, value: b64Value }],
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.deepStrictEqual(result.tags, [
      { name: 'Greeting', value: unicodeValue },
    ]);
  });

  it('should propagate errors from txStore.get', async () => {
    const storeError = new Error('Store connection failed');
    txStoreGetMock.mock.mockImplementation(() => Promise.reject(storeError));

    await assert.rejects(
      () => resolveItemHeaders(TEST_ID, txStore, dataItemMetaResolver),
      storeError,
    );
  });

  it('should propagate errors from resolver when txStore misses', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));

    const resolverError = new Error('Resolver failed');
    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.reject(resolverError),
    );

    await assert.rejects(
      () => resolveItemHeaders(TEST_ID, txStore, dataItemMetaResolver),
      resolverError,
    );
  });

  it('should return verification fields from L1 txStore', async () => {
    const b64Name = Buffer.from('Content-Type').toString('base64url');
    const b64Value = Buffer.from('text/plain').toString('base64url');

    txStoreGetMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        signature: 'l1-sig-base64url',
        owner: 'l1-owner-pubkey-base64url',
        target: 'some-target',
        last_tx: 'some-anchor',
        tags: [{ name: b64Name, value: b64Value }],
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.strictEqual(result.signature, 'l1-sig-base64url');
    assert.strictEqual(result.owner, 'l1-owner-pubkey-base64url');
    assert.ok(result.ownerAddress != null && result.ownerAddress.length > 0);
    assert.strictEqual(result.target, 'some-target');
    assert.strictEqual(result.anchor, 'some-anchor');
  });

  it('should return verification fields from L2 resolver', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));

    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        signature: 'l2-sig',
        signatureType: 1,
        owner: 'l2-owner-key',
        ownerAddress: 'l2-owner-address',
        target: 'l2-target',
        anchor: 'l2-anchor',
        tags: [{ name: 'App-Name', value: 'TestApp' }],
        dataSize: 100,
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.strictEqual(result.signature, 'l2-sig');
    assert.strictEqual(result.owner, 'l2-owner-key');
    assert.strictEqual(result.ownerAddress, 'l2-owner-address');
    assert.strictEqual(result.target, 'l2-target');
    assert.strictEqual(result.anchor, 'l2-anchor');
    assert.strictEqual(result.signatureType, 1);
  });

  it('should return empty signature and owner when DB lacks them', async () => {
    txStoreGetMock.mock.mockImplementation(() => Promise.resolve(undefined));

    resolveFromLocalMock.mock.mockImplementation(() =>
      Promise.resolve({
        id: TEST_ID,
        signature: '',
        signatureType: 1,
        owner: '',
        ownerAddress: 'some-address',
        target: '',
        anchor: '',
        tags: [{ name: 'Content-Type', value: 'image/png' }],
        dataSize: 50,
      }),
    );

    const result = await resolveItemHeaders(
      TEST_ID,
      txStore,
      dataItemMetaResolver,
    );

    assert.strictEqual(result.signature, '');
    assert.strictEqual(result.owner, '');
    assert.deepStrictEqual(result.tags, [
      { name: 'Content-Type', value: 'image/png' },
    ]);
  });
});
