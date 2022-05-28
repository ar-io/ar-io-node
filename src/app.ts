import EventEmitter = require('events');
import { BlockImporter } from './workers/block-importer';
import { ChainApiClient } from './arweave';
import { ChainDatabase } from './database/sqlite';

const eventEmitter = new EventEmitter();
const chainApiClient = new ChainApiClient('https://arweave.net/');
const chainDatabase = new ChainDatabase('chain.db');
const blockImporter = new BlockImporter({
  chainApiClient,
  chainDatabase,
  eventEmitter
});

blockImporter.run();
