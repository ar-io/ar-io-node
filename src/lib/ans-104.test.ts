/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isAcceptableBundleContentType } from './ans-104.js';

describe('isAcceptableBundleContentType (PE-9099)', () => {
  it('accepts undefined (legitimate upstreams may omit Content-Type)', () => {
    assert.equal(isAcceptableBundleContentType(undefined), true);
  });

  it('accepts null (SQLite-stored attributes surface as JS null)', () => {
    // Regression guard: prior version crashed with
    // "Cannot read properties of null (reading 'trim')" when called
    // from ReadThroughDataCache with a NULL stored content_type.
    assert.equal(isAcceptableBundleContentType(null), true);
  });

  it('accepts application/octet-stream', () => {
    assert.equal(
      isAcceptableBundleContentType('application/octet-stream'),
      true,
    );
  });

  it('accepts application/octet-stream with parameters', () => {
    assert.equal(
      isAcceptableBundleContentType('application/octet-stream; charset=binary'),
      true,
    );
  });

  it('accepts application/x-arweave-data', () => {
    assert.equal(
      isAcceptableBundleContentType('application/x-arweave-data'),
      true,
    );
  });

  it('accepts binary/octet-stream (legacy synonym for application/octet-stream)', () => {
    assert.equal(isAcceptableBundleContentType('binary/octet-stream'), true);
  });

  it('accepts variant casings and surrounding whitespace', () => {
    assert.equal(
      isAcceptableBundleContentType('Application/Octet-Stream'),
      true,
    );
    assert.equal(
      isAcceptableBundleContentType('  application/octet-stream  '),
      true,
    );
    assert.equal(
      isAcceptableBundleContentType('APPLICATION/X-ARWEAVE-DATA'),
      true,
    );
  });

  it('rejects text/html (the bundlr.network parking-page poison)', () => {
    assert.equal(
      isAcceptableBundleContentType('text/html; charset=utf-8'),
      false,
    );
    assert.equal(isAcceptableBundleContentType('text/html'), false);
  });

  it('rejects application/json', () => {
    assert.equal(isAcceptableBundleContentType('application/json'), false);
  });

  it('rejects unrelated content-types', () => {
    assert.equal(isAcceptableBundleContentType('image/png'), false);
    assert.equal(isAcceptableBundleContentType('video/mp4'), false);
    assert.equal(isAcceptableBundleContentType('text/plain'), false);
  });
});
