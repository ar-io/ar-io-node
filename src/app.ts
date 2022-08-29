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
import { default as Arweave } from 'arweave';
import Sqlite from 'better-sqlite3';
import { EventEmitter } from 'events';
import express from 'express';
import promMid from 'express-prometheus-middleware';
import fs from 'fs';
import * as promClient from 'prom-client';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import log from './log.js';
import { apolloServer } from './routes/graphql/index.js';
import { BlockImporter } from './workers/block-importer.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';

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
  trustedNodeUrl: arweaveUrl,
});
const db = new Sqlite('data/sqlite/core.db');
const chainDb = new StandaloneSqliteDatabase(db);
const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  chainSource: arweaveClient,
  chainDb,
  eventEmitter,
  startHeight: startHeight,
});
new TransactionFetcher({
  log,
  chainSource: arweaveClient,
  eventEmitter,
  fetchEvents: ['block-tx-fetch-failed'],
});
new TransactionImporter({
  log,
  chainDb,
  eventEmitter,
  importEvents: ['tx-fetched'],
});

arweaveClient.refreshPeers();
blockImporter.start();

// HTTP server
const app = express();
app.use(promMid({ metricsPath: '/gateway_metrics' }));

// OpenAPI Spec
const openapiDocument = YAML.parse(
  fs.readFileSync('docs/openapi.yaml', 'utf8'),
);
app.get('/openapi.json', (_req, res) => {
  res.json(openapiDocument);
});

// Swagger UI
const options = {
  explorer: true,
};
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openapiDocument, options),
);

// Healthcheck
app.get('/healthcheck', (_req, res) => {
  const data = {
    uptime: process.uptime(),
    message: 'Welcome to the Permaweb.',
    date: new Date(),
  };

  res.status(200).send(data);
});

// TODO move under '/admin'
app.get('/debug', async (_req, res) => {
  res.json({
    db: await chainDb.getDebugInfo(),
  });
});

// GraphQL
const apolloServerInstanceGql = apolloServer(chainDb, {
  introspection: true,
});
apolloServerInstanceGql.start().then(() => {
  apolloServerInstanceGql.applyMiddleware({
    app,
    path: '/graphql',
  });
  app.listen(port, () => {
    log.info(`Listening on port ${port}`);
  });
});
