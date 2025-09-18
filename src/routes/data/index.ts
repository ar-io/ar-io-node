/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router } from 'express';

import log from '../../log.js';
import * as system from '../../system.js';
import {
  DATA_PATH_REGEX,
  RAW_DATA_PATH_REGEX,
  FARCASTER_FRAME_DATA_PATH_REGEX,
} from '../../constants.js';
import { createDataHandler, createRawDataHandler } from './handlers.js';
import { x402DataEgressMiddleware } from '../../middleware/x402.js';

// Used by ArNS Router
export const dataHandler = createDataHandler({
  log,
  dataAttributesSource: system.dataAttributesSource,
  dataSource: system.onDemandContiguousDataSource,
  dataBlockListValidator: system.dataBlockListValidator,
  manifestPathResolver: system.manifestPathResolver,
});

export const dataRouter = Router();

// Apply x402 payment middleware to data routes
dataRouter.use(x402DataEgressMiddleware);

dataRouter.get(DATA_PATH_REGEX, dataHandler);
dataRouter.get(
  RAW_DATA_PATH_REGEX,
  createRawDataHandler({
    log,
    dataAttributesSource: system.dataAttributesSource,
    dataSource: system.onDemandContiguousDataSource,
    dataBlockListValidator: system.dataBlockListValidator,
  }),
);
dataRouter.get(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
dataRouter.post(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
