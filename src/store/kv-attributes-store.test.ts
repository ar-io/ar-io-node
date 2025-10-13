/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { NodeKvStore } from './node-kv-store.js';
import {
  KvJsonStore,
  KvDataItemAttributesStore,
  KvTransactionAttributesStore,
} from './kv-attributes-store.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('KvJsonStore', () => {
  const key = 'testKey';

  describe('Generic KvJsonStore', () => {
    interface TestType {
      field1: string;
      field2: number;
    }

    let kvJsonStore: KvJsonStore<TestType>;
    let kvBufferStore: NodeKvStore;

    beforeEach(() => {
      kvBufferStore = new NodeKvStore({
        ttlSeconds: 100,
        maxKeys: 100,
      });

      kvJsonStore = new KvJsonStore<TestType>({
        log: createTestLogger({ suite: 'KvJsonStore' }),
        kvBufferStore,
      });
    });

    it('should properly set and get a JSON value', async () => {
      const value = { field1: 'test', field2: 123 };
      await kvJsonStore.set(key, value);
      const result = await kvJsonStore.get(key);
      assert.deepEqual(result, value);
    });

    it('should properly delete value', async () => {
      const value = { field1: 'test', field2: 123 };
      await kvJsonStore.set(key, value);
      await kvJsonStore.del(key);
      const result = await kvJsonStore.get(key);
      assert.equal(result, undefined);
    });

    it('should not override existing value when key already exists', async () => {
      const value1 = { field1: 'test1', field2: 123 };
      const value2 = { field1: 'test2', field2: 456 };

      await kvJsonStore.set(key, value1);
      await kvJsonStore.set(key, value2);

      const result = await kvJsonStore.get(key);
      assert.deepEqual(result, value1);
    });

    it('should handle invalid JSON data', async () => {
      // Directly set invalid JSON to the buffer store
      await kvBufferStore.set(key, Buffer.from('invalid json'));

      const result = await kvJsonStore.get(key);
      assert.equal(result, undefined);
    });

    it('should return undefined for non-existent key', async () => {
      const result = await kvJsonStore.get('nonexistent');
      assert.equal(result, undefined);
    });
  });

  describe('KvDataItemAttributesStore', () => {
    let dataItemStore: KvDataItemAttributesStore;
    let kvBufferStore: NodeKvStore;

    beforeEach(() => {
      kvBufferStore = new NodeKvStore({
        ttlSeconds: 100,
        maxKeys: 100,
      });

      dataItemStore = new KvDataItemAttributesStore({
        log: createTestLogger({ suite: 'KvJsonStore' }),
        kvBufferStore,
      });
    });

    it('should handle DataItemAttributes', async () => {
      const attributes = {
        parentId: 'parentid',
        signature: 'signature',
        signatureOffset: 1,
        signatureSize: 2,
        ownerOffset: 3,
        ownerSize: 4,
      };

      await dataItemStore.set(key, attributes);
      const result = await dataItemStore.get(key);
      assert.deepEqual(result, attributes);
    });
  });

  describe('KvTransactionAttributesStore', () => {
    let transactionStore: KvTransactionAttributesStore;
    let kvBufferStore: NodeKvStore;

    beforeEach(() => {
      kvBufferStore = new NodeKvStore({
        ttlSeconds: 100,
        maxKeys: 100,
      });

      transactionStore = new KvTransactionAttributesStore({
        log: createTestLogger({ suite: 'KvJsonStore' }),
        kvBufferStore,
      });
    });

    it('should handle TransactionAttributes', async () => {
      const attributes = {
        signature: 'signature',
        owner: 'owner',
      };

      await transactionStore.set(key, attributes);
      const result = await transactionStore.get(key);
      assert.deepEqual(result, attributes);
    });
  });
});
