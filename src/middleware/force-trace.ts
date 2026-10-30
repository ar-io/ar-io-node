/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/** Request header asking for this request's trace to be kept. */
export const FORCE_TRACE_HEADER = 'x-ar-io-trace';
/** Response header carrying the trace ID, when one was forced. */
export const TRACE_ID_HEADER = 'X-AR-IO-Trace-Id';
/**
 * Span attribute the collector's `force-sample-policy` keeps every trace
 * for (otel/collector-config.yaml).
 */
export const FORCE_SAMPLE_ATTRIBUTE = 'ar_io.force_sample';

function bearerMatches(authorization: string | undefined, key: string) {
  const expected = Buffer.from(`Bearer ${key}`);
  const given = Buffer.from(authorization ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Lets an operator capture the trace of one request (#626): sent with
 * `X-AR-IO-Trace: 1` and the admin bearer key, the request's root span is
 * marked for the collector to keep regardless of sampling, and the response
 * carries `X-AR-IO-Trace-Id` to look it up by. The trace already records
 * each retrieval source tried, in order, with its outcome and timing. Gated
 * on the admin key, so a client cannot inflate trace volume or learn trace
 * IDs. Without the header, or the key, it does nothing.
 */
export function createForceTraceMiddleware({
  adminApiKey,
}: {
  adminApiKey: () => string | undefined;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = adminApiKey();
    if (
      req.headers[FORCE_TRACE_HEADER] !== undefined &&
      key !== undefined &&
      bearerMatches(req.headers.authorization, key)
    ) {
      const span = trace.getActiveSpan();
      if (span !== undefined) {
        span.setAttribute(FORCE_SAMPLE_ATTRIBUTE, true);
        res.setHeader(TRACE_ID_HEADER, span.spanContext().traceId);
      }
    }
    next();
  };
}
