/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
import { Chunk, ChunkByAnySource } from '../../types.js';
import { ArweaveCompositeClient } from '../../arweave/composite-client.js';
import { Logger } from 'winston';

export const createChunkOffsetHandler = ({
  chunkSource,
  db,
  log,
}: {
  chunkSource: ChunkByAnySource;
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

    // composite-chunk-source returns chunk metadata and chunk data
    let chunk: Chunk | undefined = undefined;

    // actually fetch the chunk data
    try {
      chunk = await chunkSource.getChunkByAny({
        txSize: data_size,
        absoluteOffset: offset,
        dataRoot: data_root,
        relativeOffset,
      });
    } catch (error) {
      response.sendStatus(404);
      return;
    }

    if (chunk === undefined) {
      response.sendStatus(404);
      return;
    }

    let chunkBase64Url: string | undefined = undefined;
    let dataPath: string | undefined = undefined;

    try {
      chunkBase64Url = toB64Url(chunk.chunk);
    } catch (error) {
      log.error('Error converting chunk to base64url', { error });
      response.status(500).send('Error converting chunk to base64url');
      return;
    }

    try {
      dataPath = toB64Url(chunk.data_path);
    } catch (error) {
      log.error('Error getting data path from chunk', { error });
      response.status(500).send('Error converting data path to base64url');
      return;
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
