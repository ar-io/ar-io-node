/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';

import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { LmdbKVStore } from './lmdb-kv-store.js';

const tempLmdbDir = new URL('./lmdb', import.meta.url).pathname;

describe('LmdbKvStore', () => {
  const lmdbKvStore = new LmdbKVStore({
    dbPath: tempLmdbDir,
  });

  after(() => {
    if (fs.existsSync(tempLmdbDir)) {
      fs.rmSync(tempLmdbDir, { recursive: true });
    }
  });

  it('should properly set and get a buffer', async () => {
    const key = 'key';
    const value = fromB64Url('test');
    await lmdbKvStore.set(key, value);
    const result = await lmdbKvStore.get(key);
    assert.notEqual(result, undefined);
    assert.equal(toB64Url(result!), 'test');
  });

  it('should properly delete buffer', async () => {
    const key = 'key';
    const value = fromB64Url('test');
    await lmdbKvStore.set(key, value);
    await lmdbKvStore.del(key);
    const result = await lmdbKvStore.get(key);
    assert.equal(result, undefined);
  });

  it('should not override existing buffer when key already exists in cache', async () => {
    const key = 'key';
    const value = Buffer.from('test', 'base64url');
    await lmdbKvStore.set(key, value);
    await lmdbKvStore.set(key, Buffer.from('test2', 'base64url'));
    const result = await lmdbKvStore.get(key);
    assert.notEqual(result, undefined);

    assert.equal(toB64Url(result!), 'test');
  });

  it('should return a buffer when a Uint8Array is stored in the cache', async () => {
    const key = 'key';
    const value = new Uint8Array(Buffer.from('test', 'base64url'));
    // sanity check
    assert.equal(Buffer.isBuffer(value), false);
    // intentional cast as LMDB does this under the hood
    await lmdbKvStore.set(key, value as Buffer);
    const result = await lmdbKvStore.get(key);
    assert.notEqual(result, undefined);
    assert.equal(Buffer.isBuffer(result), true);
    assert.equal(toB64Url(result!), 'test');
  });
});
