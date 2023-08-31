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
//import * as OpenApiValidator from 'express-openapi-validator';
import promMid from 'express-prometheus-middleware';
import fs from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import * as config from './config.js';
import log from './log.js';
import { createArnsMiddleware } from './middleware/arns.js';
import { createSandboxMiddleware } from './middleware/sandbox.js';
import {
  DATA_PATH_REGEX,
  RAW_DATA_PATH_REGEX,
  createDataHandler,
  createRawDataHandler,
} from './routes/data.js';
import { apolloServer } from './routes/graphql/index.js';
import * as system from './system.js';

system.arweaveClient.refreshPeers();

// Allow starting without writers to support SQLite replication
if (config.START_WRITERS) {
  system.blockImporter.start();
  system.txRepairWorker.start();
  system.bundleRepairWorker.start();
}

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
  dataIndex: system.contiguousDataIndex,
  dataSource: system.contiguousDataSource,
  blockListValidator: system.blockListValidator,
  manifestPathResolver: system.manifestPathResolver,
});

if (config.ARNS_ROOT_HOST !== undefined) {
  app.use(
    createArnsMiddleware({
      dataHandler,
      nameResolver: system.nameResolver,
    }),
  );

  app.use(
    createSandboxMiddleware({
      rootHost: config.ARNS_ROOT_HOST,
      sandboxProtocol: config.SANDBOX_PROTOCOL,
    }),
  );
}

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
    wallet: config.AR_IO_WALLET,
  });
});

// Only allow access to admin routes if the bearer token matches the admin api key
app.use('/ar-io/admin', (req, res, next) => {
  if (req.headers.authorization === `Bearer ${config.ADMIN_API_KEY}`) {
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
});

// Debug info (for internal use)
app.get('/ar-io/admin/debug', async (_req, res) => {
  res.json({
    db: await system.db.getDebugInfo(),
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
    system.db.blockData({ id, hash, source, notes });
    // TODO check return value
    res.json({ message: 'Content blocked' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// Queue a TX ID for processing
app.post('/ar-io/admin/queue-tx', express.json(), async (req, res) => {
  try {
    const { id } = req.body;
    if (id === undefined) {
      res.status(400).send("Must provide 'id'");
      return;
    }
    system.prioritizedTxIds.add(id);
    system.txFetcher.queueTxId(id);
    res.json({ message: 'TX queued' });
  } catch (error: any) {
    res.status(500).send(error?.message);
  }
});

// GraphQL
const apolloServerInstanceGql = apolloServer(system.db, {
  introspection: true,
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

// Data routes
app.get(
  RAW_DATA_PATH_REGEX,
  createRawDataHandler({
    log,
    dataIndex: system.contiguousDataIndex,
    dataSource: system.contiguousDataSource,
    blockListValidator: system.blockListValidator,
  }),
);

app.get(DATA_PATH_REGEX, dataHandler);
