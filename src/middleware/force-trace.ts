/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { context, SpanKind, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { FORCE_SAMPLE_ATTRIBUTE } from '../lib/force-sample.js';

export { FORCE_SAMPLE_ATTRIBUTE };

/** Request header asking for this request's trace to be kept. */
export const FORCE_TRACE_HEADER = 'x-ar-io-trace';
/** Response header carrying the trace ID, when one was forced. */
export const TRACE_ID_HEADER = 'X-AR-IO-Trace-Id';

function bearerMatches(authorization: string | undefined, key: string) {
  const expected = Buffer.from(`Bearer ${key}`);
  const given = Buffer.from(authorization ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Lets an operator capture the trace of one request (#626): sent with
 * `X-AR-IO-Trace: 1` and the admin bearer key, the request runs inside a new
 * root span created with {@link FORCE_SAMPLE_ATTRIBUTE}, which the head
 * sampler always samples and the collector always keeps, and the response
 * carries `X-AR-IO-Trace-Id` to look it up by. The handlers' spans start
 * under it, so the trace records each retrieval source tried, in order, with
 * its outcome and timing.
 *
 * The gateway has no HTTP instrumentation, so there is no request span to
 * mark: this middleware creates one. Gated on the admin key, so a client
 * cannot inflate trace volume or learn trace IDs. Without the header or the
 * key, or with tracing off (the span does not record), it does nothing.
 */
export function createForceTraceMiddleware({
  adminApiKey,
}: {
  adminApiKey: () => string | undefined;
}) {
  const tracer = trace.getTracer('ar-io-node-core');
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = adminApiKey();
    if (
      req.headers[FORCE_TRACE_HEADER] === undefined ||
      key === undefined ||
      !bearerMatches(req.headers.authorization, key)
    ) {
      next();
      return;
    }
    const span = tracer.startSpan(`${req.method} forced trace`, {
      kind: SpanKind.SERVER,
      attributes: {
        [FORCE_SAMPLE_ATTRIBUTE]: true,
        'http.method': req.method,
        'http.target': req.originalUrl,
      },
    });
    if (!span.isRecording()) {
      span.end();
      next();
      return;
    }
    res.setHeader(TRACE_ID_HEADER, span.spanContext().traceId);
    res.once('close', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    context.with(trace.setSpan(context.active(), span), next);
  };
}
