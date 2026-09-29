/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { StandaloneSqliteDatabaseWorker } from './standalone-sqlite.js';
import { toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';
import {
  bundlesDbPath,
  chunksDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';

const log = createTestLogger();

const MANIFEST_A = toB64Url(Buffer.alloc(32, 1));
const MANIFEST_B = toB64Url(Buffer.alloc(32, 2));
const MANIFEST_C = toB64Url(Buffer.alloc(32, 3));
const MISSING = toB64Url(Buffer.alloc(32, 99));
const INDEX_ID = toB64Url(Buffer.alloc(32, 10));
const FALLBACK_ID = toB64Url(Buffer.alloc(32, 11));

describe('manifest_resolutions (data.db) worker methods', () => {
  let worker: StandaloneSqliteDatabaseWorker;

  before(() => {
    worker = new StandaloneSqliteDatabaseWorker({
      log,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      bundlesDbPath,
      chunksDbPath,
      tagSelectivity: {},
    });
  });

  it('round-trips index and fallback ids through save and get', () => {
    worker.saveManifestResolution({
      id: MANIFEST_A,
      indexId: INDEX_ID,
      fallbackId: FALLBACK_ID,
      resolvedAt: 1000,
    });

    const got = worker.getManifestResolution(MANIFEST_A);
    assert.ok(got);
    assert.equal(got.indexId, INDEX_ID);
    assert.equal(got.fallbackId, FALLBACK_ID);
  });

  it('stores an index-only resolution with an undefined fallback', () => {
    worker.saveManifestResolution({
      id: MANIFEST_B,
      indexId: INDEX_ID,
      resolvedAt: 1000,
    });

    const got = worker.getManifestResolution(MANIFEST_B);
    assert.ok(got);
    assert.equal(got.indexId, INDEX_ID);
    assert.equal(got.fallbackId, undefined);
  });

  it('preserves existing columns on upsert (COALESCE)', () => {
    // First store only the index id...
    worker.saveManifestResolution({
      id: MANIFEST_C,
      indexId: INDEX_ID,
      resolvedAt: 1000,
    });
    // ...then a later resolution supplies only the fallback id. The index id
    // must be preserved rather than overwritten with NULL.
    worker.saveManifestResolution({
      id: MANIFEST_C,
      fallbackId: FALLBACK_ID,
      resolvedAt: 2000,
    });

    const got = worker.getManifestResolution(MANIFEST_C);
    assert.ok(got);
    assert.equal(got.indexId, INDEX_ID);
    assert.equal(got.fallbackId, FALLBACK_ID);
  });

  it('returns undefined for an unknown manifest', () => {
    assert.equal(worker.getManifestResolution(MISSING), undefined);
  });
});
