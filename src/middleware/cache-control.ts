/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request, Response } from 'express';

const SKIP_CACHE_CONTROL_PREFIXES = [
  '/ar-io/admin',
  '/ar-io/rate-limit',
  '/ar-io/x402',
];

function shouldApplyDefaultCacheControl(req: Request, res: Response): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  if (
    SKIP_CACHE_CONTROL_PREFIXES.some((prefix) => req.path.startsWith(prefix))
  ) {
    return false;
  }

  // Limit the fallback to successful responses that are typically safe to cache.
  return (
    res.statusCode === 200 || res.statusCode === 203 || res.statusCode === 206
  );
}

/**
 * Middleware that sets a default Cache-Control header when no handler has
 * explicitly set one. Works by intercepting writeHead so the check happens
 * at response-send time, after all handlers have run.
 */
export function createDefaultCacheControlMiddleware(maxAge: number): Handler {
  const defaultValue = `public, max-age=${maxAge}`;

  return (req: Request, res: Response, next) => {
    const originalWriteHead = res.writeHead;

    // writeHead has multiple overload signatures; cast to a general callable
    // so we can wrap it without fighting the overload types.

    res.writeHead = function (this: Response, ...args: any[]) {
      if (
        !this.hasHeader('Cache-Control') &&
        shouldApplyDefaultCacheControl(req, this)
      ) {
        this.setHeader('Cache-Control', defaultValue);
      }
      return (
        originalWriteHead as unknown as (...a: unknown[]) => Response
      ).apply(this, args);
    } as typeof res.writeHead;

    next();
  };
}
