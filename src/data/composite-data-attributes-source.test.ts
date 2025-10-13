/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';

import { ContiguousDataAttributes, DataAttributesSource } from '../types.js';
import { CompositeDataAttributesSource } from './composite-data-attributes-source.js';
import { createTestLogger } from '../../test/test-logger.js';

const TEST_DATA_ATTRIBUTES: ContiguousDataAttributes = {
  hash: 'test-hash',
  dataRoot: 'test-data-root',
  size: 1024,
  offset: 0,
  contentType: 'application/octet-stream',
  isManifest: false,
  stable: true,
  verified: true,
  signature: 'test-signature',
};

class MockDataAttributesSource implements DataAttributesSource {
  private shouldFail: boolean;
  private delay: number;
  private name: string;
  private data: Map<string, ContiguousDataAttributes | undefined>;
  public callCount = 0;

  constructor(name: string, shouldFail = false, delay = 0) {
    this.name = name;
    this.shouldFail = shouldFail;
    this.delay = delay;
    this.data = new Map();
  }

  setData(id: string, attributes: ContiguousDataAttributes | undefined) {
    this.data.set(id, attributes);
  }

  async getDataAttributes(
    id: string,
  ): Promise<ContiguousDataAttributes | undefined> {
    this.callCount++;
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }
    if (this.shouldFail) {
      throw new Error(`${this.name} failed`);
    }

    const result = this.data.get(id);
    if (result) {
      return { ...result, hash: `${this.name}-${result.hash}` };
    }
    return undefined;
  }
}

