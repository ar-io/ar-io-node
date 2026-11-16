/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

import { headerNames } from '../constants.js';

/**
 * The GraphQL fan-out hop count of the request being served: how many
 * gateways it has already passed through (`X-AR-IO-Hops`). Carried through
 * the async work of the request rather than as a parameter, so the four
 * GqlQueryable methods and every implementation stay as they are; only the
 * fan-out reads it.
 */
const hopsStore = new AsyncLocalStorage<number>();

/**
 * Parses an inbound hop count: a header that is wholly a non-negative safe
 * integer, else 0 (so `2garbage` is 0, not 2).
 */
export function parseGqlHops(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 0;
  const hops = Number(raw.trim());
  return Number.isSafeInteger(hops) ? hops : 0;
}

/** The hop count of the GraphQL request being served; 0 outside one. */
export function currentGqlHops(): number {
  return hopsStore.getStore() ?? 0;
}

/** Runs `fn` as part of a GraphQL request that arrived with `hops`. */
export function runWithGqlHops<T>(hops: number, fn: () => T): T {
  return hopsStore.run(hops, fn);
}

/**
 * Express middleware recording the inbound hop count for the rest of the
 * request, for {@link currentGqlHops}.
 */
export function recordGqlHops(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  runWithGqlHops(
    parseGqlHops(req.headers[headerNames.hops.toLowerCase()]),
    next,
  );
}
