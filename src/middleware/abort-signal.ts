/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Handler, Request, Response } from 'express';

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
    req.signal = controller.signal;

    next();
  };
}
