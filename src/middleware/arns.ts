/**
 * AR.IO Gateway
 * Copyright (C) 2022 - 2023 Permanent Data Solutions, Inc
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
import { Handler } from 'express';
import { asyncMiddleware } from 'middleware-async';

import { DataHandler, sendNotFound } from '../routes/data.js';
import { NameResolver } from '../types.js';

// TODO consider moving this under arns/
const EXCLUDED_SUBDOMAINS = ['www'];

export const arnsMiddleware = ({
  dataHandler,
  nameResolver,
}: {
  dataHandler: DataHandler;
  nameResolver: NameResolver;
}): Handler =>
  asyncMiddleware(async (req, res, next) => {
    if (
      req.subdomains !== undefined &&
      req.subdomains.length === 1 &&
      !EXCLUDED_SUBDOMAINS.includes(req.subdomains[0]) &&
      req.subdomains[0].length < 43 // TODO why 43? (copied this from arweave.net)
    ) {
      const { resolvedId, ttl } = await nameResolver.resolve(req.subdomains[0]);
      if (resolvedId !== undefined) {
        res.header('X-ArNS-Resolved-Id', resolvedId);
        res.header('X-ArNS-TTL', ttl.toString());
        res.header('Cache-Control', `public, max-age=${ttl}`);
        await dataHandler(req, res);
        return;
      } else {
        sendNotFound(res);
        return;
      }
    }
    next();
  });
