import EventEmitter = require('events');
import { BlockImporter } from './workers/block-importer';
import { ChainApiClient } from './arweave';
import { ChainDatabase } from './database/sqlite';
import log from './log';

const eventEmitter = new EventEmitter();
const chainApiClient = new ChainApiClient('https://arweave.net/');
const chainDatabase = new ChainDatabase('chain.db');
const blockImporter = new BlockImporter({
  log,
  chainApiClient,
  chainDatabase,
  eventEmitter
});

blockImporter.start();
