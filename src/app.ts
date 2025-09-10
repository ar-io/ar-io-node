/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as cors } from 'cors';
import express from 'express';
import { Server } from 'node:http';

import * as config from './config.js';
import { headerNames } from './constants.js';
import log from './log.js';
import { rootRouter } from './routes/root.js';
import { arIoRouter } from './routes/ar-io.js';
import { arnsRouter } from './routes/arns.js';
import { chunkRouter } from './routes/chunk/index.js';
import { dataRouter } from './routes/data/index.js';
import { apolloServer } from './routes/graphql/index.js';
import { openApiRouter } from './routes/openapi.js';
import * as system from './system.js';
import { x402MiddlewareUsdc } from './middleware/x402.js';

// Initialize DNS resolution for preferred chunk GET nodes (non-fatal on failure)
try {
  await system.arweaveClient.initializeDnsResolution();
} catch (error: any) {
  log.warn('DNS resolution init failed; continuing with original URLs', {
    error: error?.message,
  });
}

system.arweaveClient.refreshPeers();

system.headerFsCacheCleanupWorker?.start();

system.contiguousDataFsCacheCleanupWorker?.start();

system.chunkDataFsCacheCleanupWorker?.start();

// Allow starting without writers to support SQLite replication
if (config.START_WRITERS) {
  system.blockImporter.start();
  system.txOffsetRepairWorker.start();
  system.txRepairWorker.start();
  system.bundleRepairWorker.start();
  system.mempoolWatcher?.start();
}

// HTTP server
const app = express();

app.use(
  cors({
    exposedHeaders: [
      // these are not exposed by default and must be added manually to be used on browsers
      'content-length',
      'content-encoding',
      ...Object.values(headerNames),
    ],
  }),
);

// X402
if (config.ENABLE_X_402_USDC) {
  app.use(x402MiddlewareUsdc);
}

app.use(arnsRouter);
app.use(openApiRouter);
app.use(arIoRouter);
app.use(chunkRouter);
app.use(dataRouter);
app.use(rootRouter);

// GraphQL
const apolloServerInstanceGql = apolloServer(system.gqlQueryable, {
  introspection: true,
  persistedQueries: false,
});

let server: Server;
apolloServerInstanceGql.start().then(() => {
  apolloServerInstanceGql.applyMiddleware({
    app,
    path: '/graphql',
  });
  server = app.listen(config.PORT, () => {
    log.info(`Listening on port ${config.PORT}`);
  });
});

export { server };
