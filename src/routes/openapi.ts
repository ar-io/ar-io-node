/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
//import * as OpenApiValidator from 'express-openapi-validator';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { release } from '../version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const openApiRouter = Router();

// TODO get path relative to source file instead of cwd
//app.use(
//  OpenApiValidator.middleware({
//    apiSpec: './docs/openapi.yaml',
//    validateRequests: true, // (default)
//    validateResponses: true, // false by default
//  }),
//);

// OpenAPI Spec
const openapiDocument = YAML.parse(
  fs.readFileSync(__dirname + '/../../docs/openapi.yaml', 'utf8'),
);
// Gateways upgrade independently, so the spec a gateway serves reports that
// gateway's release rather than whatever the file last said.
openapiDocument.info.version = release;
openApiRouter.get('/openapi.json', (_req, res) => {
  res.json(openapiDocument);
});

// Swagger UI
const options = {
  explorer: true,
};
// FIXME: swagger-ui-express types are not up to date, fix when upgrading to v5
openApiRouter.use(
  '/api-docs',
  swaggerUi.serve as any,
  swaggerUi.setup(openapiDocument, options) as any,
);
