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

defaultRouter.get('/', async (req, res, next) => {
  if (APEX_TX_ID === undefined && APEX_ARNS_NAME === undefined) {
    return arIoInfoHandler(req, res);
  }

  if (APEX_TX_ID !== undefined) {
    const modifiedReq = Object.create(req);
    modifiedReq.params = { 0: APEX_TX_ID, ...req.params };

    return dataHandler(modifiedReq, res, next);
  }

  if (APEX_ARNS_NAME !== undefined) {
    // Use Proxy to modify hostname as it is read only
    const modifiedReq = new Proxy(req, {
      get: (target, prop) => {
        if (prop === 'hostname') {
          return `${APEX_ARNS_NAME}.${ARNS_ROOT_HOST}`;
        }
        if (prop === 'subdomains') {
          return [APEX_ARNS_NAME];
        }
        return target[prop as keyof typeof target];
      },
    });

    return arnsMiddleware(modifiedReq, res, next);
  }
});
