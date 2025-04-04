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
import { StandaloneSqliteDatabase } from '../../database/standalone-sqlite.js';

import { toB64Url } from '../../lib/encoding.js';
import { ChunkData, ChunkDataByAnySource } from '../../types.js';

export const createChunkOffsetHandler = ({
  chunkDataSource,
  db,
}: {
  chunkDataSource: ChunkDataByAnySource;
  db: StandaloneSqliteDatabase;
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
      console.error('Error fetching chunk data', error);
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
      response.status(500).send('Error converting chunk to base64url');
      return;
    }

    // this is a very limited interface of the node network chunk response
    response.status(200).json({ chunk: chunkBase64Url });
  });
};
