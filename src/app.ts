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
import { default as cors } from 'cors';
import express from 'express';
//import * as OpenApiValidator from 'express-openapi-validator';
import promMid from 'express-prometheus-middleware';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as promClient from 'prom-client';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
import { GatewayDataSource } from './data/gateway-data-source.js';
import { ReadThroughChunkDataCache } from './data/read-through-chunk-data-cache.js';
import { ReadThroughDataCache } from './data/read-through-data-cache.js';
import { SequentialDataSource } from './data/sequential-data-source.js';
import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import log from './log.js';
import { createArnsMiddleware } from './middleware/arns.js';
import { StreamingManifestPathResolver } from './resolution/streaming-manifest-path-resolver.js';
import { TrustedGatewayArNSResolver } from './resolution/trusted-gateway-arns-resolver.js';
import {
  DATA_PATH_REGEX,
  RAW_DATA_PATH_REGEX,
  createDataHandler,
  createRawDataHandler,
} from './routes/data.js';
import { apolloServer } from './routes/graphql/index.js';
import { FsBlockStore } from './store/fs-block-store.js';
import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsDataStore } from './store/fs-data-store.js';
import { FsTransactionStore } from './store/fs-transaction-store.js';
import { BlockImporter } from './workers/block-importer.js';
import { TransactionFetcher } from './workers/transaction-fetcher.js';
import { TransactionImporter } from './workers/transaction-importer.js';
import { TransactionRepairWorker } from './workers/transaction-repair-worker.js';

// Configuration
const startHeight = +(process.env.START_HEIGHT ?? 0);
const stopHeight = +(process.env.STOP_HEIGHT ?? Infinity);
const trustedNodeUrl = process.env.TRUSTED_NODE_URL ?? 'https://arweave.net';
const trustedGatewayUrl =
  process.env.TRUSTED_GATEWAY_URL ?? 'https://arweave.net';
const trustedArNSGatewayUrl =
  process.env.TRUSTED_ARNS_GATEWAY_URL ?? 'https://__NAME__.arweave.dev';
const skipCache = (process.env.SKIP_CACHE ?? 'false') === 'true';
const port = +(process.env.PORT ?? 4000);
const simulatedRequestFailureRate = +(
  process.env.SIMULATED_REQUEST_FAILURE_RATE ?? 0
);

// Global errors counter
const errorsCounter = new promClient.Counter({
  name: 'errors_total',
  help: 'Total error count',
});

// Uncaught exception handler
const uncaughtExceptionCounter = new promClient.Counter({
  name: 'uncaught_exceptions_total',
  help: 'Count of uncaught exceptions',
});
process.on('uncaughtException', (error) => {
  uncaughtExceptionCounter.inc();
  log.error('Uncaught exception:', error);
});

const arweave = Arweave.init({});

const arweaveClient = new ArweaveCompositeClient({
  log,
  metricsRegistry: promClient.register,
  arweave,
  trustedNodeUrl,
  skipCache,
  blockStore: new FsBlockStore({ log, baseDir: 'data/headers/partial-blocks' }),
  txStore: new FsTransactionStore({ log, baseDir: 'data/headers/partial-txs' }),
  failureSimulator: new UniformFailureSimulator({
    failureRate: simulatedRequestFailureRate,
  }),
});

const chainDb = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
});

// Workers
const eventEmitter = new EventEmitter();

const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  errorsCounter,
  chainSource: arweaveClient,
  chainDb,
  eventEmitter,
  startHeight: startHeight,
  stopHeight: stopHeight,
});

const txFetcher = new TransactionFetcher({
  log,
  chainSource: arweaveClient,
  eventEmitter,
});

// Async fetch block TXs that failed sync fetch
eventEmitter.addListener('block-tx-fetch-failed', ({ id: txId }) => {
  txFetcher.queueTxId(txId);
});

const txImporter = new TransactionImporter({
  log,
  chainDb,
  eventEmitter,
});

// Queue fetched TXs to
eventEmitter.addListener('tx-fetched', (tx) => {
  txImporter.queueTx(tx);
});

const txRepairWorker = new TransactionRepairWorker({
  log,
  chainDb,
  txFetcher,
});

// Configure contigous data source
const chunkDataSource = new ReadThroughChunkDataCache({
  log,
  chunkSource: arweaveClient,
  chunkDataStore: new FsChunkDataStore({ log, baseDir: 'data/chunks' }),
});

const txChunksDataSource = new TxChunksDataSource({
  log,
  chainSource: arweaveClient,
  chunkSource: chunkDataSource,
});

const gatewayDataSource = new GatewayDataSource({
  log,
  trustedGatewayUrl,
});

const contiguousDataSource = new ReadThroughDataCache({
  log,
  dataSource: new SequentialDataSource({
    log,
    dataSources: [gatewayDataSource, txChunksDataSource, arweaveClient],
  }),
  dataStore: new FsDataStore({ log, baseDir: 'data/contiguous' }),
  contiguousDataIndex: chainDb,
});

const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

const nameResolver = new TrustedGatewayArNSResolver({
  log,
  trustedGatewayUrl: trustedArNSGatewayUrl,
});

arweaveClient.refreshPeers();
blockImporter.start();
txRepairWorker.start();

// HTTP server
const app = express();

// TODO get path relative to source file instead of cwd
//app.use(
//  OpenApiValidator.middleware({
//    apiSpec: './docs/openapi.yaml',
//    validateRequests: true, // (default)
//    validateResponses: true, // false by default
//  }),
//);

app.use(cors());

const dataHandler = createDataHandler({
  log,
  dataIndex: chainDb,
  dataSource: contiguousDataSource,
  manifestPathResolver,
});

app.use(
  createArnsMiddleware({
    dataHandler,
    nameResolver,
  }),
);

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

// Data routes
app.get(
  RAW_DATA_PATH_REGEX,
  createRawDataHandler({
    log,
    dataIndex: chainDb,
    dataSource: contiguousDataSource,
  }),
);

app.get(DATA_PATH_REGEX, dataHandler);
