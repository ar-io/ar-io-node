/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomUUID } from 'node:crypto';
import { Handler, Request, Response } from 'express';
import { requestContextStorage } from '../request-context.js';

/**
 * Middleware that assigns a unique request ID to every incoming request.
 *
 * - Reads `X-Request-Id` from the incoming request headers; falls back to a
 *   randomly generated UUID.
 * - Sets `req.id` on the request object.
 * - Sets the `X-Request-Id` response header so clients can correlate responses.
 * - Runs downstream handlers inside an `AsyncLocalStorage` context so that all
 *   async code (including Winston log calls) can read the request ID without
 *   explicit propagation.
 */
const VALID_REQUEST_ID_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

function sanitizeRequestId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (
    trimmed.length >= 1 &&
    trimmed.length <= MAX_REQUEST_ID_LENGTH &&
    VALID_REQUEST_ID_RE.test(trimmed)
  ) {
    return trimmed;
  }
  return undefined;
}

export function createRequestIdMiddleware(): Handler {
  return (req: Request, res: Response, next) => {
    const requestId =
      sanitizeRequestId(req.get('X-Request-Id')) ?? randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    requestContextStorage.run({ requestId }, next);
  };
}
