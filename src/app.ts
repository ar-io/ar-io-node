/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
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
import { default as cors } from 'cors';
import express from 'express';
import { Server } from 'node:http';

import * as config from './config.js';
import { headerNames } from './constants.js';
import log from './log.js';
import { arIoRouter } from './routes/ar-io.js';
import { arnsRouter } from './routes/arns.js';
import { dataRouter } from './routes/data/index.js';
import { arweaveRouter } from './routes/arweave.js';
import { apolloServer } from './routes/graphql/index.js';
import { openApiRouter } from './routes/openapi.js';
import * as system from './system.js';

system.arweaveClient.refreshPeers();

system.headerFsCacheCleanupWorker?.start();

system.contiguousDataFsCacheCleanupWorker?.start();

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
      headerNames.arnsResolvedId,
      headerNames.arnsTtlSeconds,
      headerNames.arnsProcessId,
      headerNames.arnsResolvedAt,
    ],
  }),
);

app.use(arnsRouter);
app.use(openApiRouter);
app.use(arIoRouter);
app.use(dataRouter);
app.use(arweaveRouter);

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
