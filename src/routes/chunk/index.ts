/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router, json } from 'express';

import {
  createChunkOffsetHandler,
  createChunkPostHandler,
} from './handlers.js';
import log from '../../log.js';
import {
  arweaveClient,
  chunkSource,
  rateLimiter,
  paymentProcessor,
  txOffsetSource,
} from '../../system.js';

// To add a GET route for /chunk/:offset where :offset is restricted to a positive integer,
// we can use a regular expression in your route path to constrain :offset.
const CHUNK_OFFSET_PATH = '/chunk/:offset(\\d+)';

const MAX_CHUNK_SIZE = 1024 * 256 * 1.4; // 256KiB + 40% overhead for b64u encoding

export const chunkRouter = Router();

chunkRouter.use(json({ limit: MAX_CHUNK_SIZE }));

chunkRouter.get(
  CHUNK_OFFSET_PATH,
  createChunkOffsetHandler({
    chunkSource,
    txOffsetSource,
    rateLimiter,
    paymentProcessor,
    log: log.child({ class: 'ChunkGetOffsetHandler' }),
  }),
);

chunkRouter.head(
  CHUNK_OFFSET_PATH,
  createChunkOffsetHandler({
    chunkSource,
    txOffsetSource,
    rateLimiter,
    paymentProcessor,
    log: log.child({ class: 'ChunkHeadOffsetHandler' }),
  }),
);

chunkRouter.post(
  '/chunk',
  createChunkPostHandler({
    arweaveClient,
    log: log.child({ class: 'ChunkPostHandler' }),
  }),
);
