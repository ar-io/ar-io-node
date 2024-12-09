/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { strict as assert } from 'node:assert';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { EventEmitter } from 'node:events';
import { default as wait } from 'wait';

import { StandaloneSqliteDatabase } from '../../src/database/standalone-sqlite.js';
import { BlockImporter } from '../../src/workers/block-importer.js';
import {
  bundlesDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ArweaveChainSourceStub } from '../../test/stubs.js';
import * as winston from 'winston';

describe('BlockImporter', () => {
  let log: winston.Logger;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainSource: ArweaveChainSourceStub;
  let db: StandaloneSqliteDatabase;

  const createBlockImporter = ({
    startHeight,
    stopHeight,
    heightPollingIntervalMs,
  }: {
    startHeight: number;
    stopHeight?: number;
    heightPollingIntervalMs?: number;
  }) => {
    return new BlockImporter({
      log,
      chainSource,
      chainIndex: db,
      eventEmitter,
      startHeight,
      stopHeight,
      heightPollingIntervalMs,
    });
  };

  before(async () => {
    log = winston.createLogger({ silent: true });
    eventEmitter = new EventEmitter();
    chainSource = new ArweaveChainSourceStub();
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

  afterEach(async () => {
    await blockImporter.stop();
  });

  describe('importBlock', () => {
    describe('importing a block', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 982575 });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await db.getMaxHeight();
        assert.equal(maxHeight, 982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.newBlocks, 1);
      });

      it("should add the block's transactions to the DB", async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.newTxs, 3);
      });
    });

    describe('importing a block with missing transactions', () => {
      beforeEach(async () => {
        chainSource.addMissingTxIds([
          'oq-v4Cv61YAGmY_KlLdxmGp5HjcldvOSLOMv0UPjSTE',
        ]);
        blockImporter = createBlockImporter({ startHeight: 982575 });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await db.getMaxHeight();
        assert.equal(maxHeight, 982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.newBlocks, 1);
      });

      it("should add the block's transactions to the DB", async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.newTxs, 2);
      });

      it('should add the IDs of the missing transactions to DB', async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.missingTxs, 1);
      });
    });

    describe('attempting to import a block with a gap before it', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        await blockImporter.importBlock(1);
        await blockImporter.importBlock(6);
      });

      it('should import the first block at the start of the gap', async () => {
        const stats = await db.getDebugInfo();
        assert.equal(stats.counts.newBlocks, 2);
      });

      it('should import only 1 block', async () => {
        const maxHeight = await db.getMaxHeight();
        assert.equal(maxHeight, 2);
      });
    });

    describe('attempting to import a block after a fork', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        chainSource.setTempBlockIdOverride(
          2,
          'JRhPWF4b66QtiYXe-nBHhj6nKVc7oFgvnwOEqhWmfUGdronQUeOUkyI789uBSGPP',
        );
        await blockImporter.importBlock(1);
      });

      it('should reset the height to where the fork occured', async () => {
        await blockImporter.importBlock(2);
        const maxHeight = await db.getMaxHeight();
        assert.equal(maxHeight, 1);
      });

      it('should reimport the block where the fork occured', async () => {
        mock.method(db, 'saveBlockAndTxs');
        await blockImporter.importBlock(2);
        assert.equal((db.saveBlockAndTxs as any).mock.callCount(), 1);
        assert.equal(
          (db.saveBlockAndTxs as any).mock.calls[0].arguments[0].height,
          1,
        );
      });
    });

    describe('attempting to import a block following a gap that exceeds the max fork depth', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 0 });
      });

      it('should throw an exception', async () => {
        await assert.rejects(
          async () => {
            await blockImporter.importBlock(19);
          },
          {
            name: 'Error',
            message: 'Maximum fork depth exceeded',
          },
        );
      });
    });
  });

  describe('getNextHeight', () => {
    describe('when no blocks have been imported', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 0 });
      });

      it('should return the start height', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        assert.equal(nextHeight, 0);
      });
    });

    describe('when blocks have been imported but the chain is not fully synced', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        await blockImporter.importBlock(1);
      });

      it('should return one more than the max height in the DB', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        assert.equal(nextHeight, 2);
      });
    });

    describe('when the chain is fully synced', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({
          startHeight: 1,
          heightPollingIntervalMs: 5,
        });
        chainSource.setHeight(1);
        await blockImporter.importBlock(1);
      });

      it('should wait for the next block to be produced', async () => {
        const nextHeightPromise = blockImporter.getNextHeight();

        const getNextHeightWaited = await Promise.race([
          (async () => {
            await wait(1);
            return true;
          })(),
          (async () => {
            await nextHeightPromise;
            return false;
          })(),
        ]);
        assert.ok(getNextHeightWaited);

        chainSource.setHeight(2);
        assert.equal(await nextHeightPromise, 2);
      });

      it('should return one more than the max height in the DB if multiple blocks are produced while waiting', async () => {
        const nextHeightPromise = blockImporter.getNextHeight();
        chainSource.setHeight(3);
        assert.equal(await nextHeightPromise, 2);
      });
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 1, stopHeight: 2 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      await blockImporter.start();
      await wait(5);
      await blockImporter.stop();
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 0, stopHeight: 1 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      await blockImporter.stop();
    });
  });
});
