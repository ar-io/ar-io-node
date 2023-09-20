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
import { Handler, Request } from 'express';
import url from 'node:url';
import { base32 } from 'rfc4648';

import { fromB64Url } from '../lib/encoding.js';

function getRequestSandbox(req: Request, rootHost: string): string | undefined {
  const rootHostSubdomainLength = rootHost.split('.').length - 2;
  if (req.subdomains.length > rootHostSubdomainLength) {
    return req.subdomains[req.subdomains.length - 1];
  }
  return undefined;
}

function getRequestId(req: Request): string | undefined {
  return (req.path.match(/^\/([a-zA-Z0-9-_]{43})/) ?? [])[1];
}

function sandboxFromId(id: string): string {
  return base32.stringify(fromB64Url(id), { pad: false }).toLowerCase();
}

export function createSandboxMiddleware({
  rootHost,
  sandboxProtocol,
}: {
  rootHost?: string;
  sandboxProtocol?: string;
}): Handler {
  return (req, res, next) => {
    if (rootHost === undefined) {
      next();
      return;
    }

    const id = getRequestId(req);
    if (id === undefined) {
      next();
      return;
    }

    const reqSandbox = getRequestSandbox(req, rootHost);
    const idSandbox = sandboxFromId(id);
    if (reqSandbox !== idSandbox) {
      const queryString = url.parse(req.originalUrl).query ?? '';
      const path = req.path.replace(/\/\//, '/');
      const protocol = sandboxProtocol ?? (req.secure ? 'https' : 'http');
      return res.redirect(
        302,
        `${protocol}://${idSandbox}.${rootHost}${path}?${queryString}`,
      );
    }

    next();
  };
}
