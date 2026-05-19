/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseChunkHeaderMetadata } from './chunk-header-parser.js';

const completeHeaders = {
  'x-arweave-chunk-tx-id': 'T3DcnZlZg_FqOQUf9MSZXQ5j7_ETc04OEqbkX-MZRnc',
  'x-arweave-chunk-tx-start-offset': '108631448658167',
  'x-arweave-chunk-tx-data-size': '42724169',
  'x-arweave-chunk-data-root': 'qoQEdVyTqjLpkybZAgkIgtNawXUHUd5TJZwkWx0Vo-A',
  'x-arweave-chunk-data-path': 'E2OKmVV7k4k',
  'x-arweave-chunk-tx-path': 'H9gNFx8dbHj',
  'x-arweave-chunk-start-offset': '108631449706743',
  'x-arweave-chunk-relative-start-offset': '1048576',
};

describe('parseChunkHeaderMetadata', () => {
  it('parses a complete set of headers', () => {
    const parsed = parseChunkHeaderMetadata(completeHeaders);
    assert.notEqual(parsed, null);
    assert.strictEqual(parsed!.txId, completeHeaders['x-arweave-chunk-tx-id']);
    assert.strictEqual(parsed!.txStartOffset, 108631448658167n);
    assert.strictEqual(parsed!.txDataSize, 42724169n);
    assert.strictEqual(parsed!.chunkStartOffset, 108631449706743n);
    assert.strictEqual(parsed!.chunkRelativeStartOffset, 1048576n);
    assert.strictEqual(
      parsed!.dataRoot,
      completeHeaders['x-arweave-chunk-data-root'],
    );
    assert.strictEqual(
      parsed!.dataPath,
      completeHeaders['x-arweave-chunk-data-path'],
    );
    assert.strictEqual(
      parsed!.txPath,
      completeHeaders['x-arweave-chunk-tx-path'],
    );
  });

  it('returns null when a required string header is missing', () => {
    const { ['x-arweave-chunk-tx-id']: _omit, ...missing } = completeHeaders;
    assert.strictEqual(parseChunkHeaderMetadata(missing), null);
  });

  it('returns null when a required string header is empty', () => {
    const empty = { ...completeHeaders, 'x-arweave-chunk-data-root': '' };
    assert.strictEqual(parseChunkHeaderMetadata(empty), null);
  });

  it('returns null when a numeric header is not parseable', () => {
    const malformed = {
      ...completeHeaders,
      'x-arweave-chunk-tx-start-offset': 'not-a-number',
    };
    assert.strictEqual(parseChunkHeaderMetadata(malformed), null);
  });

  it('returns null when a numeric header is negative', () => {
    const negative = {
      ...completeHeaders,
      'x-arweave-chunk-tx-data-size': '-1',
    };
    assert.strictEqual(parseChunkHeaderMetadata(negative), null);
  });

  it('preserves precision for offsets beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const headers = {
      ...completeHeaders,
      'x-arweave-chunk-tx-start-offset': huge,
    };
    const parsed = parseChunkHeaderMetadata(headers);
    assert.notEqual(parsed, null);
    assert.strictEqual(parsed!.txStartOffset, BigInt(huge));
  });

  it('takes the first value when a header is an array', () => {
    const arr = {
      ...completeHeaders,
      'x-arweave-chunk-tx-id': ['first-tx-id', 'second-tx-id'],
    };
    const parsed = parseChunkHeaderMetadata(arr);
    assert.notEqual(parsed, null);
    assert.strictEqual(parsed!.txId, 'first-tx-id');
  });
});
