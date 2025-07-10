/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach,
  mock,
} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import winston from 'winston';
import { tmpdir } from 'node:os';
import { TieredFsDataStore } from './tiered-fs-data-store.js';
import { FsDataStore } from './fs-data-store.js';
// Using any for database type since it just needs getDataRetention method

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function bufferToStream(buffer: Buffer): Promise<Readable> {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

describe('TieredFsDataStore', () => {
  let log: winston.Logger;
  let testRegularDir: string;
  let testRetentionDir: string;
  let regularStore: FsDataStore;
  let retentionStore: FsDataStore;
  let mockDb: any;
  let tieredStore: TieredFsDataStore;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  beforeEach(() => {
    // Create temporary directories
    testRegularDir = path.join(tmpdir(), `test-regular-${Date.now()}`);
    testRetentionDir = path.join(tmpdir(), `test-retention-${Date.now()}`);

    fs.mkdirSync(testRegularDir, { recursive: true });
    fs.mkdirSync(testRetentionDir, { recursive: true });

    // Create stores
    regularStore = new FsDataStore({ log, baseDir: testRegularDir });
    retentionStore = new FsDataStore({ log, baseDir: testRetentionDir });

    // Mock database
    mockDb = {
      getDataRetention: mock.fn(),
    } as any;
  });

  afterEach(() => {
    mock.restoreAll();
    // Clean up test directories
    fs.rmSync(testRegularDir, { recursive: true, force: true });
    fs.rmSync(testRetentionDir, { recursive: true, force: true });
  });

  describe('with retention store configured', () => {
    beforeEach(() => {
      tieredStore = new TieredFsDataStore({
        log,
        regularStore,
        retentionStore,
        db: mockDb,
      });
    });

    it('should store data in retention tier when retention policy exists', async () => {
      const hash = 'test-hash-with-retention';
      const data = Buffer.from('test data with retention');

      // Mock database to return retention policy
      (mockDb.getDataRetention as any).mock.mockImplementation(() =>
        Promise.resolve({
          retentionPolicyId: 'test-policy',
          retentionExpiresAt: Date.now() + 86400000, // 1 day from now
        }),
      );

      // Store data using write stream
      const writeStream = await tieredStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));
      await tieredStore.finalize(writeStream, hash);

      // Verify stored in retention tier
      const retentionData = await retentionStore.get(hash);
      assert.ok(retentionData);
      const retentionBuffer = await streamToBuffer(retentionData);
      assert.equal(retentionBuffer.toString(), 'test data with retention');

      // Note: Due to our implementation, data is first written to regular
      // then moved to retention, so regular store won't have it
    });

    it('should store data in regular tier when no retention policy', async () => {
      const hash = 'test-hash-no-retention';
      const data = Buffer.from('test data without retention');

      // Mock database to return no retention
      (mockDb.getDataRetention as any).mock.mockImplementation(() =>
        Promise.resolve(undefined),
      );

      // Store data using write stream
      const writeStream = await tieredStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));
      await tieredStore.finalize(writeStream, hash);

      // Verify stored in regular tier
      const regularData = await regularStore.get(hash);
      assert.ok(regularData);
      const regularBuffer = await streamToBuffer(regularData);
      assert.equal(regularBuffer.toString(), 'test data without retention');

      // Verify NOT stored in retention tier
      const retentionData = await retentionStore.get(hash);
      assert.equal(retentionData, undefined);
    });

    it('should read from retention tier first', async () => {
      const hash = 'test-hash-both-tiers';
      const retentionData = Buffer.from('retention tier data');
      const regularData = Buffer.from('regular tier data');

      // Store different data in both tiers directly
      const retentionStream = await retentionStore.createWriteStream();
      retentionStream.write(retentionData);
      retentionStream.end();
      await new Promise((resolve) => retentionStream.on('finish', resolve));
      await retentionStore.finalize(retentionStream, hash);

      const regularStream = await regularStore.createWriteStream();
      regularStream.write(regularData);
      regularStream.end();
      await new Promise((resolve) => regularStream.on('finish', resolve));
      await regularStore.finalize(regularStream, hash);

      // Read should return retention tier data
      const result = await tieredStore.get(hash);
      assert.ok(result);
      const resultBuffer = await streamToBuffer(result);
      assert.equal(resultBuffer.toString(), 'retention tier data');
    });

    it('should fall back to regular tier if not in retention tier', async () => {
      const hash = 'test-hash-regular-only';
      const data = Buffer.from('regular tier data only');

      // Store only in regular tier
      const regularStream = await regularStore.createWriteStream();
      regularStream.write(data);
      regularStream.end();
      await new Promise((resolve) => regularStream.on('finish', resolve));
      await regularStore.finalize(regularStream, hash);

      // Read should return regular tier data
      const result = await tieredStore.get(hash);
      assert.ok(result);
      const resultBuffer = await streamToBuffer(result);
      assert.equal(resultBuffer.toString(), 'regular tier data only');
    });

    it('should check both stores for has()', async () => {
      const hash1 = 'test-hash-retention-only';
      const hash2 = 'test-hash-regular-only';
      const hash3 = 'test-hash-neither';

      // Store in retention tier
      const retentionStream = await retentionStore.createWriteStream();
      retentionStream.write(Buffer.from('data'));
      retentionStream.end();
      await new Promise((resolve) => retentionStream.on('finish', resolve));
      await retentionStore.finalize(retentionStream, hash1);

      // Store in regular tier
      const regularStream = await regularStore.createWriteStream();
      regularStream.write(Buffer.from('data'));
      regularStream.end();
      await new Promise((resolve) => regularStream.on('finish', resolve));
      await regularStore.finalize(regularStream, hash2);

      assert.ok(await tieredStore.has(hash1));
      assert.ok(await tieredStore.has(hash2));
      assert.ok(!(await tieredStore.has(hash3)));
    });

    describe('migrateData', () => {
      it('should migrate from regular to retention tier', async () => {
        const hash = 'test-hash-migrate-to-retention';
        const data = Buffer.from('data to migrate');

        // Start with data in regular tier
        const regularStream = await regularStore.createWriteStream();
        regularStream.write(data);
        regularStream.end();
        await new Promise((resolve) => regularStream.on('finish', resolve));
        await regularStore.finalize(regularStream, hash);

        // Mock database to indicate retention policy now exists
        (mockDb.getDataRetention as any).mock.mockImplementation(() =>
          Promise.resolve({
            retentionPolicyId: 'new-policy',
            retentionExpiresAt: Date.now() + 86400000,
          }),
        );

        // Migrate
        await tieredStore.migrateData(hash);

        // Verify moved to retention tier
        assert.ok(await retentionStore.has(hash));
        // Note: We don't delete from regular store in current implementation
        assert.ok(await regularStore.has(hash));
      });

      it('should migrate from retention to regular tier', async () => {
        const hash = 'test-hash-migrate-to-regular';
        const data = Buffer.from('data to migrate back');

        // Start with data in retention tier
        const retentionStream = await retentionStore.createWriteStream();
        retentionStream.write(data);
        retentionStream.end();
        await new Promise((resolve) => retentionStream.on('finish', resolve));
        await retentionStore.finalize(retentionStream, hash);

        // Mock database to indicate no retention policy
        (mockDb.getDataRetention as any).mock.mockImplementation(() =>
          Promise.resolve(undefined),
        );

        // Migrate
        await tieredStore.migrateData(hash);

        // Verify moved to regular tier
        assert.ok(await regularStore.has(hash));
        // Note: We don't delete from retention store in current implementation
        assert.ok(await retentionStore.has(hash));
      });

      it('should not migrate if already in correct tier', async () => {
        const hash = 'test-hash-no-migration';
        const data = Buffer.from('data already in correct place');

        // Data in retention tier with retention policy
        const retentionStream = await retentionStore.createWriteStream();
        retentionStream.write(data);
        retentionStream.end();
        await new Promise((resolve) => retentionStream.on('finish', resolve));
        await retentionStore.finalize(retentionStream, hash);

        (mockDb.getDataRetention as any).mock.mockImplementation(() =>
          Promise.resolve({
            retentionPolicyId: 'existing-policy',
            retentionExpiresAt: Date.now() + 86400000,
          }),
        );

        // Migrate should do nothing
        await tieredStore.migrateData(hash);

        // Verify still in retention tier
        assert.ok(await retentionStore.has(hash));
        assert.ok(!(await regularStore.has(hash)));
      });
    });
  });

  describe('without retention store configured', () => {
    beforeEach(() => {
      tieredStore = new TieredFsDataStore({
        log,
        regularStore,
        retentionStore: undefined,
        db: mockDb,
      });
    });

    it('should always use regular store when retention store not configured', async () => {
      const hash = 'test-hash-no-retention-store';
      const data = Buffer.from('test data');

      // Mock database to return retention policy (should be ignored)
      (mockDb.getDataRetention as any).mock.mockImplementation(() =>
        Promise.resolve({
          retentionPolicyId: 'test-policy',
          retentionExpiresAt: Date.now() + 86400000,
        }),
      );

      // Store data using write stream
      const writeStream = await tieredStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));
      await tieredStore.finalize(writeStream, hash);

      // Verify stored in regular tier despite retention policy
      const regularData = await regularStore.get(hash);
      assert.ok(regularData);
      const regularBuffer = await streamToBuffer(regularData);
      assert.equal(regularBuffer.toString(), 'test data');
    });

    it('should handle all operations with only regular store', async () => {
      const hash = 'test-hash-regular-only-ops';
      const data = Buffer.from('test data for regular store');

      // Store
      const writeStream = await tieredStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));
      await tieredStore.finalize(writeStream, hash);

      // Get
      const result = await tieredStore.get(hash);
      assert.ok(result);

      // Has
      assert.ok(await tieredStore.has(hash));

      // Migrate should do nothing
      await tieredStore.migrateData(hash);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      tieredStore = new TieredFsDataStore({
        log,
        regularStore,
        retentionStore,
        db: mockDb,
      });

      const hash = 'test-hash-db-error';
      const data = Buffer.from('test data');

      // Mock database to throw error
      (mockDb.getDataRetention as any).mock.mockImplementation(() =>
        Promise.reject(new Error('Database error')),
      );

      // Should not throw, should fall back to regular store
      const writeStream = await tieredStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));

      await assert.doesNotReject(async () => {
        await tieredStore.finalize(writeStream, hash);
      });

      // Should be stored in regular store
      assert.ok(await regularStore.has(hash));
    });

    it('should handle partial reads with offset and size', async () => {
      tieredStore = new TieredFsDataStore({
        log,
        regularStore,
        retentionStore,
        db: mockDb,
      });

      const hash = 'test-hash-partial';
      const data = Buffer.from('0123456789abcdef');

      // Store data in regular store
      const writeStream = await regularStore.createWriteStream();
      writeStream.write(data);
      writeStream.end();
      await new Promise((resolve) => writeStream.on('finish', resolve));
      await regularStore.finalize(writeStream, hash);

      // Read partial data
      const result = await tieredStore.get(hash, { offset: 5, size: 5 });
      assert.ok(result);
      const resultBuffer = await streamToBuffer(result);
      assert.equal(resultBuffer.toString(), '56789');
    });
  });
});
