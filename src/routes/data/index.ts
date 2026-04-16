/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Router } from 'express';

import * as config from '../../config.js';
import log from '../../log.js';
import * as system from '../../system.js';
import {
  DATA_PATH_REGEX,
  RAW_DATA_PATH_REGEX,
  FARCASTER_FRAME_DATA_PATH_REGEX,
} from '../../constants.js';
import { createDataHandler, createRawDataHandler } from './handlers.js';

// Only pass the resolver when tag response headers are enabled. The handlers
// use the presence/absence of the resolver (not the config flag) to decide
// whether to resolve and set tag headers, making them environment-independent
// and easier to test.
const dataItemMetaResolver = config.ARWEAVE_TAG_RESPONSE_HEADERS_ENABLED
  ? system.dataItemMetaResolver
  : undefined;

// Used by ArNS Router
export const dataHandler = createDataHandler({
  log,
  dataAttributesSource: system.dataAttributesStore,
  dataSource: system.onDemandContiguousDataSource,
  dataBlockListValidator: system.dataBlockListValidator,
  manifestPathResolver: system.manifestPathResolver,
  rateLimiter: system.rateLimiter,
  paymentProcessor: system.paymentProcessor,
  negativeDataCache: system.negativeDataCache,
  dataItemMetaResolver,
});

export const dataRouter = Router();

dataRouter.get(DATA_PATH_REGEX, dataHandler);
dataRouter.get(
  RAW_DATA_PATH_REGEX,
  createRawDataHandler({
    log,
    dataAttributesSource: system.dataAttributesStore,
    dataSource: system.onDemandContiguousDataSource,
    dataBlockListValidator: system.dataBlockListValidator,
    rateLimiter: system.rateLimiter,
    paymentProcessor: system.paymentProcessor,
    negativeDataCache: system.negativeDataCache,
    dataItemMetaResolver,
  }),
);
dataRouter.get(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
dataRouter.post(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
