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

import { Cdb64RootTxIndex } from './cdb64-root-tx-index.js';
import { Cdb64Writer } from '../lib/cdb64.js';
import { encodeCdb64Value } from '../lib/cdb64-encoding.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'Cdb64RootTxIndex' });

describe('Cdb64RootTxIndex', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdb64-index-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a 32-byte buffer from a seed
  const createTxId = (seed: number): Buffer => {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      buf[i] = (seed + i) % 256;
    }
    return buf;
  };

  // Helper to create a test CDB64 file with given entries
  const createTestCdb = async (
    cdbPath: string,
    entries: Array<{
      dataItemId: Buffer;
      rootTxId: Buffer;
      rootDataItemOffset?: number;
      rootDataOffset?: number;
    }>,
  ): Promise<void> => {
    const writer = new Cdb64Writer(cdbPath);
    await writer.open();

    for (const entry of entries) {
      const value =
        entry.rootDataItemOffset !== undefined &&
        entry.rootDataOffset !== undefined
          ? {
              rootTxId: entry.rootTxId,
              rootDataItemOffset: entry.rootDataItemOffset,
              rootDataOffset: entry.rootDataOffset,
            }
          : { rootTxId: entry.rootTxId };

      await writer.add(entry.dataItemId, encodeCdb64Value(value));
    }

    await writer.finalize();
  };

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', async () => {
      const cdbPath = path.join(tempDir, 'test.cdb');
      await createTestCdb(cdbPath, []);

      const index = new Cdb64RootTxIndex({ log, cdbPath });
      assert(typeof index.getRootTx === 'function');
      await index.close();
    });
  });

  describe('getRootTx', () => {
    it('should return root TX info for existing data item (simple format)', async () => {
      const cdbPath = path.join(tempDir, 'simple.cdb');
      const dataItemId = createTxId(1);
      const rootTxId = createTxId(100);

      await createTestCdb(cdbPath, [{ dataItemId, rootTxId }]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.rootDataOffset, undefined);

      await index.close();
    });

    it('should return root TX info with offsets (complete format)', async () => {
      const cdbPath = path.join(tempDir, 'complete.cdb');
      const dataItemId = createTxId(2);
      const rootTxId = createTxId(200);
      const rootDataItemOffset = 12345;
      const rootDataOffset = 67890;

      await createTestCdb(cdbPath, [
        { dataItemId, rootTxId, rootDataItemOffset, rootDataOffset },
      ]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });
      const result = await index.getRootTx(toB64Url(dataItemId));

      assert(result !== undefined);
      assert.equal(result.rootTxId, toB64Url(rootTxId));
      assert.equal(result.rootOffset, rootDataItemOffset);
      assert.equal(result.rootDataOffset, rootDataOffset);

      await index.close();
    });

    it('should return undefined for missing data item', async () => {
      const cdbPath = path.join(tempDir, 'missing.cdb');
      const existingId = createTxId(1);
      const missingId = createTxId(999);

      await createTestCdb(cdbPath, [
        { dataItemId: existingId, rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });
      const result = await index.getRootTx(toB64Url(missingId));

      assert.equal(result, undefined);

      await index.close();
    });

    it('should handle multiple lookups', async () => {
      const cdbPath = path.join(tempDir, 'multiple.cdb');
      const entries = [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
        {
          dataItemId: createTxId(2),
          rootTxId: createTxId(200),
          rootDataItemOffset: 1000,
          rootDataOffset: 2000,
        },
        { dataItemId: createTxId(3), rootTxId: createTxId(300) },
      ];

      await createTestCdb(cdbPath, entries);

      const index = new Cdb64RootTxIndex({ log, cdbPath });

      // Test all entries
      for (const entry of entries) {
        const result = await index.getRootTx(toB64Url(entry.dataItemId));
        assert(result !== undefined);
        assert.equal(result.rootTxId, toB64Url(entry.rootTxId));
      }

      // Test missing entry
      const missingResult = await index.getRootTx(toB64Url(createTxId(999)));
      assert.equal(missingResult, undefined);

      await index.close();
    });

    it('should return undefined when CDB file does not exist', async () => {
      const cdbPath = path.join(tempDir, 'nonexistent.cdb');

      const index = new Cdb64RootTxIndex({ log, cdbPath });
      const result = await index.getRootTx(toB64Url(createTxId(1)));

      assert.equal(result, undefined);
    });

    it('should return undefined for invalid ID length', async () => {
      const cdbPath = path.join(tempDir, 'valid.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });

      // Use a short ID (not 32 bytes when decoded)
      const shortId = toB64Url(Buffer.from('short'));
      const result = await index.getRootTx(shortId);

      assert.equal(result, undefined);

      await index.close();
    });

    it('should initialize lazily on first lookup', async () => {
      const cdbPath = path.join(tempDir, 'lazy.cdb');
      const dataItemId = createTxId(1);
      const rootTxId = createTxId(100);

      await createTestCdb(cdbPath, [{ dataItemId, rootTxId }]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });

      // First lookup should trigger initialization
      const result1 = await index.getRootTx(toB64Url(dataItemId));
      assert(result1 !== undefined);

      // Second lookup should use already-initialized reader
      const result2 = await index.getRootTx(toB64Url(dataItemId));
      assert(result2 !== undefined);
      assert.equal(result1.rootTxId, result2.rootTxId);

      await index.close();
    });
  });

  describe('close', () => {
    it('should close without error when initialized', async () => {
      const cdbPath = path.join(tempDir, 'close.cdb');
      await createTestCdb(cdbPath, [
        { dataItemId: createTxId(1), rootTxId: createTxId(100) },
      ]);

      const index = new Cdb64RootTxIndex({ log, cdbPath });

      // Trigger initialization
      await index.getRootTx(toB64Url(createTxId(1)));

      // Close should succeed
      await index.close();
    });

    it('should close without error when not initialized', async () => {
      const cdbPath = path.join(tempDir, 'uninitialized.cdb');

      const index = new Cdb64RootTxIndex({ log, cdbPath });

      // Close without ever calling getRootTx
      await index.close();
    });
  });
});
