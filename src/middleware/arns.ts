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
import { Handler } from 'express';
import { asyncMiddleware } from 'middleware-async';

import * as config from '../config.js';
import { sendNotFound } from '../routes/data/handlers.js';
import { NameResolver } from '../types.js';

const EXCLUDED_SUBDOMAINS = new Set('www');

export const createArnsMiddleware = ({
  dataHandler,
  nameResolver,
}: {
  dataHandler: Handler;
  nameResolver: NameResolver;
}): Handler =>
  asyncMiddleware(async (req, res, next) => {
    if (
      // Ignore subdomains that are part of the ArNS root hostname.
      !Array.isArray(req.subdomains) ||
      req.subdomains.length === config.ROOT_HOST_SUBDOMAIN_LENGTH
    ) {
      next();
      return;
    }
    const arnsSubdomain = req.subdomains[req.subdomains.length - 1];
    if (
      EXCLUDED_SUBDOMAINS.has(arnsSubdomain) ||
      // Avoid collisions with sandbox URLs by ensuring the subdomain length
      // is below the mininimum length of a sandbox subdomain. Undernames are
      // are an exception because they can be longer and '_' cannot appear in
      // base32.
      (arnsSubdomain.length > 48 && !arnsSubdomain.match(/_/))
    ) {
      next();
      return;
    }
    const { resolvedId, ttl } = await nameResolver.resolve(arnsSubdomain);
    if (resolvedId === undefined) {
      sendNotFound(res);
      return;
    }
    res.header('X-ArNS-Resolved-Id', resolvedId);
    res.header('X-ArNS-TTL-Seconds', ttl.toString());
    res.header('Cache-Control', `public, max-age=${ttl}`);
    dataHandler(req, res, next);
  });
