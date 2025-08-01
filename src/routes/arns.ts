/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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

  const { statusCode, resolvedId, ttl, processId, resolvedAt, index, limit } =
    resolved;

  if (resolvedId === undefined || statusCode === 404) {
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
