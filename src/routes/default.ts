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
import { APEX_TX_ID, APEX_ARNS_NAME, ARNS_ROOT_HOST } from '../config.js';
import { dataHandler } from './data/index.js';
import { arnsMiddleware } from './arns.js';
import { arIoInfoHandler } from './ar-io.js';

export const defaultRouter = Router();

// TODO: explain this
defaultRouter.get('*', async (req, res, next) => {
  if (
    APEX_TX_ID === undefined &&
    APEX_ARNS_NAME === undefined &&
    req.path === '/'
  ) {
    return arIoInfoHandler(req, res);
  }

  // Pass /graphql through since Apollo routes are always last
  if (req.path === '/graphql') {
    next();
    return;
  }

  if (APEX_TX_ID !== undefined) {
    const modifiedReq = Object.create(req);
    modifiedReq.params = {
      ...req.params,
      0: undefined,
      1: APEX_TX_ID,
      2: req.path.slice(1),
    };

    return dataHandler(modifiedReq, res, next);
  }

  if (APEX_ARNS_NAME !== undefined) {
    // Modify the request to add APEX_ARNS_NAME as a subdomain
    const modifiedReq = new Proxy(req, {
      get: (target, prop) => {
        if (prop === 'hostname') {
          return `${APEX_ARNS_NAME}.${ARNS_ROOT_HOST}`;
        }
        if (prop === 'subdomains') {
          // Extract existing subdomains from ARNS_ROOT_HOST if any
          const rootHostParts = (ARNS_ROOT_HOST ?? '').split('.');
          const existingSubdomains =
            rootHostParts.length > 2 ? rootHostParts.slice(0, -2) : [];

          // Add APEX_ARNS_NAME as the first subdomain
          return [...existingSubdomains, APEX_ARNS_NAME];
        }
        return target[prop as keyof typeof target];
      },
    });

    return arnsMiddleware(modifiedReq, res, next);
  }

  return res.status(404).send('Not Found');
});
