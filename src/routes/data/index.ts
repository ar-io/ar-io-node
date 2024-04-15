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

import log from '../../log.js';
import * as system from '../../system.js';
import { createDataHandler, createRawDataHandler } from './handlers.js';
import * as config from '../../config.js';

const DATA_PATH_REGEX =
  /^\/?([a-zA-Z0-9-_]{43})\/?$|^\/?([a-zA-Z0-9-_]{43})\/(.*)$/i;
const RAW_DATA_PATH_REGEX = /^\/raw\/([a-zA-Z0-9-_]{43})\/?$/i;
const FARCASTER_FRAME_DATA_PATH_REGEX =
  /^\/local\/farcaster\/frame\/([a-zA-Z0-9-_]{43})\/?$/i;

// Used by ArNS Router
export const dataHandler = createDataHandler({
  log,
  dataIndex: system.contiguousDataIndex,
  dataSource: system.contiguousDataSource,
  blockListValidator: system.blockListValidator,
  manifestPathResolver: system.manifestPathResolver,
  arnsRootHost: config.ARNS_ROOT_HOST,
});

export const dataRouter = Router();
dataRouter.get(DATA_PATH_REGEX, dataHandler);
dataRouter.get(
  RAW_DATA_PATH_REGEX,
  createRawDataHandler({
    log,
    dataIndex: system.contiguousDataIndex,
    dataSource: system.contiguousDataSource,
    blockListValidator: system.blockListValidator,
    arnsRootHost: config.ARNS_ROOT_HOST,
  }),
);
dataRouter.get(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
dataRouter.post(FARCASTER_FRAME_DATA_PATH_REGEX, dataHandler);
