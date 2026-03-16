/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request, Response } from 'express';

/**
 * Middleware that sets a default Cache-Control header when no handler has
 * explicitly set one. Works by intercepting writeHead so the check happens
 * at response-send time, after all handlers have run.
 */
export function createDefaultCacheControlMiddleware(maxAge: number): Handler {
  return (_req: Request, res: Response, next) => {
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = function (
      this: Response,
      ...args: Parameters<Response['writeHead']>
    ): Response {
      if (!this.hasHeader('Cache-Control')) {
        this.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      }
      return originalWriteHead(...args);
    };

    next();
  };
}
