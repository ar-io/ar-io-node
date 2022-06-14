import { expect } from 'chai';

import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import fs from 'fs';
import { EventEmitter } from 'events';

import log from '../../src/log.js';
import { BlockImporter } from '../../src/workers/block-importer.js';
import { ChainApiClient } from '../../src/arweave.js';
import { ChainDatabase } from '../../src/database/sqlite.js';

describe('BlockImporter class', () => {
  let metricsRegistry: promClient.Registry;
  let eventEmitter: EventEmitter;
  let blockImporter: BlockImporter;
  let chainApiClient: ChainApiClient;
  let db: Sqlite.Database;
  let chainDb: ChainDatabase;

  beforeEach(async () => {
    metricsRegistry = new promClient.Registry();
    promClient.collectDefaultMetrics({ register: metricsRegistry });
    eventEmitter = new EventEmitter();
    chainApiClient = new ChainApiClient('https://arweave.net/');
    db = new Sqlite(':memory:');
    const schema = fs.readFileSync('schema.sql', 'utf8');
    db.exec(schema);
    chainDb = new ChainDatabase(db);
    blockImporter = new BlockImporter({
      log,
      metricsRegistry,
      chainSource: chainApiClient,
      chainDb,
      eventEmitter
    });
  });

  //describe('importBlock method', () => {
  //  it('should import the genesis block', async () => {
  //    await blockImporter.importBlock(0);
  //    const maxHeight = await chainDb.getMaxHeight();
  //    expect(maxHeight).to.equal(0);
  //  });
  //});
});
