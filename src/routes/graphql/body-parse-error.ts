/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { NextFunction, Request, Response } from 'express';

/**
 * Answer a `/graphql` body that `express.json()` rejected in GraphQL's own
 * error shape.
 *
 * Mounted directly after the body parser. Apollo never sees a body that fails
 * to parse, so without this the error falls through to the gateway's terminal
 * handler and a malformed JSON body gets a plain-text reply, while every other
 * malformed request Apollo rejects (an empty body, a `text/plain` body) gets
 * `{"errors":[{"extensions":{"code":"BAD_REQUEST"}}]}`. Clients parse one
 * shape, so give them one.
 *
 * Only exposable 4xx errors (the http-errors convention body-parser follows)
 * are handled here; anything else goes on to the terminal handler, which logs
 * it and answers 500.
 *
 * Lives in its own module so it can be tested without booting the gateway —
 * `graphql/index.ts` pulls in `resolvers.ts`, which imports `system.ts`.
 */
export const graphqlBodyParseError = (
  error: any,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const status = error?.status ?? error?.statusCode;
  if (
    res.headersSent ||
    error?.expose !== true ||
    !Number.isInteger(status) ||
    status < 400 ||
    status >= 500
  ) {
    next(error);
    return;
  }

  res.status(status).json({
    errors: [
      {
        message: error.message,
        extensions: { code: 'BAD_REQUEST' },
      },
    ],
  });
};
