/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { FileByteRangeSource, ByteRangeSource } from './byte-range-source.js';
import { CachingByteRangeSource } from './caching-byte-range-source.js';

describe('FileByteRangeSource', () => {
  let tempDir: string;
  let testFilePath: string;
  let testData: Buffer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byte-range-test-'));
    testFilePath = path.join(tempDir, 'test.bin');

    // Create test file with known content
    testData = Buffer.alloc(1024);
    for (let i = 0; i < testData.length; i++) {
      testData[i] = i % 256;
    }
    await fs.writeFile(testFilePath, testData);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should read bytes at the beginning of the file', async () => {
    const source = new FileByteRangeSource(testFilePath);
    await source.open();

    const result = await source.read(0, 16);
    assert.equal(result.length, 16);
    assert(result.equals(testData.subarray(0, 16)));

    await source.close();
  });

  it('should read bytes in the middle of the file', async () => {
    const source = new FileByteRangeSource(testFilePath);
    await source.open();

    const result = await source.read(100, 50);
    assert.equal(result.length, 50);
    assert(result.equals(testData.subarray(100, 150)));

    await source.close();
  });

  it('should read bytes at the end of the file', async () => {
    const source = new FileByteRangeSource(testFilePath);
    await source.open();

    const result = await source.read(1000, 24);
    assert.equal(result.length, 24);
    assert(result.equals(testData.subarray(1000, 1024)));

    await source.close();
  });

  it('should throw error when reading without opening', async () => {
    const source = new FileByteRangeSource(testFilePath);

    await assert.rejects(async () => {
      await source.read(0, 16);
    }, /not opened/);
  });

  it('should throw error when reading beyond file bounds', async () => {
    const source = new FileByteRangeSource(testFilePath);
    await source.open();

    await assert.rejects(async () => {
      await source.read(1000, 100); // Would read past end of 1024-byte file
    }, /Short read/);

    await source.close();
  });

  it('should report isOpen correctly', async () => {
    const source = new FileByteRangeSource(testFilePath);

    assert.equal(source.isOpen(), false);

    await source.open();
    assert.equal(source.isOpen(), true);

    await source.close();
    assert.equal(source.isOpen(), false);
  });

  it('should return the file path', async () => {
    const source = new FileByteRangeSource(testFilePath);
    assert.equal(source.getFilePath(), testFilePath);
  });

  it('should handle multiple reads', async () => {
    const source = new FileByteRangeSource(testFilePath);
    await source.open();

    const read1 = await source.read(0, 100);
    const read2 = await source.read(200, 100);
    const read3 = await source.read(500, 100);

    assert(read1.equals(testData.subarray(0, 100)));
    assert(read2.equals(testData.subarray(200, 300)));
    assert(read3.equals(testData.subarray(500, 600)));

    await source.close();
  });

  it('should handle opening twice (idempotent)', async () => {
    const source = new FileByteRangeSource(testFilePath);

    await source.open();
    await source.open(); // Should not throw

    const result = await source.read(0, 16);
    assert.equal(result.length, 16);

    await source.close();
  });
});

describe('CachingByteRangeSource', () => {
  let mockSource: MockByteRangeSource;

  class MockByteRangeSource implements ByteRangeSource {
    public data: Buffer;
    public readCalls: { offset: number; size: number }[] = [];
    private _isOpen = true;

    constructor(data: Buffer) {
      this.data = data;
    }

    async read(offset: number, size: number): Promise<Buffer> {
      this.readCalls.push({ offset, size });
      return this.data.subarray(offset, offset + size);
    }

    async close(): Promise<void> {
      this._isOpen = false;
    }

    isOpen(): boolean {
      return this._isOpen;
    }
  }

  beforeEach(() => {
    // Create mock with 8KB of test data (2x header size)
    const data = Buffer.alloc(8192);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }
    mockSource = new MockByteRangeSource(data);
  });

  it('should cache header reads (first 4KB)', async () => {
    const cachingSource = new CachingByteRangeSource({
      source: mockSource,
      headerSize: 4096,
    });

    // First read within header - should fetch from source
    const read1 = await cachingSource.read(0, 100);
    assert.equal(read1.length, 100);
    assert.equal(mockSource.readCalls.length, 1);
    assert.equal(mockSource.readCalls[0].offset, 0);
    assert.equal(mockSource.readCalls[0].size, 4096); // Reads full header

    // Second read within header - should use cache
    const read2 = await cachingSource.read(100, 100);
    assert.equal(read2.length, 100);
    assert.equal(mockSource.readCalls.length, 1); // No new reads

    // Third read within header - should use cache
    const read3 = await cachingSource.read(2000, 500);
    assert.equal(read3.length, 500);
    assert.equal(mockSource.readCalls.length, 1); // Still no new reads

    await cachingSource.close();
  });

  it('should cache non-header regions with LRU', async () => {
    const cachingSource = new CachingByteRangeSource({
      source: mockSource,
      headerSize: 4096,
      cacheMaxSize: 10,
    });

    // Read beyond header - should fetch from source
    const read1 = await cachingSource.read(5000, 100);
    assert.equal(read1.length, 100);
    // First call is header (implicit), second is the actual read
    const regionReadIndex = mockSource.readCalls.findIndex(
      (r) => r.offset === 5000,
    );
    assert(regionReadIndex >= 0);

    // Same read again - should use cache
    const callsBefore = mockSource.readCalls.length;
    const read2 = await cachingSource.read(5000, 100);
    assert.equal(read2.length, 100);
    assert.equal(mockSource.readCalls.length, callsBefore); // No new reads

    await cachingSource.close();
  });

  it('should handle reads spanning header and beyond', async () => {
    const cachingSource = new CachingByteRangeSource({
      source: mockSource,
      headerSize: 4096,
    });

    // Read that spans header boundary (starts at 4000, reads 200 bytes)
    const read = await cachingSource.read(4000, 200);
    assert.equal(read.length, 200);

    // Verify data is correct
    assert(read.equals(mockSource.data.subarray(4000, 4200)));

    await cachingSource.close();
  });

  it('should provide cache stats', async () => {
    const cachingSource = new CachingByteRangeSource({
      source: mockSource,
      headerSize: 4096,
    });

    let stats = cachingSource.getCacheStats();
    assert.equal(stats.headerCached, false);
    assert.equal(stats.regionCacheSize, 0);

    // Trigger header cache
    await cachingSource.read(0, 100);

    stats = cachingSource.getCacheStats();
    assert.equal(stats.headerCached, true);

    // Trigger region cache
    await cachingSource.read(5000, 100);

    stats = cachingSource.getCacheStats();
    assert.equal(stats.regionCacheSize, 1);

    await cachingSource.close();
  });

  it('should clear cache', async () => {
    const cachingSource = new CachingByteRangeSource({
      source: mockSource,
      headerSize: 4096,
    });

    // Populate caches
    await cachingSource.read(0, 100);
    await cachingSource.read(5000, 100);

    let stats = cachingSource.getCacheStats();
    assert.equal(stats.headerCached, true);
    assert.equal(stats.regionCacheSize, 1);

    // Clear
    cachingSource.clearCache();

    stats = cachingSource.getCacheStats();
    assert.equal(stats.headerCached, false);
    assert.equal(stats.regionCacheSize, 0);

    await cachingSource.close();
  });
});
