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

import * as config from './config.js';
import log from './log.js';
import { arIoRouter } from './routes/ar-io.js';
import { arnsRouter } from './routes/arns.js';
import { dataRouter } from './routes/data/index.js';
import { apolloServer } from './routes/graphql/index.js';
import { openApiRouter } from './routes/openapi.js';
import * as system from './system.js';

system.arweaveClient.refreshPeers();

system.headerFsCacheCleanupWorker?.start();

// Allow starting without writers to support SQLite replication
if (config.START_WRITERS) {
  system.blockImporter.start();
  system.txRepairWorker.start();
  system.bundleRepairWorker.start();
}

// HTTP server
const app = express();

app.use(
  cors({
    exposedHeaders: ['X-ArNS-Resolved-Id', 'X-ArNS-TTL-Seconds'],
  }),
);

app.use(arnsRouter);
app.use(openApiRouter);
app.use(arIoRouter);
app.use(dataRouter);

// GraphQL
const apolloServerInstanceGql = apolloServer(system.db, {
  introspection: true,
  persistedQueries: false,
});
apolloServerInstanceGql.start().then(() => {
  apolloServerInstanceGql.applyMiddleware({
    app,
    path: '/graphql',
  });
  app.listen(config.PORT, () => {
    log.info(`Listening on port ${config.PORT}`);
  });
});
