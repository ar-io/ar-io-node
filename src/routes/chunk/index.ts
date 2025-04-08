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
import { Router, json } from 'express';

import {
  createChunkOffsetHandler,
  createChunkPostHandler,
} from './handlers.js';
import log from '../../log.js';
import {
  arweaveClient,
  chunkDataSource,
  chunkMetaDataSource,
  db,
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
    chunkDataSource,
    chunkMetaDataSource,
    db,
    log: log.child({ class: 'ChunkGetOffsetHandler' }),
  }),
);

chunkRouter.post(
  '/chunk',
  createChunkPostHandler({
    arweaveClient,
    log: log.child({ class: 'ChunkPostHandler' }),
  }),
);
