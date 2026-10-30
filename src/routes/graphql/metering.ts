/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { checkPaymentAndRateLimits } from '../../handlers/data-handler-utils.js';
import { extractAllClientIPs } from '../../lib/ip-utils.js';
import type { RateLimiter } from '../../limiter/types.js';
import type { PaymentProcessor } from '../../payments/types.js';

/**
 * How many GraphQL operations a request asks the gateway to run: one for a
 * query in the body or the query string, the array's length for a batch, and
 * none for anything Apollo answers without running a query (the Sandbox page,
 * a CORS preflight).
 *
 * A GET is judged the way Apollo judges it, not with Express's parse:
 * - Apollo serves the Sandbox page, not the query, to any GET whose Accept
 *   header prefers HTML (`prefersHTML` in `ApolloServer.js`), with or without
 *   `?query=`.
 * - Apollo reads the query string with `URLSearchParams`, which has no
 *   parameter limit. Express's `req.query` stops after 1,000 parameters, so
 *   padding the URL would hide `query` from a meter that used it while Apollo
 *   still ran it. Any `query` parameter is therefore charged.
 */
export function graphqlOperationCount(req: Request): number {
  if (req.method === 'POST') {
    return Array.isArray(req.body) ? Math.max(1, req.body.length) : 1;
  }
  if (req.method === 'GET') {
    if (prefersHtml(req)) return 0;
    const search = req.originalUrl.split('?').slice(1).join('?');
    return new URLSearchParams(search).has('query') ? 1 : 0;
  }
  return 0;
}

/**
 * Whether Apollo would answer this GET with its landing page: the Accept
 * header ranks HTML above every type a GraphQL response can take. No Accept
 * header means JSON, as in Apollo.
 */
function prefersHtml(req: Request): boolean {
  if (req.headers.accept === undefined || req.headers.accept === '') {
    return false;
  }
  return (
    req.accepts([
      'application/json',
      'application/graphql-response+json',
      'multipart/mixed',
      'text/html',
    ]) === 'text/html'
  );
}

/**
 * Meter `/graphql` with the rate limiter and x402, at a flat cost per
 * operation (ENABLE_GRAPHQL_METERING, GRAPHQL_OPERATION_COST_BYTES).
 *
 * The data routes meter bytes, but a GraphQL response is a few kilobytes
 * whatever the query costs the database, so bytes would price it at almost
 * nothing. A flat cost per operation is crude (a one-row lookup costs the same
 * as a 1,000-row page) but bounds what one client can ask for, and it is
 * charged before the query runs, so a refused request costs no database work.
 * The charge is not reconciled with the response size afterwards: it stands
 * for work, not bytes.
 *
 * Only the client's IP bucket is charged. The limiter's other bucket is keyed
 * by path, and every GraphQL request has the same path, so it would be one
 * allowance shared by all clients that any one of them could exhaust.
 *
 * Mounted after the body parser, so a batch is visible as an array and is
 * charged per operation: batching must not multiply the allowance.
 */
export function createGraphqlMeter({
  rateLimiter,
  paymentProcessor,
  operationCostBytes,
}: {
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  operationCostBytes: number;
}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const operations = graphqlOperationCount(req);
    if (operations === 0) {
      next();
      return;
    }
    try {
      const result = await checkPaymentAndRateLimits({
        req,
        res,
        contentSize: operations * operationCostBytes,
        contentType: 'application/json',
        requestAttributes: { hops: 0, ...extractAllClientIPs(req) },
        rateLimiter,
        paymentProcessor,
        browserPaymentFlow: 'direct',
        skipResourceBucket: true,
      });
      // A refusal has already been answered (429 or 402).
      if (result.allowed) next();
    } catch (error) {
      next(error);
    }
  };
}
