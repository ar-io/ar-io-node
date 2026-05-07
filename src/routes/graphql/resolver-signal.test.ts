/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it, beforeEach } from 'node:test';
import type { Request, Response } from 'express';

import * as metrics from '../../metrics.js';
import { buildResolverSignal, ResolverSignalState } from './resolver-signal.js';

/**
 * Minimal req/res stand-ins. We only need EventEmitter for `once`/`emit`
 * plus a couple of boolean flags that buildResolverSignal reads.
 */
class FakeReq extends EventEmitter {
  aborted = false;
  destroyed = false;
}
class FakeRes extends EventEmitter {
  writableEnded = false;
  finished = false;
  headersSent = false;
  statusCode = 200;
  finish() {
    this.writableEnded = true;
    this.finished = true;
    this.emit('finish');
  }
}

const newCtx = (): ResolverSignalState => ({ responseSent: false });

const cancelCount = async (
  reason: 'client_disconnect' | 'deadline_exceeded',
): Promise<number> => {
  const out = await metrics.graphqlResolverCancellationsCounter.get();
  const sample = out.values.find((v) => v.labels.reason === reason);
  return sample?.value ?? 0;
};

describe('buildResolverSignal', () => {
  beforeEach(() => {
    metrics.graphqlResolverCancellationsCounter.reset();
  });

  it('does NOT count when ctx.responseSent is set (Apollo plugin path)', async () => {
    // Authoritative success signal: the responseSentPlugin sets
    // ctx.responseSent = true during willSendResponse, BEFORE the
    // socket is written to. Close events that fire afterward must
    // NOT be treated as aborts.
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const ctx = newCtx();
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res, ctx);

    // Apollo plugin sets the flag, then Apollo writes the response,
    // then close eventually fires.
    ctx.responseSent = true;
    (res as unknown as FakeRes).emit('close');
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('does NOT count when writableEnded is true even if ctx.responseSent missed (defense-in-depth)', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const ctx = newCtx();
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res, ctx);

    // Plugin didn't fire (hypothetical), but Node-level writableEnded
    // is set as fallback.
    (res as unknown as FakeRes).writableEnded = true;
    (res as unknown as FakeRes).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('counts a cancellation when res close fires before any "response sent" signal', async () => {
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const ctx = newCtx();
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res, ctx);

    // Client disconnect: state.responseSent stays false, writableEnded
    // stays false, res 'close' fires.
    (res as unknown as FakeRes).emit('close');

    assert.equal(signal.aborted, true);
    assert.equal(await cancelCount('client_disconnect'), before + 1);
  });

  it('IGNORES req close — fires for normal completions in apollo-server-express', async () => {
    // Regression coverage for the production bug where listening on
    // `req.on('close')` caused every request to be classified as an
    // abort, because Node fires `req.on('close')` at request-parser
    // -end time — well before Apollo gets to send the response.
    const req = new FakeReq() as unknown as Request;
    const res = new FakeRes() as unknown as Response;
    const ctx = newCtx();
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res, ctx);

    // Emitting close on req must NOT trigger the abort path.
    (req as unknown as FakeReq).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });

  it('IGNORES req.destroyed at call time — body-parser sets it on every request', async () => {
    // Regression coverage for the production bug where the
    // synchronous pre-check `req.destroyed === true` fired for every
    // successful request (body-parser consumes the request body before
    // Apollo invokes the context callback, and consuming a Readable
    // stream sets destroyed=true). The pre-check has been removed; if
    // a real abort occurs, the res.on('close') listener catches it
    // later.
    const req = new FakeReq() as unknown as Request;
    (req as unknown as FakeReq).destroyed = true; // normal post-body-parse state
    const res = new FakeRes() as unknown as Response;
    const ctx = newCtx();
    const before = await cancelCount('client_disconnect');

    const signal = buildResolverSignal(req, res, ctx);

    // Apollo proceeds normally; plugin marks responseSent; close fires.
    ctx.responseSent = true;
    (res as unknown as FakeRes).emit('close');

    assert.equal(signal.aborted, false);
    assert.equal(await cancelCount('client_disconnect'), before);
  });
});
