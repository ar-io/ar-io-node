/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { Logger } from 'winston';
import * as metrics from '../metrics.js';

/**
 * Terminal Express error handler. Catches errors that escape route handlers and
 * earlier middleware — e.g. a backend client (payment, rate limiter, cache)
 * that throws instead of failing open.
 *
 * Without a registered error handler, Express's default finalhandler turns
 * every such error into a generic, *unlogged* 500. That is exactly how a
 * backend hiccup can silently inflate the gateway's 5xx rate with no
 * diagnostic trail. This handler makes that path visible (log + metric) and
 * distinguishes a client disconnect (499) from a genuine server fault (500).
 *
 * It must be registered last, after all routers and the GraphQL middleware.
 */
export function createErrorHandlerMiddleware({
  log,
}: {
  log: Logger;
}): ErrorRequestHandler {
  const handlerLog = log.child({ class: 'ErrorHandlerMiddleware' });

  return (
    error: any,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    // Response already underway — we can't change the status. Defer to
    // Express's built-in handler, which will terminate the connection.
    if (res.headersSent) {
      next(error);
      return;
    }

    // A client that hung up is not a server fault. The abort-signal middleware
    // marks req.signal; some aborted operations also surface as AbortError.
    const clientAborted =
      req.signal?.aborted === true || error?.name === 'AbortError';

    if (clientAborted) {
      metrics.unhandledRequestErrorsCounter.inc({
        method: req.method,
        status: '499',
      });
      res.status(499).end();
      return;
    }

    // Genuinely unexpected: respond 500, but — unlike the default
    // finalhandler — record what happened so the throwing path is findable.
    metrics.unhandledRequestErrorsCounter.inc({
      method: req.method,
      status: '500',
    });
    handlerLog.error('Unhandled request error', {
      method: req.method,
      path: req.originalUrl,
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });
    res.status(500).send('Internal server error');
  };
}
