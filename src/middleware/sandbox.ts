/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request } from 'express';
import url from 'node:url';
import { base32 } from 'rfc4648';

import * as config from '../config.js';
import { fromB64Url } from '../lib/encoding.js';

function getRequestSandbox(req: Request): string | undefined {
  if (req.subdomains.length > config.ROOT_HOST_SUBDOMAIN_LENGTH) {
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
  sandboxProtocol,
}: {
  sandboxProtocol?: string;
}): Handler {
  return (req, res, next) => {
    if (config.ARNS_ROOT_HOST === undefined) {
      next();
      return;
    }

    const id = getRequestId(req);
    if (id === undefined) {
      next();
      return;
    }

    const reqSandbox = getRequestSandbox(req);
    const idSandbox = sandboxFromId(id);
    if (reqSandbox !== idSandbox) {
      const queryString = url.parse(req.originalUrl).query ?? '';
      const path = req.path.replace(/\/\//, '/');
      const protocol = sandboxProtocol ?? 'https';
      return res.redirect(
        302,
        `${protocol}://${idSandbox}.${config.ARNS_ROOT_HOST}${path}?${queryString}`,
      );
    }

    next();
  };
}
