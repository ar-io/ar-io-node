import * as promClient from 'prom-client';
import EventEmitter = require('events');

import log from './log';
import { BlockImporter } from './workers/block-importer';
import { ChainApiClient } from './arweave';
import { ChainDatabase } from './database/sqlite';

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry });

const eventEmitter = new EventEmitter();
const chainApiClient = new ChainApiClient('http://192.168.1.21:1984/');
const chainDatabase = new ChainDatabase('chain.db');
const blockImporter = new BlockImporter({
  log,
  metricsRegistry,
  chainSource: chainApiClient,
  chainDatabase,
  eventEmitter
});

blockImporter.start();