describe('CompositeDataAttributesSource', () => {
  let log: ReturnType<typeof createTestLogger>;

  before(() => {
    log = createTestLogger({ suite: 'CompositeDataAttributesSource' });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should create instance with default cache size', () => {
      const source = new MockDataAttributesSource('source1');
      const composite = new CompositeDataAttributesSource({ log, source });
      assert.ok(composite !== undefined);
    });

    it('should create instance with custom cache size', () => {
      const source = new MockDataAttributesSource('source1');
      const composite = new CompositeDataAttributesSource({
        log,
        source,
        cacheSize: 5000,
      });
      assert.ok(composite !== undefined);
    });
  });

  describe('getDataAttributes', () => {
    it('should return data from source on cache miss', async () => {
      const source = new MockDataAttributesSource('source1');
      source.setData('test-id', TEST_DATA_ATTRIBUTES);
      const composite = new CompositeDataAttributesSource({ log, source });

      const result = await composite.getDataAttributes('test-id');

      assert.deepStrictEqual(result, {
        ...TEST_DATA_ATTRIBUTES,
        hash: 'source1-test-hash',
      });
      assert.strictEqual(source.callCount, 1);
    });

    it('should return cached data on cache hit', async () => {
      const source = new MockDataAttributesSource('source1');
      source.setData('test-id', TEST_DATA_ATTRIBUTES);
      const composite = new CompositeDataAttributesSource({ log, source });

      // First call - should hit source
      const result1 = await composite.getDataAttributes('test-id');
      assert.strictEqual(source.callCount, 1);

      // Second call - should hit cache
      const result2 = await composite.getDataAttributes('test-id');
      assert.strictEqual(source.callCount, 1); // No additional calls
      assert.deepStrictEqual(result1, result2);
    });

    it('should return undefined when source returns undefined', async () => {
      const source = new MockDataAttributesSource('source1');
      // Don't set any data
      const composite = new CompositeDataAttributesSource({ log, source });

      const result = await composite.getDataAttributes('non-existent-id');

      assert.strictEqual(result, undefined);
      assert.strictEqual(source.callCount, 1);
    });

    it('should propagate errors from source', async () => {
      const source = new MockDataAttributesSource('source1', true); // shouldFail = true
      const composite = new CompositeDataAttributesSource({ log, source });

      await assert.rejects(
        async () => composite.getDataAttributes('test-id'),
        /source1 failed/,
      );
    });

    it('should handle concurrent requests with promise deduplication', async () => {
      const source = new MockDataAttributesSource('source1', false, 50); // 50ms delay
      source.setData('test-id', TEST_DATA_ATTRIBUTES);
      const composite = new CompositeDataAttributesSource({ log, source });

      // Start multiple concurrent requests
      const promises = [
        composite.getDataAttributes('test-id'),
        composite.getDataAttributes('test-id'),
        composite.getDataAttributes('test-id'),
      ];

      const results = await Promise.all(promises);

      // All results should be identical
      assert.deepStrictEqual(results[0], results[1]);
      assert.deepStrictEqual(results[1], results[2]);

      // Should only call source once due to promise deduplication
      assert.strictEqual(source.callCount, 1);
    });

    it('should handle different IDs independently', async () => {
      const source = new MockDataAttributesSource('source1');
      source.setData('id1', { ...TEST_DATA_ATTRIBUTES, hash: 'hash1' });
      source.setData('id2', { ...TEST_DATA_ATTRIBUTES, hash: 'hash2' });
      const composite = new CompositeDataAttributesSource({ log, source });

      const [result1, result2] = await Promise.all([
        composite.getDataAttributes('id1'),
        composite.getDataAttributes('id2'),
      ]);

      assert.strictEqual(result1?.hash, 'source1-hash1');
      assert.strictEqual(result2?.hash, 'source1-hash2');
      assert.strictEqual(source.callCount, 2);
    });

    it('should handle cache eviction with LRU policy', async () => {
      const source = new MockDataAttributesSource('source1');
      const composite = new CompositeDataAttributesSource({
        log,
        source,
        cacheSize: 2, // Small cache size
      });

      // Set up data for 3 different IDs
      source.setData('id1', { ...TEST_DATA_ATTRIBUTES, hash: 'hash1' });
      source.setData('id2', { ...TEST_DATA_ATTRIBUTES, hash: 'hash2' });
      source.setData('id3', { ...TEST_DATA_ATTRIBUTES, hash: 'hash3' });

      // Fill cache with id1 and id2
      await composite.getDataAttributes('id1');
      await composite.getDataAttributes('id2');
      assert.strictEqual(source.callCount, 2);

      // Access id3 - should evict id1 (least recently used)
      await composite.getDataAttributes('id3');
      assert.strictEqual(source.callCount, 3);

      // Access id1 again - should hit source since it was evicted
      await composite.getDataAttributes('id1');
      assert.strictEqual(source.callCount, 4);

      // Access id2 again - should hit source since it was evicted when id1 was cached
      await composite.getDataAttributes('id2');
      assert.strictEqual(source.callCount, 5); // Additional call since id2 was evicted
    });

    it('should clean up pending promises on error', async () => {
      const source = new MockDataAttributesSource('source1', true, 50); // shouldFail = true, 50ms delay
      const composite = new CompositeDataAttributesSource({ log, source });

      // Start concurrent requests that will fail
      const promises = [
        composite.getDataAttributes('test-id').catch(() => 'error1'),
        composite.getDataAttributes('test-id').catch(() => 'error2'),
      ];

      const results = await Promise.all(promises);

      assert.deepStrictEqual(results, ['error1', 'error2']);
      assert.strictEqual(source.callCount, 1);

      // Try again - should create new promise since previous one was cleaned up
      await assert.rejects(
        async () => composite.getDataAttributes('test-id'),
        /source1 failed/,
      );
      assert.strictEqual(source.callCount, 2);
    });
  });

  describe('setDataAttributes', () => {
    it('should cache new attributes', async () => {
      const source = new MockDataAttributesSource('source1');
      const composite = new CompositeDataAttributesSource({ log, source });

      // Set attributes directly in cache
      await composite.setDataAttributes('test-id', TEST_DATA_ATTRIBUTES);

      // Get should return cached data without hitting source
      const result = await composite.getDataAttributes('test-id');

      assert.deepStrictEqual(result, TEST_DATA_ATTRIBUTES);
      assert.strictEqual(source.callCount, 0); // Should not hit source
    });

    it('should merge with existing cached attributes', async () => {
      const source = new MockDataAttributesSource('source1');
      const composite = new CompositeDataAttributesSource({ log, source });

      // First set some attributes
      await composite.setDataAttributes('test-id', {
        ...TEST_DATA_ATTRIBUTES,
        hash: 'original-hash',
        contentType: 'text/plain',
      });

      // Then merge with new attributes
      await composite.setDataAttributes('test-id', {
        hash: 'updated-hash',
        size: 2048,
        offset: 100,
        parentId: 'parent-123',
      });

      // Get should return merged attributes
      const result = await composite.getDataAttributes('test-id');

      assert.strictEqual(result?.hash, 'updated-hash'); // Updated
      assert.strictEqual(result?.size, 2048); // Updated
      assert.strictEqual(result?.offset, 100); // Updated
      assert.strictEqual(result?.parentId, 'parent-123'); // New
      assert.strictEqual(result?.contentType, 'text/plain'); // Preserved
      assert.strictEqual(result?.dataRoot, TEST_DATA_ATTRIBUTES.dataRoot); // Preserved
      assert.strictEqual(source.callCount, 0); // Should not hit source
    });

    it('should replace cached data from source on set', async () => {
      const source = new MockDataAttributesSource('source1');
      source.setData('test-id', TEST_DATA_ATTRIBUTES);
      const composite = new CompositeDataAttributesSource({ log, source });

      // First get from source to populate cache
      const result1 = await composite.getDataAttributes('test-id');
      assert.strictEqual(result1?.hash, 'source1-test-hash');
      assert.strictEqual(source.callCount, 1);

      // Set new attributes - should merge with cached data
      await composite.setDataAttributes('test-id', {
        hash: 'manual-hash',
        parentId: 'parent-456',
      });

      // Get should return merged data from cache
      const result2 = await composite.getDataAttributes('test-id');
      assert.strictEqual(result2?.hash, 'manual-hash'); // Overwritten
      assert.strictEqual(result2?.parentId, 'parent-456'); // New
      assert.strictEqual(result2?.size, TEST_DATA_ATTRIBUTES.size); // Preserved
      assert.strictEqual(source.callCount, 1); // No additional source calls
    });
  });
});
