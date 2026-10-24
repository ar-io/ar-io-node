/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request, Response } from 'express';

/**
 * Sets `req.signal`, shadowing Node's own.
 *
 * Node 24 defines `IncomingMessage.prototype.signal` as a getter with no
 * setter, so a plain `req.signal = ...` throws a TypeError in strict mode
 * (every ES module) and the request fails with a 500. An own property defined
 * on the request takes precedence over the prototype's getter. Node 22 has no
 * such getter, where this behaves like a plain assignment.
 *
 * We keep our own signal rather than Node's because ours aborts only when the
 * client leaves before the response has been written, which is what the 499
 * mapping in the error handler relies on.
 */
export function setRequestSignal(req: Request, signal: AbortSignal): void {
  Object.defineProperty(req, 'signal', {
    value: signal,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Middleware that attaches an AbortSignal to each request.
 * The signal is aborted when the client disconnects before the response completes.
 *
 * Usage in handlers:
 *   const signal = req.signal;
 *   await someAsyncOperation({ signal });
 *
 * This allows downstream operations to be cancelled when clients disconnect,
 * preventing wasted work on requests that will never be delivered.
 */
export function createAbortSignalMiddleware(): Handler {
  return (req: Request, res: Response, next) => {
    const controller = new AbortController();

    // Abort when client disconnects before response completes
    req.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    // Attach signal to request for use by handlers
    setRequestSignal(req, controller.signal);

    next();
  };
}
