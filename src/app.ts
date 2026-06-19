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
import log from './log.js';
import * as metrics from './metrics.js';
import { createAbortSignalMiddleware } from './middleware/abort-signal.js';
import { createRequestIdMiddleware } from './middleware/request-id.js';
import { createDefaultCacheControlMiddleware } from './middleware/cache-control.js';
import { createErrorHandlerMiddleware } from './middleware/error-handler.js';
import { createHttpSigMiddleware } from './middleware/httpsig.js';
import { rootRouter } from './routes/root.js';
import { arIoRouter } from './routes/ar-io.js';
import { arnsRouter } from './routes/arns.js';
import { chunkRouter } from './routes/chunk/index.js';
import { dataRouter } from './routes/data/index.js';
import { apolloServer } from './routes/graphql/index.js';
import { openApiRouter } from './routes/openapi.js';
import { datasetsRouter } from './routes/datasets.js';
import * as system from './system.js';
import { createX402Router } from './routes/x402.js';
import { createRateLimitRouter } from './routes/rate-limit.js';

// Initialize DNS resolution for preferred chunk GET nodes (non-fatal on failure)
try {
  await system.arweavePeerManager.initializeDnsResolution();
} catch (error: any) {
  log.warn('DNS resolution init failed; continuing with original URLs', {
    error: error?.message,
  });
}

// Start peer management services
system.arweavePeerManager.startAutoRefresh();
system.arweavePeerManager.startBucketRefresh();
system.arweavePeerManager.refreshPeers();

system.headerFsCacheCleanupWorker?.start();

system.contiguousDataFsCacheCleanupWorker?.start();

system.chunkDataFsCacheCleanupWorker?.start();

// ClickHouse streaming pipeline (issue #696). Started before writers so
// listeners are registered before any BLOCK_INDEXED / BLOCK_TX_INDEXED /
// ANS104_DATA_ITEM_INDEXED events fire, otherwise early unstable-head
// events would be missed during boot. Started here (rather than inside
// system.ts) so a schema-validation failure aborts startup with a clear
// error rather than silently failing in the background.
if (system.clickhouseStreamer !== undefined) {
  await system.clickhouseStreamer.start();
}

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
    // Wildcard exposes all response headers to browsers (valid for non-credentialed
    // requests, which is all we have with Access-Control-Allow-Origin: *).
    // This covers ar-io headers, x402, tracing, and dynamic X-Arweave-Tag-* names.
    // NOTE: If credentialed CORS is ever added, wildcard exposedHeaders is
    // silently ignored by browsers per the spec — switch back to an explicit list.
    exposedHeaders: '*',
  }),
);

// Assign a unique request ID to every request (independent of OTEL)
app.use(createRequestIdMiddleware());

// Attach AbortSignal to all requests for client disconnect handling
app.use(createAbortSignalMiddleware());

// HTTPSIG response signing — must be before cache-control so the writeHead
// LIFO order ensures signing runs AFTER cache-control has set default headers.
config.initializeHttpSig();
if (config.HTTPSIG_INIT_ERROR !== undefined) {
  metrics.httpSigInitFailedTotal.inc();
}
if (config.HTTPSIG_ENABLED && config.HTTPSIG_SIGNER !== undefined) {
  app.use(
    createHttpSigMiddleware({
      privateKey: config.HTTPSIG_SIGNER.privateKey,
      keyId: config.HTTPSIG_SIGNER.keyId,
      bindRequest: config.HTTPSIG_BIND_REQUEST,
    }),
  );
}

// Set default Cache-Control when no handler sets one
app.use(createDefaultCacheControlMiddleware(config.CACHE_DEFAULT_MAX_AGE));

app.use(
  createX402Router({
    log,
    rateLimiter: system.rateLimiter,
    paymentProcessor: system.paymentProcessor,
  }),
);
if (system.rateLimiter !== undefined) {
  app.use(
    createRateLimitRouter({
      log,
      rateLimiter: system.rateLimiter,
      paymentProcessor: system.paymentProcessor,
    }),
  );
}
app.use(arnsRouter);
app.use(openApiRouter);
app.use(arIoRouter);
app.use(datasetsRouter);
app.use(chunkRouter);
app.use(rootRouter);
app.use(dataRouter);

// GraphQL
const apolloServerInstanceGql = apolloServer(
  system.gqlQueryable,
  {
    introspection: true,
    persistedQueries: false,
  },
  system.dataItemMetaResolver,
);

let server: Server;
apolloServerInstanceGql.start().then(() => {
  apolloServerInstanceGql.applyMiddleware({
    app,
    path: '/graphql',
  });

  // Terminal error handler — must be registered after every router and the
  // GraphQL middleware so it catches anything they let escape. Replaces
  // Express's default finalhandler (silent, generic 500s).
  app.use(createErrorHandlerMiddleware({ log }));

  server = app.listen(config.PORT, () => {
    log.info(`Listening on port ${config.PORT}`);

    // Keep core's keepalive idle window wider than Envoy's upstream
    // idle_timeout so Envoy always recycles a pooled connection before core
    // closes it — otherwise Envoy races a request onto a connection core is
    // tearing down and the client sees an instant reset/5xx. headersTimeout
    // must stay strictly greater than keepAliveTimeout (Node requirement).
    server.keepAliveTimeout = config.HTTP_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = config.HTTP_HEADERS_TIMEOUT_MS;

    // Register server cleanup handler with system shutdown registry
    system.registerCleanupHandler('http-server', async () => {
      return new Promise<void>((resolve) => {
        log.debug('Closing HTTP server...');
        server.close(() => {
          log.debug('HTTP server closed');
          resolve();
        });
      });
    });
  });
});

export { server };
