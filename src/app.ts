import * as promClient from 'prom-client';
import Sqlite from 'better-sqlite3';
import { EventEmitter } from 'events';
import express from 'express';
import promMid from 'express-prometheus-middleware';

import log from './log.js';
import { BlockImporter } from './workers/block-importer.js';
import { ArweaveCompositeClient } from './arweave/composite-client.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import { apolloServer } from './routes/graphql/index.js';
import { default as Arweave } from 'arweave';

// Configuration
const startHeight = parseInt(process.env.START_HEIGHT ?? '0');
const arweaveUrl = process.env.ARWEAVE_URL ?? 'https://arweave.net';
const port = parseInt(process.env.PORT ?? '3000');

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  // TODO track metrics
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

// Workers
const eventEmitter = new EventEmitter();
const arweaveClient = new ArweaveCompositeClient({
  log,
  arweave,
  trustedNodeUrl: arweaveUrl
});
const db = new Sqlite('data/sqlite/standalone.db');
const chainDb = new StandaloneSqliteDatabase(db);
const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  chainSource: arweaveClient,
  chainDb,
  eventEmitter,
  startHeight: startHeight
});

arweaveClient.refreshPeers();
blockImporter.start();

// HTTP server
const app = express();
app.use(promMid({ metricsPath: '/gateway_metrics' }));
// TODO move under '/admin'
app.get('/debug', async (_req, res) => {
  res.json({
    db: await chainDb.getDebugInfo()
  });
});
const apolloServerInstanceGql = apolloServer(chainDb, {
  introspection: true
});
apolloServerInstanceGql.start().then(() => {
  apolloServerInstanceGql.applyMiddleware({
    app,
    path: '/graphql'
  });
  app.listen(port, () => {
    log.info(`Listening on port ${port}`);
  });
});
