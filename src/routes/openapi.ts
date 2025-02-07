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
//import * as OpenApiValidator from 'express-openapi-validator';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

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
