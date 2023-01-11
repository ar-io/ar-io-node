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
import { EventEmitter } from 'events';
import express, { Response } from 'express';
import promMid from 'express-prometheus-middleware';
import fs from 'fs';
import * as promClient from 'prom-client';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { ArweaveCompositeClient } from './arweave/composite-client.js';
//import { ReadThroughChunkDataCache } from './cache/read-through-chunk-data-cache.js';
import { GatewayDataSource } from './data/gateway-data-source.js';
import { StreamingManifestPathResolver } from './data/streaming-manifest-path-resolver.js';
//import { TxChunksDataSource } from './data/tx-chunks-data-source.js';
import { StandaloneSqliteDatabase } from './database/standalone-sqlite.js';
import { UniformFailureSimulator } from './lib/chaos.js';
import { MANIFEST_CONTENT_TYPE } from './lib/encoding.js';
import log from './log.js';
import { apolloServer } from './routes/graphql/index.js';
import { FsBlockStore } from './store/fs-block-store.js';
//import { FsChunkDataStore } from './store/fs-chunk-data-store.js';
import { FsTransactionStore } from './store/fs-transaction-store.js';
import { ContiguousData } from './types.js';
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
//const chunkDataSource = new ReadThroughChunkDataCache({
//  log,
//  chunkSource: arweaveClient,
//  chunkDataStore: new FsChunkDataStore({ log, baseDir: 'data/chunks' }),
//});
//
//const contiguousDataSource = new TxChunksDataSource({
//  log,
//  chainSource: arweaveClient,
//  chunkSource: chunkDataSource,
//});

const contiguousDataSource = new GatewayDataSource({
  log,
  trustedGatewayUrl,
});

const manifestPathResolver = new StreamingManifestPathResolver({
  log,
});

arweaveClient.refreshPeers();
blockImporter.start();
txRepairWorker.start();

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

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const setDataHeaders = ({
  res,
  data,
  contentType,
}: {
  res: Response;
  data: ContiguousData;
  contentType: string;
}) => {
  // TODO add cache header(s)
  // TODO add etag

  res.contentType(contentType);
  res.header('Content-Length', data.size.toString());
};

// Data routes
const rawDataPathRegex = /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/i;
app.get(rawDataPathRegex, async (req, res) => {
  const id = req.params[0];
  let data: ContiguousData | undefined;
  try {
    // Retrieve authoritative data attributes if they're available
    const dataAttributes = await chainDb.getDataAttributes(id);
    let contentType: string | undefined;
    if (dataAttributes) {
      contentType = dataAttributes.contentType;
    }

    try {
      data = await contiguousDataSource.getData(id);
    } catch (error: any) {
      log.warn('Unable to retrieve contiguous data:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      res.status(404).send('Not found');
      return;
    }

    contentType = contentType ?? data.sourceContentType ?? DEFAULT_CONTENT_TYPE;
    setDataHeaders({ res, data, contentType });
    data.stream.pipe(res);
  } catch (error: any) {
    log.error('Error retrieving raw data:', {
      dataId: id,
      message: error.message,
      stack: error.stack,
    });
    data?.stream.destroy();
    res.status(404).send('Not found');
  }
});

const handleManifest = async ({
  res,
  resolvedId,
  complete,
}: {
  res: Response;
  resolvedId: string | undefined;
  complete: boolean;
}): Promise<boolean> => {
  let data: ContiguousData | undefined;
  try {
    if (resolvedId !== undefined) {
      // Retrieve authoritative data attributes if available
      const dataAttributes = await chainDb.getDataAttributes(resolvedId);
      let contentType: string | undefined;
      if (dataAttributes) {
        contentType = dataAttributes.contentType;
      }

      // Retrieve data based on ID resolved from manifest path or index
      try {
        data = await contiguousDataSource.getData(resolvedId);
      } catch (error: any) {
        log.warn('Unable to retrieve contiguous data:', {
          dataId: resolvedId,
          message: error.message,
          stack: error.stack,
        });
        // Indicate response was NOT sent
        return false;
      }

      // Set headers and stream response
      contentType =
        contentType ?? data.sourceContentType ?? DEFAULT_CONTENT_TYPE;
      setDataHeaders({ res, data, contentType });
      data.stream.pipe(res);

      // Indicate response was sent
      return true;
    }

    // Return 404 for not found index or path (arweave.net gateway behavior)
    if (complete) {
      res.status(404).send('Not found');

      // Indicate response was sent
      return true;
    }
  } catch (error: any) {
    log.error('Error retrieving manifest data:', {
      dataId: resolvedId,
      message: error.message,
      stack: error.stack,
    });
    data?.stream.destroy();
  }

  // Indicate response was NOT sent
  return false;
};

// TODO add CORS header
const dataPathRegex =
  /^\/?([a-zA-Z0-9-_]{43})\/?$|^\/?([a-zA-Z0-9-_]{43})\/(.*)$/i;
app.get(dataPathRegex, async (req, res) => {
  const id = req.params[0] ?? req.params[1];
  const manifestPath = req.params[2];
  let data: ContiguousData | undefined;
  try {
    let contentType: string | undefined;
    const dataAttributes = await chainDb.getDataAttributes(id);
    if (dataAttributes) {
      contentType = dataAttributes.contentType;
    }

    // Attempt manifest path resolution from the index (without data parsing)
    if (dataAttributes?.isManifest) {
      const manifestResolution = await manifestPathResolver.resolveFromIndex(
        id,
        manifestPath,
      );

      if (await handleManifest({ res, ...manifestResolution })) {
        return;
      }
    }

    try {
      data = await contiguousDataSource.getData(id);
    } catch (error: any) {
      log.warn('Unable to retrieve contiguous data:', {
        dataId: id,
        message: error.message,
        stack: error.stack,
      });
      res.status(404).send('Not found');
      return;
    }
    contentType = contentType ?? data.sourceContentType;

    // Fall back to on-demand manifest parsing
    if (contentType === MANIFEST_CONTENT_TYPE) {
      const manifestResolution = await manifestPathResolver.resolveFromData(
        data,
        id,
        manifestPath,
      );

      // The original stream is no longer needed after path resolution
      data.stream.destroy();

      if (!(await handleManifest({ res, ...manifestResolution }))) {
        // for readability (should be unreachable)
        res.status(404).send('Not found');
      }
      return;
    }

    contentType = contentType ?? DEFAULT_CONTENT_TYPE;
    setDataHeaders({ res, data, contentType });
    data.stream.pipe(res);
  } catch (error: any) {
    log.error('Error retrieving data:', {
      dataId: id,
      manifestPath,
      message: error.message,
      stack: error.stack,
    });
    res.status(404).send('Not found');
    data?.stream.destroy();
  }
});
