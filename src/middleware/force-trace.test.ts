/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import {
  createForceTraceMiddleware,
  FORCE_SAMPLE_ATTRIBUTE,
} from './force-trace.js';

describe('force-trace middleware (#626)', () => {
  const exporter = new InMemorySpanExporter();
  let app: express.Express;

  before(() => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = provider.getTracer('test');
    app = express();
    // Stands in for the HTTP instrumentation's server span.
    app.use((_req, res, next) =>
      tracer.startActiveSpan('GET /', (span) => {
        res.on('finish', () => span.end());
        next();
      }),
    );
    app.use(createForceTraceMiddleware({ adminApiKey: () => 'secret' }));
    app.get('/', (_req, res) => {
      res.send('ok');
    });
  });

  beforeEach(() => exporter.reset());

  const finished = () => exporter.getFinishedSpans();

  it('marks the trace and returns its ID for the admin', async () => {
    const res = await request(app)
      .get('/')
      .set('X-AR-IO-Trace', '1')
      .set('Authorization', 'Bearer secret')
      .expect(200);
    const [span] = finished();
    assert.equal(span.attributes[FORCE_SAMPLE_ATTRIBUTE], true);
    assert.equal(res.headers['x-ar-io-trace-id'], span.spanContext().traceId);
  });

  for (const [label, auth] of [
    ['without the key', undefined],
    ['with a wrong key', 'Bearer wrong'],
    ['with a key of another length', 'Bearer secret2'],
  ] as const) {
    it(`does nothing ${label}`, async () => {
      const req = request(app).get('/').set('X-AR-IO-Trace', '1');
      if (auth !== undefined) req.set('Authorization', auth);
      const res = await req.expect(200);
      assert.equal(res.headers['x-ar-io-trace-id'], undefined);
      assert.equal(finished()[0].attributes[FORCE_SAMPLE_ATTRIBUTE], undefined);
    });
  }

  it('does nothing without the header, even for the admin', async () => {
    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer secret')
      .expect(200);
    assert.equal(res.headers['x-ar-io-trace-id'], undefined);
  });
});
