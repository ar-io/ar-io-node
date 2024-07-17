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
import { Router, default as express } from 'express';

import log from '../log.js';
import * as system from '../system.js';
import {
  CHUNK_POST_URLS,
  CHUNK_POST_ABORT_TIMEOUT_MS,
  CHUNK_POST_RESPONSE_TIMEOUT_MS,
} from '../config.js';
import { headerNames } from '../constants.js';
import { JsonChunkPost } from '../types.js';

const MIN_SUCCESS_COUNT = 3;

export const arweaveRouter = Router();

arweaveRouter.use(express.json());

const isJsonChunkPost = (obj: any): obj is JsonChunkPost => {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.data_root === 'string' &&
    typeof obj.chunk === 'string' &&
    typeof obj.data_size === 'string' &&
    typeof obj.data_path === 'string' &&
    typeof obj.offset === 'string'
  );
};

arweaveRouter.post('/chunk', async (req, res) => {
  if (!isJsonChunkPost(req.body)) {
    res.status(400).send('Invalid chunk format');
    return;
  }

  try {
    const headers = {
      [headerNames.hops]: req.headers[headerNames.hops.toLowerCase()] as
        | string
        | undefined,
      [headerNames.origin]: req.headers[headerNames.origin.toLowerCase()] as
        | string
        | undefined,
    };

    const result = await system.arweaveClient.broadcastChunk({
      chunk: req.body,
      abortTimeout: CHUNK_POST_ABORT_TIMEOUT_MS,
      responseTimeout: CHUNK_POST_RESPONSE_TIMEOUT_MS,
      originAndHopsHeaders: headers,
    });

    if (
      result.successCount >= Math.min(MIN_SUCCESS_COUNT, CHUNK_POST_URLS.length)
    ) {
      res.status(200).send(result);
    } else {
      res.status(500).send(result);
    }
  } catch (error: any) {
    log.error('Failed to broadcast chunk', {
      message: error?.message,
      stack: error?.stack,
    });
    res.status(500).send('Failed to broadcast chunk');
  }
});
