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

export const arweaveRouter = Router();

arweaveRouter.use(express.json());

arweaveRouter.post('/chunk', async (req, res) => {
  try {
    await system.arweaveClient.broadcastChunk(req.body);
  } catch (error: any) {
    console.log(error.response);
    log.error('Failed to broadcast chunk', {
      message: error?.message,
      stack: error?.stack,
    });
    res.status(500).send('Failed to broadcast chunk');
    return;
  }

  res.status(200).send('Chunk broadcast successfully');
});
