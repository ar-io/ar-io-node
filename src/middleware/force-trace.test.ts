/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';
import express from 'express';
import request from 'supertest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import { createGatewaySampler } from '../lib/force-sample.js';
import {
  createForceTraceMiddleware,
  FORCE_SAMPLE_ATTRIBUTE,
} from './force-trace.js';

describe('force-trace middleware (#626)', () => {
  const exporter = new InMemorySpanExporter();
  let app: express.Express;

  before(() => {
    // As in production: no HTTP instrumentation, so nothing creates a request
    // span before this middleware, and head sampling keeps (almost) nothing.
    const provider = new NodeTracerProvider({
      sampler: createGatewaySampler(1e12),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    app = express();
    app.use(createForceTraceMiddleware({ adminApiKey: () => 'secret' }));
    // Stands in for a data handler: starts its span under whatever is active.
    app.get('/', async (_req, res) => {
      const span = trace.getTracer('handler').startSpan('DataHandler.handle');
      await new Promise((resolve) => setImmediate(resolve));
      span.end();
      res.send('ok');
    });
  });

  beforeEach(() => exporter.reset());

  const finished = async () => {
    // The root span ends on the response's 'close', just after supertest
    // has the response.
    await new Promise((resolve) => setImmediate(resolve));
    return exporter.getFinishedSpans();
  };

  it('keeps the request, with the handler span under it, despite sampling', async () => {
    const res = await request(app)
      .get('/')
      .set('X-AR-IO-Trace', '1')
      .set('Authorization', 'Bearer secret')
      .expect(200);
    const spans = await finished();
    const root = spans.find(
      (s) => s.attributes[FORCE_SAMPLE_ATTRIBUTE] === true,
    );
    const child = spans.find((s) => s.name === 'DataHandler.handle');
    assert.ok(root, 'the forced root span is exported');
    assert.ok(child, 'the handler span is exported too');
    assert.equal(res.headers['x-ar-io-trace-id'], root.spanContext().traceId);
    assert.equal(child.spanContext().traceId, root.spanContext().traceId);
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(root.attributes['http.status_code'], 200);
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
      // Sampled as any request: at this rate, not at all.
      assert.deepEqual(await finished(), []);
    });
  }

  it('does nothing without the header, even for the admin', async () => {
    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer secret')
      .expect(200);
    assert.equal(res.headers['x-ar-io-trace-id'], undefined);
    assert.deepEqual(await finished(), []);
  });
});
