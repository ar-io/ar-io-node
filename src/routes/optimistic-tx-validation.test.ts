/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  isL1TxHeader,
  validateOptimisticTxBatch,
} from './optimistic-tx-validation.js';

const validHeader = {
  id: 'tx-id',
  owner: 'owner-key',
  signature: 'sig',
  last_tx: 'anchor',
  data_root: 'root',
  data_size: '123',
};

describe('isL1TxHeader', () => {
  it('accepts a header with the required string fields', () => {
    assert.equal(isL1TxHeader(validHeader), true);
  });

  it('rejects non-objects and null', () => {
    assert.equal(isL1TxHeader(null), false);
    assert.equal(isL1TxHeader('x'), false);
    assert.equal(isL1TxHeader(42), false);
    assert.equal(isL1TxHeader(undefined), false);
  });

  it('rejects when a required field is missing or non-string', () => {
    assert.equal(isL1TxHeader({ ...validHeader, owner: undefined }), false);
    assert.equal(isL1TxHeader({ ...validHeader, id: 123 }), false);
    const { signature: _omit, ...noSig } = validHeader;
    assert.equal(isL1TxHeader(noSig), false);
  });
});

describe('validateOptimisticTxBatch', () => {
  const MAX = 100;

  it('accepts a single header (not wrapped in an array)', () => {
    const r = validateOptimisticTxBatch(validHeader, MAX);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.txs.length, 1);
  });

  it('accepts an array of headers', () => {
    const r = validateOptimisticTxBatch([validHeader, validHeader], MAX);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.txs.length, 2);
  });

  it('rejects an empty array', () => {
    const r = validateOptimisticTxBatch([], MAX);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 400);
  });

  it('rejects when any entry is not a valid header', () => {
    const r = validateOptimisticTxBatch([validHeader, { id: 'x' }], MAX);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 400);
  });

  it('accepts a batch exactly at the cap', () => {
    const batch = Array.from({ length: MAX }, () => validHeader);
    const r = validateOptimisticTxBatch(batch, MAX);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.txs.length, MAX);
  });

  it('rejects a batch over the cap with a 400 and a descriptive message', () => {
    const batch = Array.from({ length: MAX + 1 }, () => validHeader);
    const r = validateOptimisticTxBatch(batch, MAX);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 400);
    assert.ok(
      r.ok === false && r.message.includes('OPTIMISTIC_TX_MAX_BATCH_SIZE'),
      'message should name the env var',
    );
  });

  it('enforces the cap before per-tx work (cap of 1 rejects 2 valid headers)', () => {
    const r = validateOptimisticTxBatch([validHeader, validHeader], 1);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 400);
  });
});
