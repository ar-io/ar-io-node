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
import { Router } from 'express';

import * as config from '../config.js';
import { createArnsMiddleware } from '../middleware/arns.js';
import { createSandboxMiddleware } from '../middleware/sandbox.js';
import * as system from '../system.js';
import { dataHandler } from './data/index.js';
import { headerNames } from '../constants.js';
import { sendNotFound } from './data/handlers.js';
import { DEFAULT_ARNS_TTL_SECONDS } from '../resolution/trusted-gateway-arns-resolver.js';

export const arnsRouter = Router();

export const arnsMiddleware = createArnsMiddleware({
  dataHandler,
  nameResolver: system.nameResolver,
});

if (config.ARNS_ROOT_HOST !== undefined) {
  arnsRouter.use(arnsMiddleware);

  arnsRouter.use(
    createSandboxMiddleware({
      sandboxProtocol: config.SANDBOX_PROTOCOL,
    }),
  );
}

// TODO: consider moving this into ar-io router
arnsRouter.get('/ar-io/resolver/:name', async (req, res) => {
  const { name } = req.params;
  // NOTE: Errors and request deduplication are expected to be handled by the
  // resolver
  const resolved = await system.nameResolver.resolve({ name });
  if (resolved === undefined) {
    sendNotFound(res);
    return;
  }

  const { resolvedId, ttl, processId, resolvedAt, index, limit } = resolved;

  if (resolvedId === undefined) {
    sendNotFound(res);
    return;
  }

  res.header(headerNames.arnsResolvedId, resolvedId);
  res.header(
    headerNames.arnsTtlSeconds,
    ttl.toString() || DEFAULT_ARNS_TTL_SECONDS.toString(),
  );
  res.header(headerNames.arnsProcessId, processId);
  res.header(headerNames.arnsResolvedAt, resolvedAt.toString());
  if (index !== undefined && limit !== undefined) {
    res.header(headerNames.arnsIndex, index.toString());
    res.header(headerNames.arnsLimit, limit.toString());
  }
  res.json({
    txId: resolvedId,
    ttlSeconds: ttl,
    processId,
    resolvedAt,
    index,
    limit,
  });
});
