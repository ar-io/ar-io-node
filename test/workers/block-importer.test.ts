import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { EventEmitter } from 'events';

import { BlockImporter } from '../../src/workers/block-importer.js';
import { StandaloneSqliteDatabase } from '../../src/database/standalone-sqlite.js';
import { ChainSource, JsonBlock, JsonTransaction } from '../../src/types.js';
import log from '../../src/log.js';
import { default as wait } from 'wait';

chai.use(chaiAsPromised);

class MockArweaveChainSource implements ChainSource {
  private height = 10000000;

  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const heightToId = JSON.parse(
      fs.readFileSync('test/mock_files/block_height_to_id.json', 'utf8')
    );

    const blockId = heightToId[height.toString()];
    if (fs.existsSync(`test/mock_files/blocks/${blockId}.json`)) {
      return JSON.parse(
        fs.readFileSync(`test/mock_files/blocks/${blockId}.json`, 'utf8')
      );
    }

    throw new Error(`Block ${height} not found`);
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    return JSON.parse(
      fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8')
    );
  }

  async getBlockAndTxsByHeight(height: number) {
    const block = await this.getBlockByHeight(height);
    const txs = await Promise.all(
      block.txs.map(
        async (txId: string): Promise<JsonTransaction> => this.getTx(txId)
      )
    );

    return { block, txs, missingTxIds: [] };
  }

  async getHeight(): Promise<number> {
    return this.height;
  }

  setHeight(height: number) {
    this.height = height;
  }
}

describe('BlockImporter', () => {
  let metricsRegistry: promClient.Registry;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainSource: ChainSource;
  let db: Sqlite.Database;
  let chainDb: StandaloneSqliteDatabase;

  beforeEach(async () => {
    log.transports.forEach((t) => (t.silent = true));
    metricsRegistry = promClient.register;
    metricsRegistry.clear();
    promClient.collectDefaultMetrics({ register: metricsRegistry });
    eventEmitter = new EventEmitter();
    chainSource = new MockArweaveChainSource();
    db = new Sqlite(':memory:');
    const schema = fs.readFileSync('schema.sql', 'utf8');
    db.exec(schema);
    chainDb = new StandaloneSqliteDatabase(db);
  });

  describe('importBlock', () => {
    describe('importing a single block', () => {
      beforeEach(async () => {
        blockImporter = new BlockImporter({
          log: log,
          metricsRegistry,
          chainSource,
          chainDb,
          eventEmitter,
          startHeight: 982575
        });
        await blockImporter.importBlock(982575);
      });

      it('should increase the max height', async () => {
        const maxHeight = await chainDb.getMaxHeight();
        expect(maxHeight).to.equal(982575);
      });

      it('should add the block to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(1);
      });

      it('should add the associated transactions to the DB', async () => {
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newTxs).to.equal(3);
      });
    });

    describe('attempting to import a block with a gap before it', () => {
      beforeEach(async () => {
        blockImporter = new BlockImporter({
          log: log,
          metricsRegistry,
          chainSource,
          chainDb,
          eventEmitter,
          startHeight: 1
        });
        await blockImporter.importBlock(1);
      });

      it('should import the block at the beginning of the gap', async () => {
        await blockImporter.importBlock(6);
        const stats = await chainDb.getDebugInfo();
        expect(stats.counts.newBlocks).to.equal(2);
        const maxHeight = await chainDb.getMaxHeight();
        expect(maxHeight).to.equal(2);
      });
    });

    describe('importing with a gap that exceeds the max fork depth', () => {
      beforeEach(async () => {
        blockImporter = new BlockImporter({
          log: log,
          metricsRegistry,
          chainSource,
          chainDb,
          eventEmitter,
          startHeight: 0
        });
      });

      it('should throw an exception', async () => {
        // TODO add blocks 52 and 53 and use those instead
        expect(blockImporter.importBlock(51)).to.be.rejectedWith(
          'Maximum fork depth exceeded'
        );
      });
    });
  });

  describe('getNextHeight', () => {
    describe('when no blocks have been imported', () => {
      beforeEach(async () => {
        blockImporter = new BlockImporter({
          log: log,
          metricsRegistry,
          chainSource,
          chainDb,
          eventEmitter,
          startHeight: 0
        });
      });

      it('should return the start height', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        expect(nextHeight).to.equal(0);
      });
    });

    describe('when a blocks have been imported the chain is not fully synced', () => {
      beforeEach(async () => {
        blockImporter = new BlockImporter({
          log: log,
          metricsRegistry,
          chainSource,
          chainDb,
          eventEmitter,
          startHeight: 1
        });
        await blockImporter.importBlock(1);
      });

      it('should return one more than the max height in the DB', async () => {
        const nextHeight = await blockImporter.getNextHeight();
        expect(nextHeight).to.equal(2);
      });
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      blockImporter = new BlockImporter({
        log: log,
        metricsRegistry,
        chainSource,
        chainDb,
        eventEmitter,
        startHeight: 1
      });
    });

    it('should not throw an exception when called', async () => {
      blockImporter.start();
      await wait(5);
      blockImporter.stop();
    });
  });

  describe('stop', () => {
    beforeEach(async () => {
      blockImporter = new BlockImporter({
        log: log,
        metricsRegistry,
        chainSource,
        chainDb,
        eventEmitter,
        startHeight: 0
      });
    });

    it('should not throw an exception when called', async () => {
      await blockImporter.stop();
    });
  });
});
