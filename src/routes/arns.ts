/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router } from 'express';

import * as config from '../config.js';
import log from '../log.js';
import { createArnsMiddleware } from '../middleware/arns.js';
import { createSandboxMiddleware } from '../middleware/sandbox.js';
import * as system from '../system.js';
import { dataHandler } from './data/index.js';
import { createIpfsHandler } from './ipfs.js';
import { headerNames } from '../constants.js';
import { sendNotFound } from './data/handlers.js';
import { DEFAULT_ARNS_TTL_SECONDS } from '../resolution/trusted-gateway-arns-resolver.js';

export const arnsRouter = Router();

// When IPFS serving is enabled, ArNS names whose ANT record resolves to an
// IPFS CID (targetProtocol = ipfs) are served through the same IPFS handler
// used by the path/subdomain routes.
const ipfsHandler =
  config.IPFS_ENABLED && system.ipfsService !== undefined
    ? createIpfsHandler({
        log,
        ipfsService: system.ipfsService,
        rateLimiter: system.ipfsRateLimiter,
        paymentProcessor: system.paymentProcessor,
      })
    : undefined;

export const arnsMiddleware = createArnsMiddleware({
  dataHandler,
  nameResolver: system.nameResolver,
  ipfsHandler,
});

if (config.ARNS_ROOT_HOSTS.length > 0) {
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

  const { statusCode, resolvedId, ttl, antId, resolvedAt, index, limit } =
    resolved;

  if (resolvedId === undefined || statusCode === 404) {
    sendNotFound(res);
    return;
  }

  // Storage protocol of the target (arweave TX id vs ipfs CID). Optional on the
  // resolution; absent => arweave for backward compatibility.
  const protocol =
    (resolved as { protocol?: 'arweave' | 'ipfs' }).protocol ?? 'arweave';

  res.header(headerNames.arnsResolvedId, resolvedId);
  res.header(headerNames.arnsProtocol, protocol);
  res.header(
    headerNames.arnsTtlSeconds,
    (ttl ?? DEFAULT_ARNS_TTL_SECONDS).toString(),
  );
  if (config.ARIO_ANT_PROGRAM_ID !== undefined) {
    res.header(headerNames.arnsAntProgramId, config.ARIO_ANT_PROGRAM_ID);
  }
  if (antId !== undefined) {
    res.header(headerNames.arnsAntId, antId);
  }
  if (resolvedAt !== undefined) {
    res.header(headerNames.arnsResolvedAt, resolvedAt.toString());
  }
  if (index !== undefined && limit !== undefined) {
    res.header(headerNames.arnsIndex, index.toString());
    res.header(headerNames.arnsLimit, limit.toString());
  }
  res.json({
    // `txId` kept for backward compatibility; for IPFS records it actually
    // holds a CID. Prefer `resolvedId` + `protocol`.
    txId: resolvedId,
    resolvedId,
    protocol,
    ttlSeconds: ttl,
    antId,
    resolvedAt,
    index,
    limit,
  });
});
