/* eslint-disable */
// @ts-nocheck
import { expect } from 'chai';

import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { EventEmitter } from 'events';

import { BlockImporter } from '../../src/workers/block-importer.js';
import { StandaloneSqliteDatabase } from '../../src/database/standalone-sqlite.js';
import { default as Arweave } from 'arweave';
import { ChainSource, JsonBlock } from '../../src/types.js';
import log from '../../src/log.js';

const arweave = Arweave.init({});

class MockArweaveChainSource implements ChainSource {
  async getBlockByHeight(height: number): Promise<JsonBlock> {
    const heightToId = JSON.parse(
      fs.readFileSync('test/mock_files/block_height_to_id.json', 'utf8')
    );
    const blockId = heightToId[height.toString()];
    return JSON.parse(
      fs.readFileSync(`test/mock_files/blocks/${blockId}.json`, 'utf8')
    );
  }

  async getTx(txId: string): Promise<JsonTransaction> {
    return JSON.parse(
      fs.readFileSync(`test/mock_files/txs/${txId}.json`, 'utf8')
    );
  }

  async getBlockAndTxsByHeight(height: number): Promise<JsonBlock> {
    const block = await this.getBlockByHeight(height);
    const txs = await Promise.all(
      block.txs.map(async (txId: string) => this.getTx(txId))
    );

    return { block, txs, missingTxIds: [] };
  }

  async getHeight(): Promise<number> {
    // TODO something more useful
    return 1000000;
  }
}

describe('BlockImporter', () => {
  let metricsRegistry: promClient.Registry;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainSource: ChainSource;
  let db: Sqlite.Database;
  let chainDb: ChainDatabase;

  beforeEach(async () => {
    log.transports.forEach((t) => t.silent = true);
    metricsRegistry = new promClient.Registry();
    promClient.collectDefaultMetrics({ register: metricsRegistry });
    eventEmitter = new EventEmitter();
    chainSource = new MockArweaveChainSource();
    db = new Sqlite(':memory:');
    const schema = fs.readFileSync('schema.sql', 'utf8');
    db.exec(schema);
    chainDb = new StandaloneSqliteDatabase(db);
    blockImporter = new BlockImporter({
      log: log,
      metricsRegistry,
      chainSource,
      chainDb,
      eventEmitter,
      startHeight: 982575
    });
  });

  describe('importBlock', () => {
    it('should import a block and its transactions', async () => {
      await blockImporter.importBlock(982575);
      const maxHeight = await chainDb.getMaxHeight();
      expect(maxHeight).to.equal(982575);
    });
  });
});
