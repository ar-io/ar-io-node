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

const EXCLUDED_SUBDOMAINS = new Set('www');

export const createArnsMiddleware = ({
  dataHandler,
  nameResolver,
}: {
  dataHandler: DataHandler;
  nameResolver: NameResolver;
}): Handler =>
  asyncMiddleware(async (req, res, next) => {
    if (
      Array.isArray(req.subdomains) &&
      req.subdomains.length === 1 &&
      !EXCLUDED_SUBDOMAINS.has(req.subdomains[0]) &&
      req.subdomains[0].length <= 30 // Sanity check; contract already limits to 20
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
