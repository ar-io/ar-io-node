/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { NextFunction, Request, Response } from 'express';

import * as metrics from '../../metrics.js';

/**
 * Record how many GraphQL operations each inbound HTTP request carries.
 *
 * Mounted between the body parser and Apollo, because that is the only point
 * where a batch is still visible as one thing. Apollo's `requestDidStart` fires
 * per operation, so by the time a plugin sees it a batch of 50 is
 * indistinguishable from 50 separate requests. `express.json()` has already
 * parsed the body here, so an array is literally the batch.
 *
 * Apollo Server 5 offers no cap on batch size — `allowBatchedHttpRequests` is a
 * plain boolean and `httpBatching.js` runs the whole array through
 * `Promise.all` — while the rate limiter counts HTTP requests rather than
 * operations. The gap between this histogram's `_sum` and `_count` is therefore
 * the amplification factor currently available to a caller.
 *
 * This exists to answer one question with data instead of guesswork: does any
 * client batch at all? If the histogram stays flat at 1 over a representative
 * period, batching can be turned off outright rather than bounded at some
 * invented number. A null result only speaks for the traffic of the gateway
 * that produced it.
 *
 * Lives in its own module rather than inline in the Apollo barrel so it can be
 * tested without booting the gateway — `graphql/index.ts` pulls in
 * `resolvers.ts`, which imports `system.ts`.
 */
export const recordGraphqlBatchSize = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // A non-array body is a single operation. A malformed body that never
  // parsed leaves `req.body` undefined, which is still one HTTP request and
  // is counted as such — Apollo will reject it on its own terms.
  metrics.graphqlHttpBatchSize.observe(
    Array.isArray(req.body) ? req.body.length : 1,
  );
  next();
};
