/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { EventEmitter } from 'node:events';
import * as promClient from 'prom-client';
import * as sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { default as wait } from 'wait';

import { StandaloneSqliteDatabase } from '../../src/database/standalone-sqlite.js';
import log from '../../src/log.js';
import { BlockImporter } from '../../src/workers/block-importer.js';
import {
  bundlesDbPath,
  coreDbPath,
  dataDbPath,
  moderationDbPath,
} from '../../test/sqlite-helpers.js';
import { ArweaveChainSourceStub } from '../../test/stubs.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);

describe('BlockImporter', () => {
  let metricsRegistry: promClient.Registry;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainSource: ArweaveChainSourceStub;
  let db: StandaloneSqliteDatabase;
  let sandbox: sinon.SinonSandbox;

  const createBlockImporter = ({
    startHeight,
    heightPollingIntervalMs,
  }: {
    startHeight: number;
    heightPollingIntervalMs?: number;
  }) => {
    return new BlockImporter({
      log,
      metricsRegistry,
      errorsCounter: new promClient.Counter({
        name: 'errors_total',
        help: 'Total error count',
      }),
      chainSource,
      chainIndex: db,
      eventEmitter,
      startHeight,
      heightPollingIntervalMs,
    });
  };

  before(async () => {
    metricsRegistry = promClient.register;
    metricsRegistry.clear();
    eventEmitter = new EventEmitter();
    chainSource = new ArweaveChainSourceStub();
    db = new StandaloneSqliteDatabase({
      log,
      metricsRegistry,
      bundlesDbPath,
      coreDbPath,
      dataDbPath,
      moderationDbPath,
    });
  });

  after(async () => {
    db.stop();
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    metricsRegistry = promClient.register;
    metricsRegistry.clear();
  });

  afterEach(async () => {
    sandbox.restore();
  });

  describe('importBlock', () => {
    describe('importing a block', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 982575 });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await db.getMaxHeight();
        expect(maxHeight).to.equal(982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await db.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(1);
      });

      it("should add the block's transactions to the DB", async () => {
        const stats = await db.getDebugInfo();
        expect(stats.counts.newTxs).to.equal(3);
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
        expect(maxHeight).to.equal(982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await db.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(1);
      });

      it("should add the block's transactions to the DB", async () => {
        const stats = await db.getDebugInfo();
        expect(stats.counts.newTxs).to.equal(2);
      });

      it('should add the IDs of the missing transactions to DB', async () => {
        const stats = await db.getDebugInfo();
        expect(stats.counts.missingTxs).to.equal(1);
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
        expect(stats.counts.newBlocks).to.equal(2);
      });

      it('should import only 1 block', async () => {
        const maxHeight = await db.getMaxHeight();
        expect(maxHeight).to.equal(2);
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
        expect(maxHeight).to.equal(1);
      });

      it('should reimport the block where the fork occured', async () => {
        sandbox.spy(db, 'saveBlockAndTxs');
        await blockImporter.importBlock(2);
        expect(db.saveBlockAndTxs).to.have.been.calledOnce;
        expect(db.saveBlockAndTxs).to.have.been.calledWithMatch({
          height: 1,
        });
      });
    });

    describe('attempting to import a block following a gap that exceeds the max fork depth', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 0 });
      });

      it('should throw an exception', async () => {
        await expect(blockImporter.importBlock(51)).to.be.rejectedWith(
          'Maximum fork depth exceeded',
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
        expect(nextHeight).to.equal(0);
      });
    });

    describe('when blocks have been imported but the chain is not fully synced', () => {
      beforeEach(async () => {
        blockImporter = createBlockImporter({ startHeight: 1 });
        await blockImporter.importBlock(1);
      });

      it('should return one more than the max height in the DB', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        expect(nextHeight).to.equal(2);
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
        expect(getNextHeightWaited).to.be.true;

        chainSource.setHeight(2);
        expect(await nextHeightPromise).to.equal(2);
      });

      it('should return one more than the max height in the DB if multiple blocks are produced while waiting', async () => {
        const nextHeightPromise = blockImporter.getNextHeight();
        chainSource.setHeight(3);
        expect(await nextHeightPromise).to.equal(2);
      });
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 1 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      blockImporter.start();
      await wait(5);
      await blockImporter.stop();
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      blockImporter = createBlockImporter({ startHeight: 0 });
    });

    it('should not throw an exception when called (smoke test)', async () => {
      await blockImporter.stop();
    });
  });
});
