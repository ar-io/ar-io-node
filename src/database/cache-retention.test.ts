/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import winston from 'winston';
import { StandaloneSqliteDatabase } from './standalone-sqlite.js';
import {
  bundlesDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { toB64Url } from '../lib/encoding.js';

describe('Cache Retention Database Operations', () => {
  let log: winston.Logger;
  let db: StandaloneSqliteDatabase;

  before(async () => {
    log = winston.createLogger({ silent: true });
    db = new StandaloneSqliteDatabase({
      log,
      bundlesDbPath,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
      tagSelectivity: {},
    });
  });

  after(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    // Clear test data between tests
    await db['coreDb'].run('DELETE FROM stable_blocks');
    await db['dataDb'].run('DELETE FROM contiguous_data');
    await db['dataDb'].run('DELETE FROM contiguous_data_ids');
  });

  describe('saveDataContentAttributes with retention', () => {
    it('should save retention policy information', async () => {
      const testId = 'test-tx-123';
      const testHash = 'test-hash-abc';
      const testPolicyId = 'test-policy-7yr';
      const testExpiresAt = Date.now() + 7 * 365 * 24 * 60 * 60 * 1000; // 7 years

      await db.saveDataContentAttributes({
        id: testId,
        hash: testHash,
        dataSize: 1024,
        contentType: 'application/octet-stream',
        cachedAt: Date.now(),
        retentionPolicyId: testPolicyId,
        retentionExpiresAt: testExpiresAt,
      });

      // Verify the data was saved with retention info
      const result = await db.getDataRetention(testHash);
      assert.equal(result?.retentionPolicyId, testPolicyId);
      assert.equal(result?.retentionExpiresAt, testExpiresAt);
    });

    it('should save without retention policy', async () => {
      const testId = 'test-tx-456';
      const testHash = 'test-hash-def';

      await db.saveDataContentAttributes({
        id: testId,
        hash: testHash,
        dataSize: 2048,
        contentType: 'text/plain',
      });

      // Verify no retention info was saved
      const result = await db.getDataRetention(testHash);
      assert.equal(result?.retentionPolicyId, undefined);
      assert.equal(result?.retentionExpiresAt, undefined);
    });
  });

  describe('getDataRetention', () => {
    it('should return undefined for non-existent hash', async () => {
      const result = await db.getDataRetention('non-existent-hash');
      assert.equal(result, undefined);
    });

    it('should return retention data for existing hash', async () => {
      const testId = 'test-tx-789';
      const testHash = 'test-hash-ghi';
      const testPolicyId = 'ardrive-policy';
      const testExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;

      await db.saveDataContentAttributes({
        id: testId,
        hash: testHash,
        dataSize: 4096,
        retentionPolicyId: testPolicyId,
        retentionExpiresAt: testExpiresAt,
      });

      const result = await db.getDataRetention(testHash);
      assert.deepEqual(result, {
        retentionPolicyId: testPolicyId,
        retentionExpiresAt: testExpiresAt,
      });
    });

    it('should handle base64url encoded hashes', async () => {
      const testId = 'test-tx-b64';
      const rawHash = Buffer.from('test-hash-binary', 'utf-8');
      const b64Hash = toB64Url(rawHash);
      const testPolicyId = 'test-policy';
      const testExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

      await db.saveDataContentAttributes({
        id: testId,
        hash: b64Hash,
        dataSize: 512,
        retentionPolicyId: testPolicyId,
        retentionExpiresAt: testExpiresAt,
      });

      const result = await db.getDataRetention(b64Hash);
      assert.equal(result?.retentionPolicyId, testPolicyId);
      assert.equal(result?.retentionExpiresAt, testExpiresAt);
    });
  });

  describe('retention index performance', () => {
    it('should efficiently query data by retention expiry', async () => {
      // Add multiple items with different expiry times
      const now = Date.now();
      const items = [
        { id: 'tx1', hash: 'hash1', expiresAt: now - 1000 }, // expired
        { id: 'tx2', hash: 'hash2', expiresAt: now + 1000 }, // future
        { id: 'tx3', hash: 'hash3', expiresAt: now + 2000 }, // future
        { id: 'tx4', hash: 'hash4', expiresAt: undefined }, // no policy
        { id: 'tx5', hash: 'hash5', expiresAt: now - 2000 }, // expired
      ];

      for (const item of items) {
        await db.saveDataContentAttributes({
          id: item.id,
          hash: item.hash,
          dataSize: 100,
          retentionPolicyId:
            item.expiresAt !== undefined ? 'test-policy' : undefined,
          retentionExpiresAt: item.expiresAt,
        });
      }

      // Query using the index (this would be done in cleanup worker)
      const result = await db['dataDb']
        .prepare(
          `SELECT hash FROM contiguous_data 
         WHERE retention_expires_at IS NOT NULL 
           AND retention_expires_at < ?
         ORDER BY retention_expires_at`,
        )
        .all(now);

      // Should find the two expired items
      assert.equal(result.length, 2);
      const expiredHashes = result.map((r) => toB64Url(r.hash));
      assert.ok(expiredHashes.includes('hash1'));
      assert.ok(expiredHashes.includes('hash5'));
    });
  });
});
