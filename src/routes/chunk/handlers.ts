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

import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import * as metrics from '../../metrics.js';
import { StandaloneSqliteDatabase } from '../../database/standalone-sqlite.js';
import {
  CHUNK_POST_URLS,
  CHUNK_POST_ABORT_TIMEOUT_MS,
  CHUNK_POST_RESPONSE_TIMEOUT_MS,
  CHUNK_POST_MIN_SUCCESS_COUNT,
} from '../../config.js';
import { headerNames } from '../../constants.js';
import { toB64Url } from '../../lib/encoding.js';
import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkMetadata,
  ChunkMetadataByAnySource,
} from '../../types.js';
import { ArweaveCompositeClient } from '../../arweave/composite-client.js';
import { Logger } from 'winston';

// To add a GET route for /chunk/:offset where :offset is restricted to a positive integer,
// we can use a regular expression in your route path to constrain :offset.
export const CHUNK_OFFSET_PATH = '/chunk/:offset(\\d+)';

export const createChunkOffsetHandler = ({
  chunkDataSource,
  chunkMetaDataSource,
  db,
  log,
}: {
  chunkDataSource: ChunkDataByAnySource;
  chunkMetaDataSource: ChunkMetadataByAnySource;
  db: StandaloneSqliteDatabase;
  log: Logger;
}) => {
  return asyncHandler(async (request: Request, response: Response) => {
    const offset = Number.parseInt(request.params.offset);

    if (Number.isNaN(offset) || offset < 0) {
      response.status(400).send('Invalid offset');
      return;
    }

    const {
      data_root,
      id,
      data_size,
      offset: weaveOffset,
    } = await db.getTxByOffset(offset);

    // This is unnecessary amount of validation, but it is here to be make typescript happy
    if (
      data_root === undefined ||
      weaveOffset === undefined ||
      id === undefined ||
      data_size === undefined
    ) {
      response.sendStatus(404);
      return;
    }

    // Calculate the relative offset, needed for chunk data source
    const contiguousDataStartDelimiter = weaveOffset - data_size + 1;
    const relativeOffset = offset - contiguousDataStartDelimiter;

    let chunkData: ChunkData | undefined = undefined;

    // actually fetch the chunk data
    try {
      chunkData = await chunkDataSource.getChunkDataByAny(
        data_size,
        offset,
        data_root,
        relativeOffset,
      );
    } catch (error) {
      response.sendStatus(404);
      return;
    }

    if (chunkData === undefined) {
      response.sendStatus(404);
      return;
    }

    let chunkBase64Url: string | undefined = undefined;
    try {
      chunkBase64Url = toB64Url(chunkData.chunk);
    } catch (error) {
      log.error('Error converting chunk to base64url', { error });
      response.status(500).send('Error converting chunk to base64url');
      return;
    }

    let chunkMetadata: ChunkMetadata | undefined = undefined;
    let dataPath: string | undefined = undefined;

    try {
      chunkMetadata = await chunkMetaDataSource.getChunkMetadataByAny(
        data_size,
        offset,
        data_root,
        relativeOffset,
      );
    } catch (error) {
      log.error('Error fetching chunk metadata', { error });
    }

    if (chunkMetadata) {
      dataPath = toB64Url(chunkMetadata.data_path);
    }

    // this is a very limited interface of the node network chunk response
    response.status(200).json({
      chunk: chunkBase64Url,
      ...(dataPath !== undefined && {
        data_path: dataPath,
      }),
      // as of today, ar-io-node doesn't pack chunks
      packing: 'unpacked',
    });
  });
};

export const createChunkPostHandler = ({
  arweaveClient,
  log,
}: {
  arweaveClient: ArweaveCompositeClient;
  log: Logger;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    try {
      // Extract the required headers
      const headers = {
        [headerNames.hops]: req.headers[headerNames.hops.toLowerCase()] as
          | string
          | undefined,
        [headerNames.origin]: req.headers[headerNames.origin.toLowerCase()] as
          | string
          | undefined,
      };

      // Broadcast the chunk using your system's Arweave client
      const result = await arweaveClient.broadcastChunk({
        chunk: req.body,
        abortTimeout: CHUNK_POST_ABORT_TIMEOUT_MS,
        responseTimeout: CHUNK_POST_RESPONSE_TIMEOUT_MS,
        chunkPostMinSuccessCount: CHUNK_POST_MIN_SUCCESS_COUNT,
        originAndHopsHeaders: headers,
      });

      // Check if successCount meets the threshold
      if (
        result.successCount >=
        Math.min(CHUNK_POST_MIN_SUCCESS_COUNT, CHUNK_POST_URLS.length)
      ) {
        metrics.arweaveChunkBroadcastCounter.inc({ status: 'success' });
        res.status(200).send(result);
      } else {
        metrics.arweaveChunkBroadcastCounter.inc({ status: 'fail' });
        res.status(500).send(result);
      }
    } catch (error: any) {
      metrics.arweaveChunkBroadcastCounter.inc({ status: 'fail' });
      log.error('Failed to broadcast chunk', {
        message: error?.message,
        stack: error?.stack,
      });
      res.status(500).send('Failed to broadcast chunk');
    }
  });
};
