/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request } from 'express';
import { asyncMiddleware } from 'middleware-async';
import url from 'node:url';
import { base32 } from 'rfc4648';

import * as config from '../config.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import log from '../log.js';
import { sendNotFound } from '../routes/data/handlers.js';
import { DataBlockListValidator } from '../types.js';

// A sandbox label is the unpadded, lowercase base32 of a 32-byte ID.
const SANDBOX_LABEL_REGEX = /^[a-z2-7]{52}$/;

function getRequestSandbox(req: Request): string | undefined {
  const matched = config.matchArnsRootHost(req.hostname);
  if (
    matched !== undefined &&
    req.subdomains.length > matched.subdomainLength
  ) {
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

// Returns the ID a sandbox label encodes, or undefined if the label is not
// one this gateway would redirect to (wrong length, not base32, or
// non-canonical trailing bits). ArNS names are at most 51 characters and
// undernames contain '_', so neither can match.
export function idFromSandbox(sandbox: string): string | undefined {
  if (!SANDBOX_LABEL_REGEX.test(sandbox)) {
    return undefined;
  }
  try {
    const bytes = base32.parse(sandbox.toUpperCase(), { loose: true });
    if (bytes.length !== 32) {
      return undefined;
    }
    const id = toB64Url(Buffer.from(bytes));
    return sandboxFromId(id) === sandbox ? id : undefined;
  } catch {
    return undefined;
  }
}

export function createSandboxMiddleware({
  sandboxProtocol,
  dataBlockListValidator,
}: {
  sandboxProtocol?: string;
  dataBlockListValidator: DataBlockListValidator;
}): Handler {
  return asyncMiddleware(async (req, res, next) => {
    if (config.ARNS_ROOT_HOSTS.length === 0) {
      next();
      return;
    }

    const id = getRequestId(req);
    if (id === undefined) {
      // The bare sandbox root has no content of its own (data is served at
      // /<id> on the sandbox), but without this it falls through to the root
      // route and answers 200 with /ar-io/info. Abuse reports cite that bare
      // URL, so after a takedown it still looks live to the reporter. Answer
      // 451 when the encoded ID is blocked and 404 otherwise. Both use the
      // short not-found TTL: unblocking never revalidates this URL at the
      // edge, so a 30-day 451 would outlive the block.
      if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/') {
        const reqSandbox = getRequestSandbox(req);
        const sandboxId =
          reqSandbox !== undefined ? idFromSandbox(reqSandbox) : undefined;
        if (sandboxId !== undefined) {
          let blocked = false;
          try {
            blocked = await dataBlockListValidator.isIdBlocked(sandboxId);
          } catch (error: any) {
            log.warn('Unable to check block list for bare sandbox root', {
              id: sandboxId,
              message: error.message,
            });
          }
          if (blocked) {
            res.header(
              'Cache-Control',
              `public, max-age=${config.CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`,
            );
            res
              .status(451)
              .send(
                `Requested content blocked by this node's content policy. Blocked ID: ${sandboxId}`,
              );
            return;
          }
          sendNotFound(res);
          return;
        }
      }

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
        `${protocol}://${idSandbox}.${req.matchedArnsRootHost ?? config.ARNS_ROOT_HOST}${path}?${queryString}`,
      );
    }

    next();
  });
}
