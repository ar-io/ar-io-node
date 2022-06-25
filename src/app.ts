import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import { EventEmitter } from 'events';
import express from 'express';
import promMid from 'express-prometheus-middleware';

import log from './log.js';
import { BlockImporter } from './workers/block-importer.js';
import { ChainApiClient } from './arweave.js';
import { ChainDatabase } from './database/sqlite.js';

// Configuration
const startHeight = parseInt(process.env.START_HEIGHT ?? '0');
const arweaveUrl = process.env.ARWEAVE_URL ?? 'https://arweave.net';
const port = parseInt(process.env.PORT ?? '3000');

// Workers
const eventEmitter = new EventEmitter();
const chainApiClient = new ChainApiClient({
  chainApiUrl: arweaveUrl
});
const db = new Sqlite('chain.db');
const chainDb = new ChainDatabase(db);
const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  chainSource: chainApiClient,
  chainDb,
  eventEmitter,
  startHeight: startHeight
});

blockImporter.start();

// HTTP server
const app = express();
app.use(promMid({ metricsPath: '/gateway_metrics' }));
app.get('/debug', async (_req, res) => {
  res.json({
    db: await chainDb.getDebugInfo()
  });
});
app.listen(port, () => {
  log.info(`Listening on port ${port}`);
});
