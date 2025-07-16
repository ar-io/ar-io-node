/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import * as winston from 'winston';
import crypto from 'node:crypto';

import { FsChunkDataStore } from './fs-chunk-data-store.js';
import { ChunkData } from '../types.js';

describe('FsChunkDataStore', () => {
  let log: winston.Logger;
  let tempDir: string;
  let store: FsChunkDataStore;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = mkdtempSync(join(tmpdir(), 'fs-chunk-data-store-test-'));
    store = new FsChunkDataStore({ log, baseDir: tempDir });
  });

  afterEach(() => {
    // Clean up the temporary directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('set', () => {
    it('should save chunk data to the correct path', async () => {
      const dataRoot = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.from('test chunk data'),
        hash: crypto.createHash('sha256').update('test chunk data').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);

      // Verify the file was created at the expected path
      const expectedPath = join(
        tempDir,
        'by-dataroot',
        'wR',
        'q6',
        dataRoot,
        relativeOffset.toString(),
      );
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(expectedPath));

      // Verify the content
      const savedContent = fs.readFileSync(expectedPath);
      assert.deepEqual(savedContent, chunkData.chunk);
    });

    it('should create nested directory structure', async () => {
      const dataRoot = '3nH8US975eWwHT-hG9HSdXFxH0FiMBBMHw6D_eBC7C0';
      const relativeOffset = 1048576;
      const chunkData: ChunkData = {
        chunk: Buffer.from('another chunk'),
        hash: crypto.createHash('sha256').update('another chunk').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);

      // Verify directory structure
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(join(tempDir, 'by-dataroot')));
      assert.ok(fs.existsSync(join(tempDir, 'by-dataroot', '3n')));
      assert.ok(fs.existsSync(join(tempDir, 'by-dataroot', '3n', 'H8')));
      assert.ok(
        fs.existsSync(join(tempDir, 'by-dataroot', '3n', 'H8', dataRoot)),
      );
    });

    it('should handle multiple chunks for the same data root', async () => {
      const dataRoot = 'kB-rvhmqrG0CNSEY7KLuje2EdQgbsBMeL9Ck1-fC2es';
      const chunks = [
        { offset: 0, data: Buffer.from('chunk 0') },
        { offset: 262144, data: Buffer.from('chunk 1') },
        { offset: 524288, data: Buffer.from('chunk 2') },
      ];

      for (const { offset, data } of chunks) {
        const chunkData: ChunkData = {
          chunk: data,
          hash: crypto.createHash('sha256').update(data).digest(),
        };
        await store.set(dataRoot, offset, chunkData);
      }

      // Verify all chunks were saved
      const fs = await import('node:fs');
      for (const { offset } of chunks) {
        const path = join(
          tempDir,
          'by-dataroot',
          'kB',
          '-r',
          dataRoot,
          offset.toString(),
        );
        assert.ok(fs.existsSync(path));
      }
    });

    it('should overwrite existing chunk data', async () => {
      const dataRoot = 'QUkmf47wCb77v7IG42spdNgJbmtPn_2DUfQtgpxRYvg';
      const relativeOffset = 0;

      const originalData: ChunkData = {
        chunk: Buffer.from('original data'),
        hash: crypto.createHash('sha256').update('original data').digest(),
      };

      const newData: ChunkData = {
        chunk: Buffer.from('new data'),
        hash: crypto.createHash('sha256').update('new data').digest(),
      };

      await store.set(dataRoot, relativeOffset, originalData);
      await store.set(dataRoot, relativeOffset, newData);

      // Verify the new data overwrote the original
      const fs = await import('node:fs');
      const path = join(tempDir, 'by-dataroot', 'QU', 'km', dataRoot, '0');
      const savedContent = fs.readFileSync(path);
      assert.deepEqual(savedContent, newData.chunk);
    });
  });

  describe('get', () => {
    it('should retrieve previously saved chunk data', async () => {
      const dataRoot = 'jVn_rdsZx2nHYgKhhI25MzveuYvH7rCd8J0WIVp4EVs';
      const relativeOffset = 1024;
      const originalChunk = Buffer.from('test data for retrieval');
      const chunkData: ChunkData = {
        chunk: originalChunk,
        hash: crypto.createHash('sha256').update(originalChunk).digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.chunk, originalChunk);
      assert.deepEqual(retrieved.hash, chunkData.hash);
    });

    it('should return undefined for non-existent chunk', async () => {
      const result = await store.get('non-existent-root', 0);
      assert.strictEqual(result, undefined);
    });

    it('should calculate hash correctly when retrieving', async () => {
      const dataRoot = 'l14EgjvxeJeH6qJ4yqWQEQXy7UMPctMPAW26Ean-QEE';
      const relativeOffset = 0;
      const chunkContent = Buffer.from('content for hash verification');
      const expectedHash = crypto
        .createHash('sha256')
        .update(chunkContent)
        .digest();

      // Manually create the file to ensure we're testing hash calculation
      const fs = await import('node:fs');
      const dir = join(tempDir, 'by-dataroot', 'l1', '4E', dataRoot);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, '0'), chunkContent);

      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.hash, expectedHash);
    });

    it('should return undefined when file read fails', async () => {
      const dataRoot = 'SwiDNS9zjqMk0MZDAxW2yV_8gmdFmOmJpmq869u9STM';
      const relativeOffset = 0;

      // Create a directory instead of a file to cause read error
      const fs = await import('node:fs');
      const path = join(tempDir, 'by-dataroot', 'Sw', 'iD', dataRoot, '0');
      fs.mkdirSync(path, { recursive: true });

      const result = await store.get(dataRoot, relativeOffset);
      assert.strictEqual(result, undefined);
    });
  });

  describe('has', () => {
    it('should return true for existing chunk', async () => {
      const dataRoot = 'YCBTU_-umYKVoBT_YtX0_rghFSl1bVROJydZQc_Dh4g';
      const relativeOffset = 2048;
      const chunkData: ChunkData = {
        chunk: Buffer.from('chunk for has test'),
        hash: crypto.createHash('sha256').update('chunk for has test').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const exists = await store.has(dataRoot, relativeOffset);

      assert.strictEqual(exists, true);
    });

    it('should return false for non-existent chunk', async () => {
      const exists = await store.has('non-existent-root', 999);
      assert.strictEqual(exists, false);
    });

    it('should return false when directory exists but file does not', async () => {
      const dataRoot = 'aQHTabwvnlgqBDDgJmd_yhrp89gJCfbvwa8PgeOp4cI';

      // Create the directory structure without the file
      const fs = await import('node:fs');
      const dir = join(tempDir, 'by-dataroot', 'aQ', 'HT', dataRoot);
      fs.mkdirSync(dir, { recursive: true });

      const exists = await store.has(dataRoot, 0);
      assert.strictEqual(exists, false);
    });
  });

  describe('edge cases', () => {
    it('should handle very large relative offsets', async () => {
      const dataRoot = 'mLcNjqsYgNAeDWQCIhXATDkWtQ7739rJ2AbX3W6UTjo';
      const relativeOffset = 2147483647; // Max 32-bit integer
      const chunkData: ChunkData = {
        chunk: Buffer.from('large offset test'),
        hash: crypto.createHash('sha256').update('large offset test').digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.deepEqual(retrieved.chunk, chunkData.chunk);
    });

    it('should handle empty chunk data', async () => {
      const dataRoot = 'tne4Fh9gC2AYX_ZUO5fV_ppKe0pwCwjOK4uTtg1OIjk';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.alloc(0),
        hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest(),
      };

      await store.set(dataRoot, relativeOffset, chunkData);
      const retrieved = await store.get(dataRoot, relativeOffset);

      assert.ok(retrieved);
      assert.strictEqual(retrieved.chunk.length, 0);
    });
  });

  describe('error handling', () => {
    it('should handle write permission errors gracefully', async () => {
      const dataRoot = 'wD75deO8zEyEDs3iI2b_IPpw6kZ2hTfCEXGOrm0Xtpg';
      const relativeOffset = 0;
      const chunkData: ChunkData = {
        chunk: Buffer.from('permission test'),
        hash: crypto.createHash('sha256').update('permission test').digest(),
      };

      // Make the base directory read-only
      const fs = await import('node:fs');
      const baseDir = join(tempDir, 'by-dataroot');
      fs.mkdirSync(baseDir);
      fs.chmodSync(baseDir, 0o444);

      try {
        // This should not throw, just log the error
        await store.set(dataRoot, relativeOffset, chunkData);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(baseDir, 0o755);
      }

      // Verify nothing was written
      const exists = await store.has(dataRoot, relativeOffset);
      assert.strictEqual(exists, false);
    });
  });
});
