import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import { EventEmitter } from 'events';

import log from './log.js';
import { BlockImporter } from './workers/block-importer.js';
import { ChainApiClient } from './arweave.js';
import { ChainDatabase } from './database/sqlite.js';

const startHeight = parseInt(process.env.START_HEIGHT ?? '0');
const arweaveUrl = process.env.ARWEAVE_URL ?? 'https://arweave.net';

const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry });

const eventEmitter = new EventEmitter();
const chainApiClient = new ChainApiClient(arweaveUrl);
const db = new Sqlite('chain.db');
const chainDb = new ChainDatabase(db);
const blockImporter = new BlockImporter({
  log,
  metricsRegistry,
  chainSource: chainApiClient,
  chainDb,
  eventEmitter,
  startHeight: startHeight
});

blockImporter.start();
