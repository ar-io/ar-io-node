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
import crypto from 'node:crypto';
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
import * as events from './events.js';
import { MatchTags, createFilter } from './filters.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import log from './log.js';
import { createArnsMiddleware } from './middleware/arns.js';
import { MemoryCacheArNSResolver } from './resolution/memory-cache-arns-resolver.js';
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
import { Ans104DataIndexer } from './workers/ans104-data-indexer.js';
import { Ans104Unbundler } from './workers/ans104-unbundler.js';
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
const arioWallet =
  process.env.AR_IO_WALLET !== undefined && process.env.AR_IO_WALLET !== ''
    ? process.env.AR_IO_WALLET
    : undefined;
const adminApiKey =
  process.env.ADMIN_API_KEY !== undefined && process.env.ADMIN_API_KEY !== ''
    ? process.env.ADMIN_API_KEY
    : crypto.randomBytes(32).toString('base64url');
if (
  process.env.ADMIN_API_KEY === undefined ||
  process.env.ADMIN_API_KEY === ''
) {
  log.info('Using a random admin key since none was set', { adminApiKey });
}
const ans104UnbundleFilter =
  process.env.ANS104_UNBUNDLE_FILTER !== undefined &&
  process.env.ANS104_UNBUNDLE_FILTER !== ''
    ? createFilter(JSON.parse(process.env.ANS104_UNBUNDLE_FILTER))
    : createFilter({ never: true });
const ans104DataIndexFilter =
  process.env.ANS104_DATA_INDEX_FILTER !== undefined &&
  process.env.ANS104_DATA_INDEX_FILTER !== ''
    ? createFilter(JSON.parse(process.env.ANS104_DATA_INDEX_FILTER))
    : createFilter({ never: true });

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
  blockStore: new FsBlockStore({
    log,
    baseDir: 'data/headers/partial-blocks',
    tmpDir: 'data/tmp/partial-blocks',
  }),
  txStore: new FsTransactionStore({
    log,
    baseDir: 'data/headers/partial-txs',
    tmpDir: 'data/tmp/partial-txs',
  }),
  failureSimulator: new UniformFailureSimulator({
    failureRate: simulatedRequestFailureRate,
  }),
});

const db = new StandaloneSqliteDatabase({
  log,
  coreDbPath: 'data/sqlite/core.db',
  dataDbPath: 'data/sqlite/data.db',
  moderationDbPath: 'data/sqlite/moderation.db',
});

// Workers
const eventEmitter = new EventEmitter();

const blockImporter = new BlockImporter({
  log,
  metricsRegistry: promClient.register,
  errorsCounter,
  chainSource: arweaveClient,
  chainIndex: db,
  eventEmitter,
  startHeight: startHeight,
  stopHeight: stopHeight,
});

eventEmitter.on(events.BLOCK_TX_INDEXED, (tx) => {
  eventEmitter.emit(events.TX_INDEXED, tx);
});

const ans104TxMatcher = new MatchTags([
  { name: 'Bundle-Format', value: 'binary' },
  { name: 'Bundle-Version', valueStartsWith: '2.' },
]);

eventEmitter.on(events.TX_INDEXED, async (tx) => {
  if (await ans104TxMatcher.match(tx)) {
    eventEmitter.emit(events.ANS104_TX_INDEXED, tx);
  }
});

const txFetcher = new TransactionFetcher({
  log,
  chainSource: arweaveClient,
  eventEmitter,
});

// Async fetch block TXs that failed sync fetch
eventEmitter.on(events.BLOCK_TX_FETCH_FAILED, ({ id: txId }) => {
  txFetcher.queueTxId(txId);
});

const txImporter = new TransactionImporter({
  log,
  chainIndex: db,
  eventEmitter,
});

// Queue fetched TXs to
eventEmitter.addListener('tx-fetched', (tx) => {
  txImporter.queueTx(tx);
});

const txRepairWorker = new TransactionRepairWorker({
  log,
  chainIndex: db,
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
  contiguousDataIndex: db,
});

const ans104Unbundler = new Ans104Unbundler({
  log,
  eventEmitter,
  filter: ans104UnbundleFilter,
  contiguousDataSource,
});

eventEmitter.on(events.ANS104_TX_INDEXED, async (tx) => {
  if (await ans104UnbundleFilter.match(tx)) {
    ans104Unbundler.queueTx(tx);
  }
});

const ans104DataIndexer = new Ans104DataIndexer({
  log,
  eventEmitter,
  indexWriter: db,
});

eventEmitter.on(events.DATA_ITEM_UNBUNDLED, async (dataItem) => {
  if (await ans104DataIndexFilter.match(dataItem)) {
    ans104DataIndexer.queueDataItem(dataItem);
  }
});

const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

const nameResolver = new MemoryCacheArNSResolver({
  log,
  resolver: new TrustedGatewayArNSResolver({
    log,
    trustedGatewayUrl: trustedArNSGatewayUrl,
  }),
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

app.use(
  promMid({
    metricsPath: '/ar-io/__gateway_metrics',
    extraMasks: [
      // Mask all paths except for the ones below
      /^(?!api-docs)(?!ar-io)(?!graphql)(?!openapi\.json)(?!raw).+$/,
      // Mask Arweave TX IDs
      /[a-zA-Z0-9_-]{43}/,
    ],
  }),
);

const dataHandler = createDataHandler({
  log,
  dataIndex: db,
  dataSource: contiguousDataSource,
  blockListValidator: db,
  manifestPathResolver,
});

app.use(
  createArnsMiddleware({
    dataHandler,
    nameResolver,
  }),
);

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
app.get('/ar-io/healthcheck', (_req, res) => {
  const data = {
    uptime: process.uptime(),
    message: 'Welcome to the Permaweb.',
    date: new Date(),
  };

  res.status(200).send(data);
});

// ar.io network info
app.get('/ar-io/info', (_req, res) => {
  res.status(200).send({
    wallet: arioWallet,
  });
});

// Only allow access to admin routes if the bearer token matches the admin api key
app.use('/ar-io/admin', (req, res, next) => {
  if (req.headers.authorization === `Bearer ${adminApiKey}`) {
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
});

// Debug info (for internal use)
app.get('/ar-io/admin/debug', async (_req, res) => {
  res.json({
    db: await db.getDebugInfo(),
  });
});

// Block access to contiguous data by ID or hash
app.put('/ar-io/admin/block-data', express.json(), async (req, res) => {
  // TODO improve validation
  try {
    const { id, hash, source, notes } = req.body;
    if (id === undefined && hash === undefined) {
      res.status(400).send("Must provide 'id' or 'hash'");
      return;
    }
    db.blockData({ id, hash, source, notes });
    // TODO check return value
    res.json({ message: 'Content blocked' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// GraphQL
const apolloServerInstanceGql = apolloServer(db, {
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
    dataIndex: db,
    dataSource: contiguousDataSource,
    blockListValidator: db,
  }),
);

app.get(DATA_PATH_REGEX, dataHandler);
